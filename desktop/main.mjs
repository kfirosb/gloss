// Native desktop shell (macOS, Linux): runs the local server on Electron's bundled Node and shows the UI in an app window.
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import { createBadgeController } from './attention-badge.mjs';
import { createAlertHandler } from './attention-alert.mjs';
import { createRevealHandler } from './reveal-path.mjs';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = () => join(app.getPath('userData'), 'desktop.json');
let server;
let serverCapability;
let panelUrl;
let mainWindow;
let quitting = false;

function readConfig() {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}
function writeConfig(config) {
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

const isMac = process.platform === 'darwin';
// Apps opened from Finder or a desktop launcher get a minimal PATH; the server needs `claude` and `codex` from the user's shell.
function loginShellPath() {
  try {
    return execFileSync(
      process.env.SHELL || (isMac ? '/bin/zsh' : '/bin/bash'),
      ['-lic', 'printf "__PATH__%s" "$PATH"'],
      {
        encoding: 'utf8',
        timeout: 5000,
      },
    )
      .split('__PATH__')
      .pop()
      .trim();
  } catch {
    return [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin')]
      .filter(Boolean)
      .join(':');
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startServer(port, capability, path) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(appRoot, 'dist/server/runtime/cli.js'), '--port', String(port), '--project', homedir()],
      {
        // process.resourcesPath may be unset in the ELECTRON_RUN_AS_NODE child, so the bundled tmux and whisper-server paths travel explicitly.
        cwd: appRoot,
        env: {
          ...process.env,
          PATH: path,
          ELECTRON_RUN_AS_NODE: '1',
          LANGUAGE_PANEL_CAPABILITY: capability,
          ...(app.isPackaged
            ? {
                LANGUAGE_ASSISTANT_TMUX: join(process.resourcesPath, 'bin', 'tmux'),
                LANGUAGE_ASSISTANT_WHISPER: join(process.resourcesPath, 'bin', 'whisper-server'),
              }
            : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let buffered = '';
    let errors = '';
    child.stdout.on('data', (chunk) => {
      if (panelUrl) return;
      buffered += chunk;
      const line = buffered.split('\n').find((value) => value.startsWith('http://'));
      if (line) {
        panelUrl = line.trim();
        resolve(child);
      }
    });
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    child.once('exit', (code) => {
      if (!panelUrl) reject(new Error(errors.trim() || `Server exited (${code})`));
      else if (!quitting) app.quit();
    });
  });
}

async function boot() {
  const config = readConfig();
  config.capability ??= randomUUID();
  config.port ??= await freePort();
  writeConfig(config);
  serverCapability = config.capability;
  const path = loginShellPath();
  // Keep the same port so browser-side recovery for this origin survives restarts; move only if it is taken.
  try {
    server = await startServer(config.port, config.capability, path);
  } catch {
    config.port = await freePort();
    writeConfig(config);
    server = await startServer(config.port, config.capability, path);
  }
}

function createWindow() {
  const { bounds } = readConfig();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    ...bounds,
    title: 'Gloss',
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: join(appRoot, 'desktop/preload.cjs'),
    },
  });
  const origin = new URL(panelUrl).origin;
  // Only the app's own page may use the microphone, and only for audio; other media requests are refused.
  const allowed = (details) =>
    new URL(details.requestingUrl ?? 'about:blank').origin === origin &&
    details.mediaTypes?.length === 1 &&
    details.mediaTypes[0] === 'audio';
  // Non-media permissions (e.g. clipboard-sanitized-write for the copy button) keep Electron's default, which is allow.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) =>
    callback(permission === 'media' ? allowed(details) : true),
  );
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) =>
      permission === 'media'
        ? requestingOrigin === origin &&
          (details.mediaType === 'audio' || details.mediaType === undefined)
        : true,
  );
  // IPC is accepted only from the app's own page in the main window.
  const fromMainWindow = (event) =>
    !!mainWindow &&
    event.sender === mainWindow.webContents &&
    new URL(event.senderFrame?.url ?? 'about:blank').origin === origin;
  ipcMain.removeHandler('pick-folder');
  // Only the app's own page may open the picker; the result is validated again by the server.
  ipcMain.handle('pick-folder', async (event) => {
    if (!fromMainWindow(event)) return null;
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  const badge = createBadgeController({
    // The Dock on macOS; the launcher/taskbar count elsewhere (shown where the desktop supports it).
    setBadge: (text) => (isMac ? app.dock?.setBadge(text) : app.setBadgeCount(Number(text) || 0)),
    isFocused: () => !!mainWindow && mainWindow.isFocused(),
  });
  ipcMain.removeAllListeners('attention-count');
  // Only the app's own page may set the badge; the count is validated by the controller.
  ipcMain.on('attention-count', (event, count) => {
    if (fromMainWindow(event)) badge.setCount(count);
  });
  const alerts = createAlertHandler({
    playSound: (path) => {
      const player = isMac
        ? '/usr/bin/afplay'
        : ['/usr/bin/paplay', '/usr/bin/pw-play'].find((p) => existsSync(p));
      // Best effort: a desktop without a sound server simply stays silent.
      if (player) execFile(player, [path], () => {});
    },
    bounce: () => (isMac ? app.dock?.bounce('informational') : mainWindow?.flashFrame(true)),
    isFocused: () => !!mainWindow && mainWindow.isFocused(),
  });
  ipcMain.removeAllListeners('attention-alert');
  ipcMain.on('attention-alert', (event, payload) => {
    if (fromMainWindow(event)) alerts.handle(payload);
  });
  // The server resolves the page's relative path inside the session folder; see reveal-path.mjs for the boundary.
  const reveal = createRevealHandler({
    locate: async (sessionId, relativePath) => {
      const response = await fetch(
        `${origin}/api/sessions/${encodeURIComponent(sessionId)}/files/locate?path=${encodeURIComponent(relativePath)}`,
        { headers: { authorization: 'Bearer ' + serverCapability } },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? 'File unavailable');
      return body;
    },
    showItemInFolder: (path) => shell.showItemInFolder(path),
    openPath: (path) => shell.openPath(path),
    isDirectory: (path) => {
      try {
        return lstatSync(path).isDirectory();
      } catch {
        return false;
      }
    },
  });
  ipcMain.removeHandler('reveal-path');
  ipcMain.handle('reveal-path', (event, payload) =>
    fromMainWindow(event) ? reveal.handle(payload) : { error: 'Not allowed' },
  );
  mainWindow.on('focus', () => badge.refresh());
  mainWindow.on('blur', () => badge.refresh());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) {
      event.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', () => writeConfig({ ...readConfig(), bounds: mainWindow.getBounds() }));
  mainWindow.on('closed', () => {
    badge.clear();
    mainWindow = undefined;
  });
  void mainWindow.loadURL(panelUrl);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.setName('Gloss');
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on('activate', () => {
    if (!mainWindow && panelUrl) createWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    quitting = true;
    server?.kill();
  });
  app
    .whenReady()
    .then(boot)
    .then(createWindow)
    .catch(async (error) => {
      dialog.showErrorBox(
        'Gloss could not start',
        error instanceof Error ? error.message : String(error),
      );
      app.quit();
    });
}
