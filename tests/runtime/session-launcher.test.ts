import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CODEX_SETUP_PROMPT,
  createSessionLauncher,
  defaultShell,
  nextTerminalTitle,
  validateCommand,
  type LaunchRecord,
  type SessionLauncher,
} from '../../src/runtime/session-launcher.js';
import { splitArgs, type LaunchSettings } from '../../src/core/launch-settings.js';
import type { Tmux } from '../../src/runtime/tmux.js';
import type { Target } from '../../src/core/contracts.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import {
  CLAUDE_SETUP_PROMPT,
  createClaudeChannelSetup,
} from '../../src/runtime/claude-channel-setup.js';

const dirs: string[] = [];
const launchers: SessionLauncher[] = [];
afterEach(async () => {
  for (const l of launchers.splice(0)) l.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const screen = (name: string) =>
  readFileSync(join(import.meta.dirname, '../fixtures/screens', name), 'utf8');
const IDLE = screen('claude-2.1.296-idle.txt');
const PERMISSION = screen('claude-2.1.296-permission.txt');
function fakeTmux() {
  const live = new Map<
    string,
    {
      cwd: string;
      argv: string[];
      panePid: number;
      env?: Record<string, string>;
      currentCommand: string;
    }
  >();
  const keys: [string, string[]][] = [];
  const typed: [string, string][] = [];
  let pid = 1000;
  const view = { screen: IDLE };
  const captures = { count: 0 };
  const tmux: Tmux = {
    executable: '/t',
    socket: '/s',
    async newSession(name, cwd, argv, env) {
      const panePid = ++pid;
      live.set(name, { cwd, argv, panePid, currentCommand: 'zsh', ...(env ? { env } : {}) });
      return { panePid };
    },
    async listSessions() {
      return [...live].map(([name, s]) => ({
        name,
        panePid: s.panePid,
        currentCommand: s.currentCommand,
      }));
    },
    async typeText(n, text) {
      typed.push([n, text]);
    },
    async hasSession(n) {
      return live.has(n);
    },
    async capturePane() {
      captures.count++;
      return view.screen;
    },
    async sendKeys(n, k) {
      keys.push([n, k]);
      if (k.includes('C-c')) live.delete(n);
    },
    async resizeWindow() {},
    async capturePaneStyled() {
      return view.screen;
    },
    async paneCursor() {
      return { x: 0, y: 0, inMode: false };
    },
    async loadBuffer() {},
    async pasteBuffer() {},
    async deleteBuffer() {},
    async scroll() {},
    async exitCopyMode() {},
    async captureRows() {
      return '';
    },
    async pressStash() {},
    async killSession(n) {
      live.delete(n);
    },
    attachArgv: (n) => ['/t', 'attach', n],
  };
  return { tmux, live, keys, typed, view, captures };
}
function memoryStore(settings?: Partial<LaunchSettings>) {
  const launches = new Map<string, LaunchRecord>();
  let s: LaunchSettings = {
    extraArgs: { claude: [], codex: [] },
    popup: 'auto',
    terminalView: 'popup',
    ...settings,
  };
  return {
    launches,
    listLaunches: () => structuredClone([...launches.values()]),
    putLaunch: (r: LaunchRecord) => {
      launches.set(r.id, structuredClone(r));
    },
    deleteLaunch: (id: string) => {
      launches.delete(id);
    },
    readLaunchSettings: () => s,
    writeLaunchSettings: (n: LaunchSettings) => {
      s = n;
    },
  };
}
async function setup(
  overrides: {
    settings?: Partial<LaunchSettings>;
    findCodex?: (pid: number, signal: AbortSignal) => Promise<Target | undefined>;
    register?: (...args: any[]) => Promise<any>;
    applyLanguage?: (...args: any[]) => void | Promise<void>;
    timeout?: number;
    retryDelaysMs?: number[];
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'la-launch-')));
  dirs.push(folder);
  const t = fakeTmux();
  const store = memoryStore(overrides.settings);
  const register = vi.fn(
    overrides.register ??
      (async (target: Target) => ({ id: 'panel-' + target.sessionRef, target })),
  );
  const options = {
    tmux: async () => t.tmux,
    store,
    shell: '/bin/zsh',
    sessions: { register } as any,
    claudeExecutable: async () => '/bin/claude',
    findCodex: overrides.findCodex
      ? (launch: LaunchRecord, signal: AbortSignal) => overrides.findCodex!(launch.panePid, signal)
      : async () => ({ agent: 'codex' as const, sessionRef: 'codex-1', projectId: folder }),
    resolveExecutable: async () => '/bin/codex',
    knownFolder: async (f: string) => f === folder,
    sleep: overrides.sleep ?? (async () => {}),
    identifyTimeoutMs: overrides.timeout ?? 20,
    now: () => 1,
    watchIntervalMs: 3000,
    ...(overrides.retryDelaysMs ? { retryDelaysMs: overrides.retryDelaysMs } : {}),
    ...(overrides.applyLanguage ? { applyLanguage: overrides.applyLanguage } : {}),
  };
  const launcher = createSessionLauncher(options);
  launchers.push(launcher);
  return { launcher, folder, t, store, register, options };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

it('splits quotes and empty arguments without evaluating shell expressions', () => {
  expect(splitArgs('--model "opus 5" --flag=\'a b\' $HOME `x` *.txt ""')).toEqual([
    '--model',
    'opus 5',
    '--flag=a b',
    '$HOME',
    '`x`',
    '*.txt',
    '',
  ]);
  expect(() => splitArgs('"unfinished')).toThrow('Unclosed quote');
});
it('launches Claude with a preassigned identity and immediate panel registration', async () => {
  const { launcher, folder, t, register } = await setup({
    settings: { extraArgs: { claude: ['--model', 'opus 5'], codex: [] } },
  });
  const record = await launcher.launch({ agent: 'claude', folder });
  const [name, session] = [...t.live][0]!;
  expect(name).toBe('la-' + record.id);
  expect(session!.cwd).toBe(folder);
  expect(session!.argv).toEqual([
    '/bin/claude',
    '--session-id',
    record.sessionRef,
    '--model',
    'opus 5',
    '--',
    CLAUDE_SETUP_PROMPT,
  ]);
  expect(session!.env).toEqual({ ELECTRON_RUN_AS_NODE: '' });
  expect(register.mock.calls[0]![0]).toEqual({
    agent: 'claude',
    sessionRef: record.sessionRef,
    projectId: folder,
  });
  // Running once the panel is registered; the catalog shows Starting only for launches without a panel.
  expect(record).toMatchObject({
    state: 'running',
    panelSessionId: 'panel-' + record.sessionRef,
    createdAt: 1,
  });
});
it('identifies Codex by pane ancestry and persists the registered target', async () => {
  const { launcher, folder, t } = await setup();
  const record = await launcher.launch({ agent: 'codex', folder });
  // The disclosed setup prompt is passed so Codex creates its thread at once.
  expect([...t.live.values()][0]!.argv).toEqual(['/bin/codex', '--', CODEX_SETUP_PROMPT]);
  await vi.waitFor(() =>
    expect(launcher.list()[0]).toMatchObject({
      id: record.id,
      state: 'running',
      sessionRef: 'codex-1',
      panelSessionId: 'panel-codex-1',
    }),
  );
});
it('puts the Codex setup prompt after `--` so a value-taking extra option cannot swallow it', async () => {
  const { launcher, folder, t } = await setup({
    settings: { extraArgs: { claude: [], codex: ['-m', 'gpt 5', '--add-dir'] } },
  });
  await launcher.launch({ agent: 'codex', folder });
  expect([...t.live.values()][0]!.argv).toEqual([
    '/bin/codex',
    '-m',
    'gpt 5',
    '--add-dir',
    '--',
    CODEX_SETUP_PROMPT,
  ]);
  expect(CODEX_SETUP_PROMPT).toBe('Reply with READY only. Do not run commands.');
});
it('times out with a constant clock and an immediate sleep', async () => {
  const { launcher, folder } = await setup({ findCodex: async () => undefined });
  await launcher.launch({ agent: 'codex', folder });
  await vi.waitFor(() =>
    expect(launcher.list()[0]).toMatchObject({
      state: 'unidentified',
      reason: 'Started, not connected',
    }),
  );
});
it('bounds identification even when discovery never resolves', async () => {
  const pending = deferred<Target | undefined>();
  let signal!: AbortSignal;
  const { launcher, folder } = await setup({
    findCodex: async (_pid, s) => {
      signal = s;
      return pending.promise;
    },
  });
  await launcher.launch({ agent: 'codex', folder });
  await vi.waitFor(() => expect(launcher.list()[0]!.state).toBe('unidentified'));
  expect(signal.aborted).toBe(true);
});
it('validates agent and canonical registered directory before launching', async () => {
  const { launcher, folder, t } = await setup();
  await expect(launcher.launch({ agent: 'claude', folder: '/etc' })).rejects.toThrow(
    'Choose a project folder',
  );
  await expect(launcher.launch({ agent: 'claude', folder: 'relative/path' })).rejects.toThrow(
    'Choose a project folder',
  );
  const file = join(folder, 'file');
  await writeFile(file, 'x');
  await expect(launcher.launch({ agent: 'claude', folder: file })).rejects.toThrow(
    'Choose a project folder',
  );
  await expect(launcher.launch({ agent: 'bash' as any, folder })).rejects.toThrow(
    'Unsupported agent',
  );
  expect(t.live.size).toBe(0);
});
it('reconciles only missing sessions and emits their end transition once', async () => {
  const { launcher, folder, t } = await setup();
  const a = await launcher.launch({ agent: 'claude', folder });
  const b = await launcher.launch({ agent: 'claude', folder });
  const updates: LaunchRecord[][] = [];
  launcher.subscribe((r) => updates.push(r));
  t.live.delete('la-' + b.id);
  await launcher.reconcile();
  await launcher.reconcile();
  expect(launcher.list().find((r) => r.id === a.id)!.state).toBe('running');
  expect(launcher.list().find((r) => r.id === b.id)).toMatchObject({
    state: 'ended',
    reason: 'Session is no longer running',
  });
  expect(updates).toHaveLength(1);
});
it('preserves saved records when listing tmux fails transiently', async () => {
  const { launcher, folder, t } = await setup();
  await launcher.launch({ agent: 'claude', folder });
  t.tmux.listSessions = async () => {
    throw new Error('timeout');
  };
  await launcher.reconcile();
  expect(launcher.list()[0]!.state).toBe('running');
});
it('marks all saved launches ended when the private server is absent', async () => {
  const { launcher, folder, t } = await setup();
  await launcher.launch({ agent: 'claude', folder });
  await launcher.launch({ agent: 'codex', folder });
  t.live.clear();
  await launcher.reconcile();
  await tick();
  expect(launcher.list().every((r) => r.state === 'ended')).toBe(true);
});
it('ends Claude with Ctrl+C twice and kills a session that survives', async () => {
  const { launcher, folder, t } = await setup();
  const a = await launcher.launch({ agent: 'claude', folder });
  await launcher.end(a.id);
  expect(t.keys).toEqual([
    ['la-' + a.id, ['C-c']],
    ['la-' + a.id, ['C-c']],
  ]);
  const b = await launcher.launch({ agent: 'claude', folder });
  t.keys.length = 0;
  t.tmux.sendKeys = async (n, k) => {
    t.keys.push([n, k]);
  };
  const kill = vi.spyOn(t.tmux, 'killSession');
  await launcher.end(b.id);
  expect(kill).toHaveBeenCalledWith('la-' + b.id);
  expect(t.live.size).toBe(0);
  expect(launcher.list().every((r) => r.state === 'ended')).toBe(true);
  expect(t.keys.flatMap(([, k]) => k)).toEqual(['C-c', 'C-c']);
});
it('does not revive an ended launch when delayed discovery resolves', async () => {
  const pending = deferred<Target | undefined>();
  const { launcher, folder } = await setup({ findCodex: () => pending.promise });
  const record = await launcher.launch({ agent: 'codex', folder });
  await launcher.end(record.id);
  pending.resolve({ agent: 'codex', sessionRef: 'late', projectId: folder });
  await tick();
  expect(launcher.list()[0]).toMatchObject({ state: 'ended', reason: 'Ended by you' });
  expect(launcher.list()[0]!.sessionRef).toBeUndefined();
});
it('does not revive a reconciled missing launch after registration completes', async () => {
  const pending = deferred<any>();
  const { launcher, folder, t, register } = await setup({ register: () => pending.promise });
  const record = await launcher.launch({ agent: 'codex', folder });
  await vi.waitFor(() => expect(register).toHaveBeenCalled());
  t.live.delete('la-' + record.id);
  await launcher.reconcile();
  pending.resolve({ id: 'late-panel' });
  await tick();
  expect(launcher.list()[0]!.state).toBe('ended');
  expect(launcher.list()[0]!.panelSessionId).toBeUndefined();
});
it('close aborts pending identification without ending the background process', async () => {
  const pending = deferred<Target | undefined>();
  let signal!: AbortSignal;
  const { launcher, folder, t } = await setup({
    findCodex: (_p, s) => {
      signal = s;
      return pending.promise;
    },
  });
  await launcher.launch({ agent: 'codex', folder });
  launcher.close();
  pending.resolve({ agent: 'codex', sessionRef: 'late', projectId: folder });
  await tick();
  expect(signal.aborted).toBe(true);
  expect(t.live.size).toBe(1);
  expect(launcher.list()[0]!.state).toBe('starting');
  await expect(launcher.launch({ agent: 'claude', folder })).rejects.toThrow('closed');
});
it('retries unidentified sessions and restores saved starting sessions on reconcile', async () => {
  let discovered = false;
  const { launcher, folder, store, options } = await setup({
    findCodex: async () =>
      discovered ? { agent: 'codex', sessionRef: 'restored', projectId: folder } : undefined,
  });
  await launcher.launch({ agent: 'codex', folder });
  await vi.waitFor(() => expect(launcher.list()[0]!.state).toBe('unidentified'));
  discovered = true;
  launcher.close();
  const restored = createSessionLauncher(options);
  launchers.push(restored);
  await restored.reconcile();
  await vi.waitFor(() =>
    expect(restored.list()[0]).toMatchObject({ state: 'running', sessionRef: 'restored' }),
  );
  expect(store.listLaunches()).toHaveLength(1);
});
it('persists language choices until Codex registers, then applies them', async () => {
  const pending = deferred<Target | undefined>();
  const applied: unknown[] = [];
  const { launcher, folder } = await setup({
    findCodex: () => pending.promise,
    applyLanguage: (id, override) => {
      applied.push([id, override]);
    },
  });
  await launcher.launch({ agent: 'codex', folder, languageOverride: { write: 'en', reply: 'he' } });
  expect(launcher.list()[0]!.languageOverride).toEqual({ write: 'en', reply: 'he' });
  pending.resolve({ agent: 'codex', sessionRef: 'lang', projectId: folder });
  await vi.waitFor(() => expect(launcher.list()[0]!.state).toBe('running'));
  expect(applied).toEqual([['panel-lang', { write: 'en', reply: 'he' }]]);
});
it('rejects invalid language settings before starting and retries failed application', async () => {
  let failed = true;
  const applied: unknown[] = [];
  const { launcher, folder, t } = await setup({
    applyLanguage: (id, override) => {
      if (failed) throw new Error('write failed');
      applied.push([id, override]);
    },
  });
  await expect(
    launcher.launch({ agent: 'codex', folder, languageOverride: { reply: 'fr' } }),
  ).rejects.toThrow('Invalid language');
  expect(t.live.size).toBe(0);
  await launcher.launch({ agent: 'codex', folder, languageOverride: { reply: 'en' } });
  await vi.waitFor(() =>
    expect(launcher.list()[0]).toMatchObject({
      state: 'unidentified',
      reason: 'Started, language settings not applied',
    }),
  );
  failed = false;
  await launcher.reconcile();
  await vi.waitFor(() => expect(launcher.list()[0]!.state).toBe('running'));
  expect(applied).toEqual([['panel-codex-1', { reply: 'en' }]]);
});
it('round-trips launches in stable insertion order and validates settings', () => {
  const store = new SqliteStore(':memory:');
  try {
    const a: LaunchRecord = {
      id: 'a',
      agent: 'claude',
      folder: '/project',
      panePid: 12,
      state: 'starting',
      createdAt: 1,
    };
    const b: LaunchRecord = {
      ...a,
      id: 'b',
      agent: 'codex',
      panePid: 13,
      languageOverride: { reply: 'en' },
    };
    const shell: LaunchRecord = {
      id: 's',
      agent: 'shell',
      folder: '/project',
      panePid: 14,
      state: 'running',
      createdAt: 2,
      title: 'Terminal 2',
      originSessionId: 'panel-1',
    };
    store.putLaunch(a);
    store.putLaunch(b);
    store.putLaunch({ ...a, state: 'ended' });
    store.putLaunch(shell);
    expect(store.listLaunches()).toEqual([{ ...a, state: 'ended' }, b, shell]);
    store.deleteLaunch('s');
    store.deleteLaunch('missing');
    expect(store.listLaunches().map((r) => r.id)).toEqual(['a', 'b']);
    expect(store.readLaunchSettings()).toEqual({
      extraArgs: { claude: [], codex: [] },
      popup: 'auto',
      terminalView: 'popup',
    });
    const settings: LaunchSettings = {
      extraArgs: { claude: ['--model', 'opus 5'], codex: ['$HOME'] },
      popup: 'dot-only',
      terminalView: 'workspace',
    };
    store.writeLaunchSettings(settings);
    expect(store.readLaunchSettings()).toEqual(settings);
    for (const bad of [
      { ...settings, popup: 'always' },
      { ...settings, terminalView: 'tab' },
      { ...settings, extraArgs: { claude: [], codex: Array(33).fill('x') } },
      { ...settings, extraArgs: { claude: ['x'.repeat(513)], codex: [] } },
      { ...settings, extraArgs: { claude: [1], codex: [] } },
    ])
      expect(() => store.writeLaunchSettings(bad as any)).toThrow('Invalid launch settings');
    expect(store.readLaunchSettings()).toEqual(settings);
  } finally {
    store.close();
  }
});
it('reads launch settings saved before terminalView existed with the popup default', () => {
  const store = new SqliteStore(':memory:');
  try {
    (store as any).database
      .prepare("INSERT OR REPLACE INTO app_settings(key,value_json) VALUES ('launch.settings',?)")
      .run(
        JSON.stringify({
          extraArgs: { claude: ['--model', 'opus'], codex: [] },
          popup: 'dot-only',
        }),
      );
    expect(store.readLaunchSettings()).toEqual({
      extraArgs: { claude: ['--model', 'opus'], codex: [] },
      popup: 'dot-only',
      terminalView: 'popup',
    });
  } finally {
    store.close();
  }
});
it('prepares distinct private MCP files for concurrent new sessions and never marks an existing session connecting', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'la-preflight-')));
  dirs.push(root);
  const project = join(root, 'project');
  await mkdir(project);
  const cliPath = join(root, 'cli.js');
  await writeFile(cliPath, '// fixture');
  const setup = createClaudeChannelSetup({
    homeDir: root,
    // Pinned so the developer's CLAUDE_CONFIG_DIR is never read.
    configDir: join(root, '.claude'),
    stateDir: join(root, 'state'),
    cliPath,
    claudePath: '/bin/echo',
    platform: 'darwin',
    managedDir: join(root, 'managed'),
    systemLibraryDir: join(root, 'library'),
    registry: { resolveChannel: async () => undefined },
    runner: async function* () {
      yield { type: 'line', line: '2.1.293' };
      yield { type: 'exit', outcome: { code: 0, signal: null, reason: 'exited', diagnostics: '' } };
    },
  });
  const [a, b] = await Promise.all([
    setup.prepareNewSessionConfig(project),
    setup.prepareNewSessionConfig(project),
  ]);
  expect(a.claude).toBe('/bin/echo');
  expect(a.mcpConfigPath).not.toBe(b.mcpConfigPath);
  expect(
    JSON.parse(await readFile(a.mcpConfigPath, 'utf8')).mcpServers['language-assistant'].args,
  ).toEqual([cliPath, '--claude-channel']);
  const target = {
    agent: 'claude' as const,
    sessionRef: '11111111-1111-4111-8111-111111111111',
    projectId: project,
  };
  expect((await setup.status(target)).state).toBe('setup-required');
});
it('retains a live launch if graceful exit and forced kill fail, then permits a retry', async () => {
  const { launcher, folder, t } = await setup();
  const record = await launcher.launch({ agent: 'claude', folder });
  t.tmux.sendKeys = async () => {};
  const kill = t.tmux.killSession;
  t.tmux.killSession = async () => {
    throw new Error('tmux unavailable');
  };
  await expect(launcher.end(record.id)).rejects.toThrow('tmux unavailable');
  expect(launcher.list()[0]!.state).toBe('running');
  expect(t.live.size).toBe(1);
  t.tmux.killSession = kill;
  await launcher.end(record.id);
  expect(launcher.list()[0]!.state).toBe('ended');
});
it('does not claim ended until tmux confirms the session disappeared', async () => {
  const { launcher, folder, t } = await setup();
  const record = await launcher.launch({ agent: 'claude', folder });
  t.tmux.sendKeys = async () => {};
  t.tmux.killSession = async () => {};
  await expect(launcher.end(record.id)).rejects.toThrow('Session is still running');
  expect(launcher.list()[0]!.state).toBe('running');
});
it('never sends Enter or text and never reads the screen when ending Claude, whatever the screen shows', async () => {
  for (const shown of [PERMISSION, IDLE, '\n\n']) {
    const { launcher, folder, t } = await setup();
    const record = await launcher.launch({ agent: 'claude', folder });
    t.view.screen = shown;
    t.captures.count = 0;
    t.tmux.sendKeys = async (n, k) => {
      t.keys.push([n, k]);
    };
    await launcher.end(record.id);
    expect(t.keys.map(([, k]) => k)).toEqual([['C-c'], ['C-c']]);
    expect(t.keys.flatMap(([, k]) => k)).not.toEqual(expect.arrayContaining(['Enter']));
    expect(t.captures.count).toBe(0);
    expect(launcher.list()[0]).toMatchObject({ state: 'ended', reason: 'Ended by you' });
  }
});
it('ends Codex with Ctrl+C only', async () => {
  const { launcher, folder, t } = await setup();
  const record = await launcher.launch({ agent: 'codex', folder });
  await launcher.end(record.id);
  expect(t.keys.flatMap(([, k]) => k)).toEqual(['C-c', 'C-c']);
});
it('watches tmux so a session that exits on its own is ended, and stops watching on close', async () => {
  const { launcher, folder, t } = await setup();
  const record = await launcher.launch({ agent: 'claude', folder });
  vi.useFakeTimers();
  try {
    const list = vi.spyOn(t.tmux, 'listSessions');
    launcher.watch();
    launcher.watch();
    await vi.advanceTimersByTimeAsync(3000);
    expect(list).toHaveBeenCalledTimes(1);
    expect(launcher.list()[0]!.state).toBe('running');
    t.live.delete('la-' + record.id);
    await vi.advanceTimersByTimeAsync(3000);
    expect(launcher.list()[0]).toMatchObject({
      state: 'ended',
      reason: 'Session is no longer running',
    });
    await vi.advanceTimersByTimeAsync(9000);
    expect(list).toHaveBeenCalledTimes(2); // Nothing left to watch.
    launcher.close();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
it('skips a watch tick while the previous reconcile is still running', async () => {
  const { launcher, folder, t } = await setup();
  const record = await launcher.launch({ agent: 'claude', folder });
  vi.useFakeTimers();
  try {
    const slow = deferred<{ name: string; panePid: number; currentCommand: string }[]>();
    const list = vi.fn(() => slow.promise);
    t.tmux.listSessions = list;
    launcher.watch();
    await vi.advanceTimersByTimeAsync(9000);
    expect(list).toHaveBeenCalledTimes(1);
    slow.resolve([{ name: 'la-' + record.id, panePid: record.panePid, currentCommand: 'zsh' }]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(list).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
it('retries identification on request and rejects unknown or ended launches', async () => {
  let found = false;
  const { launcher, folder } = await setup({
    findCodex: async () =>
      found ? { agent: 'codex', sessionRef: 'later', projectId: folder } : undefined,
  });
  const record = await launcher.launch({ agent: 'codex', folder });
  await vi.waitFor(() => expect(launcher.list()[0]!.state).toBe('unidentified'));
  found = true;
  const retry = launcher.identify(record.id);
  expect(launcher.list()[0]).toMatchObject({ state: 'starting' });
  expect(launcher.list()[0]!.reason).toBeUndefined();
  await retry;
  expect(launcher.list()[0]).toMatchObject({ state: 'running', sessionRef: 'later' });
  expect(() => launcher.identify('nope')).toThrow('Unknown launch');
  await launcher.end(record.id);
  expect(() => launcher.identify(record.id)).toThrow(
    expect.objectContaining({ code: 'unknown-session' }),
  );
});

it('retries attaching a new Claude session until its transcript appears', async () => {
  let calls = 0;
  const { launcher, folder } = await setup({
    timeout: 10_000,
    register: async (target: Target) => {
      if (++calls < 3) throw new Error('Exact transcript pointer unavailable or ambiguous');
      return { id: 'panel-' + target.sessionRef, target };
    },
  });
  await launcher.launch({ agent: 'claude', folder });
  await vi.waitFor(() => expect(launcher.list()[0]).toMatchObject({ state: 'running' }));
  expect(calls).toBe(3);
});
it('backs off identification (1 s, 5 s, 15 s), then waits for Retry or a new discovery event', async () => {
  const delays: number[] = [];
  let found: Target | undefined;
  const findCodex = vi.fn(async () => found);
  const { launcher, folder } = await setup({
    findCodex,
    timeout: 60_000,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  const record = await launcher.launch({ agent: 'codex', folder });
  await vi.waitFor(() =>
    expect(launcher.list()[0]).toMatchObject({
      state: 'unidentified',
      reason: 'Started, not connected',
    }),
  );
  expect(delays).toEqual([1000, 5000, 15000]);
  expect(findCodex).toHaveBeenCalledTimes(4);
  // Nothing polls on its own once the schedule is spent.
  await tick();
  await tick();
  expect(findCodex).toHaveBeenCalledTimes(4);
  // A discovery event for another agent does not retry; one for Codex does.
  launcher.noticeDiscovery('claude');
  await tick();
  expect(findCodex).toHaveBeenCalledTimes(4);
  found = { agent: 'codex', sessionRef: 'later', projectId: folder };
  launcher.noticeDiscovery('codex');
  await vi.waitFor(() =>
    expect(launcher.list()[0]).toMatchObject({
      id: record.id,
      state: 'running',
      sessionRef: 'later',
    }),
  );
  const calls = findCodex.mock.calls.length;
  // Identified: further discovery events and the watch never probe it again.
  launcher.noticeDiscovery('codex');
  await launcher.reconcile();
  await tick();
  expect(findCodex).toHaveBeenCalledTimes(calls);
});
it('stops retrying an unidentified launch once it ends', async () => {
  const findCodex = vi.fn(async () => undefined);
  const { launcher, folder } = await setup({ findCodex, timeout: 60_000 });
  const record = await launcher.launch({ agent: 'codex', folder });
  await vi.waitFor(() => expect(launcher.list()[0]!.state).toBe('unidentified'));
  await launcher.end(record.id);
  const calls = findCodex.mock.calls.length;
  launcher.noticeDiscovery('codex');
  await tick();
  expect(findCodex).toHaveBeenCalledTimes(calls);
  expect(() => launcher.identify(record.id)).toThrow('Unknown launch');
});
it('adopts a launch back when its tmux session reappears after a listing gap, but never one ended on purpose', async () => {
  const { launcher, folder, t } = await setup();
  const a = await launcher.launch({ agent: 'claude', folder });
  const entry = t.live.get('la-' + a.id)!;
  t.live.delete('la-' + a.id);
  await launcher.reconcile();
  expect(launcher.list()[0]).toMatchObject({
    state: 'ended',
    reason: 'Session is no longer running',
  });
  t.live.set('la-' + a.id, entry);
  await launcher.reconcile();
  await tick();
  const revived = launcher.list()[0]!;
  expect(revived.state).not.toBe('ended');
  expect(revived.reason).toBeUndefined();
  expect(revived.panePid).toBe(entry.panePid);
  await launcher.end(a.id);
  t.live.set('la-' + a.id, entry);
  await launcher.reconcile();
  await tick();
  expect(launcher.list()[0]!.state).toBe('ended');
});

it('starts a terminal as a login shell, titled per folder, running at once with no identification', async () => {
  const { launcher, folder, t, register } = await setup();
  const a = await launcher.launch({ agent: 'shell', folder });
  expect([...t.live.values()][0]!.argv).toEqual(['/bin/zsh', '-l']);
  expect(a).toMatchObject({
    agent: 'shell',
    folder,
    state: 'running',
    title: 'Terminal',
    busy: false,
  });
  expect(a.sessionRef).toBeUndefined();
  expect(register).not.toHaveBeenCalled();
  const b = await launcher.launch({ agent: 'shell', folder });
  expect(b.title).toBe('Terminal 2');
  await launcher.end(a.id);
  const c = await launcher.launch({ agent: 'shell', folder });
  expect(c.title).toBe('Terminal'); // the lowest free number, not Terminal 3
});
it('tracks a terminal as busy from the pane command and notifies subscribers when it changes', async () => {
  const { launcher, folder, t } = await setup();
  const seen: (boolean | undefined)[] = [];
  launcher.subscribe((list) => seen.push(list[0]?.busy));
  const record = await launcher.launch({ agent: 'shell', folder });
  t.live.get('la-' + record.id)!.currentCommand = 'node';
  await launcher.reconcile();
  expect(launcher.list()[0]!.busy).toBe(true);
  t.live.get('la-' + record.id)!.currentCommand = 'zsh';
  await launcher.reconcile();
  expect(launcher.list()[0]!.busy).toBe(false);
  expect(seen).toEqual([false, true, false]);
});
it('ends a terminal with one Ctrl+C and an immediate kill, and deletes it on the next reconcile', async () => {
  const { launcher, folder, t, store } = await setup();
  const record = await launcher.launch({ agent: 'shell', folder });
  t.tmux.sendKeys = async (n, k) => {
    t.keys.push([n, k]);
  };
  const kill = vi.spyOn(t.tmux, 'killSession');
  await launcher.end(record.id);
  expect(t.keys).toEqual([['la-' + record.id, ['C-c']]]);
  expect(kill).toHaveBeenCalledWith('la-' + record.id);
  expect(launcher.list()[0]).toMatchObject({ state: 'ended', reason: 'Ended by you' });
  await launcher.reconcile();
  expect(store.listLaunches()).toEqual([]);
});
it('adopts a terminal back as running after a restart and deletes one whose shell exited', async () => {
  const { launcher, folder, t, store } = await setup();
  const alive = await launcher.launch({ agent: 'shell', folder });
  const gone = await launcher.launch({ agent: 'shell', folder });
  store.putLaunch({
    ...store.listLaunches().find((r) => r.id === alive.id)!,
    state: 'ended',
    reason: 'Session is no longer running',
  });
  t.live.delete('la-' + gone.id);
  await launcher.reconcile();
  expect(launcher.list().map((r) => [r.id, r.state])).toEqual([[alive.id, 'running']]);
  expect(launcher.list()[0]!.sessionRef).toBeUndefined();
});
it('passes a custom first message as the launch prompt and validates it', async () => {
  const { launcher, folder, t } = await setup();
  await launcher.launch({
    agent: 'claude',
    folder,
    prompt: '  Fix the tests, then explain.\nKeep it short.  ',
  });
  expect([...t.live.values()][0]!.argv.slice(-2)).toEqual([
    '--',
    'Fix the tests, then explain.\nKeep it short.',
  ]);
  await launcher.launch({ agent: 'codex', folder, prompt: 'Review the diff' });
  expect([...t.live.values()][1]!.argv).toEqual(['/bin/codex', '--', 'Review the diff']);
  await launcher.launch({ agent: 'shell', folder, prompt: 'ignored' });
  expect([...t.live.values()][2]!.argv).toEqual(['/bin/zsh', '-l']);
  for (const bad of ['', '   ', 'x'.repeat(4001), 5])
    await expect(launcher.launch({ agent: 'claude', folder, prompt: bad as any })).rejects.toThrow(
      'Invalid first message',
    );
  expect(nextTerminalTitle([])).toBe('Terminal');
  expect(nextTerminalTitle(['Terminal'])).toBe('Terminal 2');
  expect(nextTerminalTitle(['Terminal 2', 'Terminal 3'])).toBe('Terminal');
  expect(defaultShell({ SHELL: '/opt/homebrew/bin/fish' })).toBe('/opt/homebrew/bin/fish');
  expect(defaultShell({ SHELL: 'fish' })).toBe('/bin/zsh');
  expect(defaultShell({})).toBe('/bin/zsh');
});
it('passes a first message starting with "-" after `--`, so neither CLI reads it as an option', async () => {
  const { launcher, folder, t } = await setup({
    settings: { extraArgs: { claude: ['--add-dir', 'a', 'b'], codex: ['-m', 'gpt 5'] } },
  });
  const prompt = '- fix the login bug\n- then explain';
  const claude = await launcher.launch({ agent: 'claude', folder, prompt });
  expect([...t.live.values()][0]!.argv).toEqual([
    '/bin/claude',
    '--session-id',
    claude.sessionRef,
    '--add-dir',
    'a',
    'b',
    '--',
    prompt,
  ]);
  await launcher.launch({ agent: 'codex', folder, prompt });
  expect([...t.live.values()][1]!.argv).toEqual(['/bin/codex', '-m', 'gpt 5', '--', prompt]);
});
it('run reuses the folder’s idle terminal, skips busy ones, and starts a second when all are busy', async () => {
  const { launcher, folder, t } = await setup();
  const first = await launcher.run({ folder, command: 'npm test\n', originSessionId: 'panel-1' });
  expect(first).toMatchObject({
    reused: false,
    typed: true,
    launch: { title: 'Terminal', originSessionId: 'panel-1' },
  });
  expect(t.typed).toEqual([['la-' + first.launch.id, 'npm test']]);
  const again = await launcher.run({ folder, command: 'npm run typecheck' });
  expect(again).toMatchObject({ reused: true, launch: { id: first.launch.id } });
  t.live.get('la-' + first.launch.id)!.currentCommand = 'node';
  const second = await launcher.run({ folder, command: 'git status', originSessionId: 'panel-2' });
  expect(second).toMatchObject({
    reused: false,
    typed: true,
    launch: { title: 'Terminal 2', originSessionId: 'panel-2' },
  });
  expect(t.typed.at(-1)).toEqual(['la-' + second.launch.id, 'git status']);
  // A later run marks the reused terminal with the session that used it.
  t.live.get('la-' + first.launch.id)!.currentCommand = 'zsh';
  await launcher.run({ folder, command: 'ls', originSessionId: 'panel-3' });
  expect(launcher.list().find((r) => r.id === first.launch.id)!.originSessionId).toBe('panel-3');
});
it('run still types when the new shell is not ready in time, and reports typed: false', async () => {
  const { launcher, folder, t } = await setup({ settings: {} });
  t.tmux.newSession = async (name, cwd, argv) => {
    t.live.set(name, { cwd, argv, panePid: 7, currentCommand: 'login' });
    return { panePid: 7 };
  };
  const result = await launcher.run({ folder, command: 'make' });
  expect(result.typed).toBe(false);
  expect(t.typed).toEqual([['la-' + result.launch.id, 'make']]);
});
it('run validates the command and the folder', async () => {
  const { launcher, folder } = await setup();
  for (const bad of ['', '\n\n', 'x'.repeat(8193), 3])
    await expect(launcher.run({ folder, command: bad as any })).rejects.toThrow('Invalid command');
  // Control and invisible characters: a tab, ESC, a C1 control, CR inside, bidi overrides and marks, zero-width characters.
  for (const bad of [
    'ls\t-la',
    'echo \u001b[31m',
    'ls\u0085',
    'a\rb',
    'rm \u202Eexe.txt',
    'ls\u2066',
    'ls\u200E',
    'ls\u061C',
    'ls\u200B',
    'ls\u2060',
    '\uFEFFls',
    'ls\u007F',
  ])
    await expect(launcher.run({ folder, command: bad })).rejects.toThrow('Invalid command');
  expect(validateCommand('echo "שלום"\nls\n')).toBe('echo "שלום"\nls');
  await expect(launcher.run({ folder: '/nope', command: 'ls' })).rejects.toThrow(
    'Choose a project folder',
  );
  expect(validateCommand('  ls -la \n\n')).toBe('  ls -la ');
});
it('run rejects when the new terminal disappears while waiting for its shell', async () => {
  let launcher!: SessionLauncher;
  let name = '';
  const ctx = await setup({
    sleep: async () => {
      ctx.t.live.delete(name);
      await launcher.reconcile();
    },
  });
  launcher = ctx.launcher;
  ctx.t.tmux.newSession = async (n, cwd, argv) => {
    name = n;
    ctx.t.live.set(n, { cwd, argv, panePid: 7, currentCommand: 'login' });
    return { panePid: 7 };
  };
  await expect(launcher.run({ folder: ctx.folder, command: 'make' })).rejects.toThrow(
    'Terminal is no longer running',
  );
});
it('reconcile does not delete a shell started while its tmux listing was in flight', async () => {
  const { launcher, folder, t, store } = await setup();
  const listed = deferred<Awaited<ReturnType<Tmux['listSessions']>>>();
  const realList = t.tmux.listSessions.bind(t.tmux);
  t.tmux.listSessions = () => listed.promise; // a listing taken before the shell exists
  const pending = launcher.reconcile();
  await tick();
  t.tmux.listSessions = realList;
  const shell = await launcher.launch({ agent: 'shell', folder });
  listed.resolve([]);
  await pending;
  expect(store.listLaunches().map((r) => r.id)).toEqual([shell.id]);
  await launcher.reconcile(); // a later listing that includes it keeps it as well
  expect(launcher.list()).toMatchObject([{ id: shell.id, state: 'running' }]);
});
it.each(['codex', 'claude'] as const)(
  'reconcile does not end a %s agent started while its tmux listing was in flight',
  async (agent) => {
    const { launcher, folder, t, store } = await setup();
    const listed = deferred<Awaited<ReturnType<Tmux['listSessions']>>>();
    const realList = t.tmux.listSessions.bind(t.tmux);
    t.tmux.listSessions = () => listed.promise; // a listing taken before the agent exists
    const pending = launcher.reconcile();
    await tick();
    t.tmux.listSessions = realList;
    const started = await launcher.launch({ agent, folder });
    listed.resolve([]);
    await pending;
    expect(store.listLaunches().find((r) => r.id === started.id)?.state).not.toBe('ended');
  },
);
it('run never picks a terminal that is being ended', async () => {
  const { launcher, folder, t } = await setup();
  const first = await launcher.launch({ agent: 'shell', folder });
  const killed = deferred<void>();
  t.tmux.killSession = async (n) => {
    await killed.promise;
    t.live.delete(n);
  };
  t.tmux.sendKeys = async (n, k) => {
    t.keys.push([n, k]);
  };
  const ended = launcher.end(first.id);
  await tick();
  const result = await launcher.run({ folder, command: 'ls' });
  expect(result.reused).toBe(false);
  expect(result.launch.id).not.toBe(first.id);
  expect(t.typed).toEqual([['la-' + result.launch.id, 'ls']]);
  killed.resolve();
  await ended;
});
it('run reports typed: false with a defined launch when typing into a ready shell fails', async () => {
  const { launcher, folder, t } = await setup();
  t.tmux.typeText = async () => {
    throw new Error('no pane');
  };
  const result = await launcher.run({ folder, command: 'make' });
  expect(result.typed).toBe(false);
  expect(result.launch).toMatchObject({ agent: 'shell', folder });
});
