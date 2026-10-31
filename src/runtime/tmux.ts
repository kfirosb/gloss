import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { dataDir } from './data-dir.js';
import {
  collectProcess,
  runProcess,
  type ProcessOutcome,
  type ProcessRunner,
} from './process-runner.js';
import { ensurePrivateDirectory } from './private-directory.js';
import { isTerminalWheel, type TerminalWheel } from '../core/terminal-wheel.js';

export class TmuxUnavailable extends Error {
  readonly code = 'tmux-unavailable';
  constructor() {
    super(
      process.platform === 'darwin'
        ? 'tmux is not installed. Install it with Homebrew (brew install tmux) or update Gloss.'
        : 'tmux is not installed. Install it with your package manager (for example apt install tmux) or update Gloss.',
    );
  }
}
/** The name a NEW launch's tmux session gets. */
export const sessionNameFor = (launchId: string) => 'gloss-' + launchId;
/** The name sessions had before the rename; a launch started by an older version may still run under it. */
const legacySessionNameFor = (launchId: string) => 'la-' + launchId;
/** The name of an existing launch's session within a live listing: the pre-rename name only when that is what runs. */
export const liveSessionName = (live: { has(name: string): boolean }, launchId: string): string =>
  !live.has(sessionNameFor(launchId)) && live.has(legacySessionNameFor(launchId))
    ? legacySessionNameFor(launchId)
    : sessionNameFor(launchId);
/** The name an existing launch's session runs under (current or pre-rename), or undefined when neither runs. */
export async function existingSessionName(
  tmux: Pick<Tmux, 'hasSession'>,
  launchId: string,
): Promise<string | undefined> {
  if (await tmux.hasSession(sessionNameFor(launchId))) return sessionNameFor(launchId);
  if (await tmux.hasSession(legacySessionNameFor(launchId))) return legacySessionNameFor(launchId);
  return undefined;
}
/** The one owner of resolving an existing launch to its tmux session; the current name when neither runs. */
export const sessionNameOf = async (tmux: Pick<Tmux, 'hasSession'>, launchId: string) =>
  (await existingSessionName(tmux, launchId)) ?? sessionNameFor(launchId);
/** True while the launch's tmux session runs under either name. */
export const hasLaunchSession = async (tmux: Pick<Tmux, 'hasSession'>, launchId: string) =>
  (await existingSessionName(tmux, launchId)) !== undefined;
/** On macOS Homebrew first, then the app's bundled tmux; on Linux the bundled, tested tmux first and the
 * distribution's as fallback. The desktop shell passes the bundled path in GLOSS_TMUX because
 * process.resourcesPath may be unset in the ELECTRON_RUN_AS_NODE server child. */
export function tmuxCandidates(
  env: NodeJS.ProcessEnv = process.env,
  resourcesPath = (process as { resourcesPath?: string }).resourcesPath,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const bundled = env.GLOSS_TMUX;
  const app = [
    ...(bundled && isAbsolute(bundled) ? [bundled] : []),
    ...(resourcesPath ? [join(resourcesPath, 'bin', 'tmux')] : []),
  ];
  return [
    ...new Set(
      platform === 'darwin'
        ? ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', ...app]
        : [...app, '/usr/bin/tmux', '/usr/local/bin/tmux'],
    ),
  ];
}
/** The variables Claude Code exports to its child processes. A Gloss opened from inside a Claude session (and the
 * tmux server that Gloss started, which outlives it) carries them; an agent that inherits CLAUDE_CODE_CHILD_SESSION
 * believes it is a subagent and keeps no transcript, so Gloss can neither read nor reach it. Gloss agents are
 * never that session's children. */
export const CLAUDE_SESSION_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_EFFORT',
  'AI_AGENT',
];
// Never hand the panel capability, Electron's node mode, an enclosing Claude session or an enclosing tmux to the
// private server or its agents.
const AGENT_SECRETS = ['LANGUAGE_PANEL_CAPABILITY', 'ELECTRON_RUN_AS_NODE', ...CLAUDE_SESSION_ENV];
const PRIVATE_ENV = [...AGENT_SECRETS, 'TMUX', 'TMUX_PANE'];
export function tmuxEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of PRIVATE_ENV) delete clean[key];
  return clean;
}

export async function locateTmux(
  candidates = tmuxCandidates(),
  runner: ProcessRunner = runProcess,
): Promise<string> {
  for (const candidate of candidates) {
    const result = await collectProcess(
      runner(candidate, ['-V'], '', AbortSignal.timeout(3000), {
        timeoutMs: 2000,
        maxOutputBytes: 1024,
        env: tmuxEnvironment(),
      }),
    ).catch(() => undefined);
    if (
      result?.outcome.reason === 'exited' &&
      result.outcome.code === 0 &&
      result.lines.some((l) => /^tmux \d/.test(l))
    )
      return candidate;
  }
  throw new TmuxUnavailable();
}

export async function ensureSocketDirectory(dir: string) {
  await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
  await ensurePrivateDirectory(dir, 'Unsafe tmux directory');
}

export interface Tmux {
  readonly executable: string;
  readonly socket: string;
  newSession(
    name: string,
    cwd: string,
    argv: string[],
    env?: Record<string, string>,
  ): Promise<{ panePid: number }>;
  listSessions(): Promise<{ name: string; panePid: number; currentCommand: string }[]>;
  hasSession(name: string): Promise<boolean>;
  capturePane(name: string): Promise<string>;
  /** The pane as drawn, with SGR colour and attribute escapes (capture-pane -e). */
  capturePaneStyled(name: string): Promise<string>;
  /** The active pane's cursor cell, and whether the pane is in copy or another tmux mode. */
  paneCursor(name: string): Promise<{ x: number; y: number; inMode: boolean }>;
  /** Rows `start`..`end` of the visible pane (0 = top), styled; tmux clamps both ends to the pane. */
  captureRows(name: string, start: number, end: number): Promise<string>;
  /** Fills a named paste buffer from stdin, so the text never travels as a tmux command argument. */
  loadBuffer(buffer: string, text: string): Promise<void>;
  /** Pastes and deletes a named buffer: bracketed when the program asked for it (-p), line feeds kept (-r). */
  pasteBuffer(name: string, buffer: string): Promise<void>;
  deleteBuffer(buffer: string): Promise<void>;
  sendKeys(name: string, keys: string[]): Promise<void>;
  /** Claude's stash key, Ctrl+S, once. The only key besides Enter that Gloss presses in a Claude pane. */
  pressStash(name: string): Promise<void>;
  /** Types text literally (no key-name parsing), then presses Enter. */
  typeText(name: string, text: string): Promise<void>;
  resizeWindow(name: string, cols: number, rows: number): Promise<void>;
  /** Scrolls the pane like a wheel would: negative lines scroll up. col/row (1-based) is the pointer cell. */
  scroll(name: string, wheel: TerminalWheel): Promise<void>;
  /** Leaves copy mode (history browsing) so typed keys reach the agent again. */
  exitCopyMode(name: string): Promise<void>;
  killSession(name: string): Promise<void>;
  attachArgv(name: string): string[];
}

// "server exited unexpectedly": the server was shutting down as it answered, e.g. right after its last session was killed.
/** Keeps tmux's own words (or the timeout) in the error so a failure can be diagnosed from the message the user sees. */
const tmuxFailure = (outcome: ProcessOutcome) =>
  new Error(
    'tmux command failed: ' +
      (outcome.reason === 'exited'
        ? outcome.diagnostics.trim().split('\n')[0]!.slice(0, 200) || `exit code ${outcome.code}`
        : outcome.reason),
  );
const serverAbsent = (outcome: ProcessOutcome) =>
  outcome.reason === 'exited' &&
  outcome.code === 1 &&
  /^(?:no server running on .+|error connecting to .+ \(No such file or directory\)|server exited unexpectedly)\s*$/.test(
    outcome.diagnostics,
  );
const sessionAbsent = (outcome: ProcessOutcome) =>
  serverAbsent(outcome) ||
  (outcome.reason === 'exited' &&
    outcome.code === 1 &&
    /^can't find session: .+\s*$/.test(outcome.diagnostics));

// `la-` is the prefix sessions had before the rename to Gloss; they may still be running after an update.
const NAME = /^(?:gloss|la)-[A-Za-z0-9-]{1,64}$/;
/** True for a tmux session Gloss owns, under either the current or the pre-rename prefix. */
export const isGlossSessionName = (name: string): boolean => NAME.test(name);
const BUFFER = /^gloss-[A-Za-z0-9-]{1,100}$/;
const CURSOR = /^(\d+) (\d+) ([01])$/;
/** Highest pane row Gloss asks tmux to capture; no pane is taller. */
export const MAX_PANE_ROW = 10_000;

/** One wheel report in the encoding the pane's app asked for: SGR, or legacy X10 (coordinates capped at 223). */
function wheelReport(up: boolean, col: number, row: number, sgr: boolean): number[] {
  const button = up ? 64 : 65;
  if (sgr) return [...Buffer.from(`\x1b[<${button};${col};${row}M`)];
  return [0x1b, 0x5b, 0x4d, 32 + button, 32 + Math.min(col, 223), 32 + Math.min(row, 223)];
}

export async function createTmux(
  options: { stateDir?: string; executable?: string; runner?: ProcessRunner } = {},
): Promise<Tmux> {
  const runner = options.runner ?? runProcess;
  const executable = options.executable ?? (await locateTmux(undefined, runner));
  const dir = join(options.stateDir ?? dataDir(), 'tmux');
  await ensureSocketDirectory(dir);
  const socket = join(dir, 'socket');
  // -u: always UTF-8. An app opened from the Dock or Finder has no LANG, and tmux would then print the listing's
  // tab separators as "_" (every live session would look ended) and draw Hebrew in the popup terminal as "_".
  const base = ['-u', '-S', socket, '-f', '/dev/null'];
  // Wheel lines not yet worth a page, per session, for full-screen apps that only page (see scroll).
  const pageCarry = new Map<string, number>();
  const check = (name: string) => {
    if (!NAME.test(name)) throw new Error('Invalid tmux session name');
  };
  const checkBuffer = (buffer: string) => {
    if (!BUFFER.test(buffer)) throw new Error('Invalid tmux buffer name');
  };
  async function run(args: string[], allowFailure = false, input = '') {
    const result = await collectProcess(
      runner(executable, [...base, ...args], input, AbortSignal.timeout(10_000), {
        timeoutMs: 8000,
        maxOutputBytes: 1024 * 1024,
        env: tmuxEnvironment(),
      }),
    );
    if (!allowFailure && (result.outcome.reason !== 'exited' || result.outcome.code !== 0))
      throw tmuxFailure(result.outcome);
    return result;
  }
  return {
    executable,
    socket,
    async newSession(name, cwd, argv, env = {}) {
      check(name);
      if (!argv.length) throw new Error('Command required');
      const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      // tmux runs a one-item command through `sh -c`; env keeps argv shell-free and unsets private variables
      // that an already-running server may still hold in its global environment.
      const command = ['/usr/bin/env', ...AGENT_SECRETS.flatMap((k) => ['-u', k]), ...argv];
      const result = await run([
        'new-session',
        '-d',
        '-P',
        '-F',
        '#{pane_pid}',
        '-s',
        name,
        '-c',
        cwd,
        '-x',
        '200',
        '-y',
        '50',
        ...envArgs,
        '--',
        ...command,
      ]);
      const panePid = Number(result.lines.at(-1));
      if (!Number.isSafeInteger(panePid) || panePid <= 1)
        throw new Error('tmux did not report a pane process');
      // The server exists now: scrub its global environment and make the popup a plain terminal
      // (no prefix key, so Claude's Ctrl+B and Codex's Esc reach the agent; no status row).
      for (const key of AGENT_SECRETS) await run(['set-environment', '-g', '-u', key], true);
      await run(
        [
          'set-option',
          '-g',
          'prefix',
          'None',
          ';',
          'set-option',
          '-g',
          'prefix2',
          'None',
          ';',
          'set-option',
          '-g',
          'status',
          'off',
          ';',
          'set-option',
          '-sg',
          'escape-time',
          '0',
        ],
        true,
      );
      return { panePid };
    },
    async listSessions() {
      const result = await run(
        ['list-sessions', '-F', '#{session_name}\t#{pane_pid}\t#{pane_current_command}'],
        true,
      );
      if (result.outcome.reason !== 'exited' || result.outcome.code !== 0) {
        if (serverAbsent(result.outcome)) return [];
        throw tmuxFailure(result.outcome);
      }
      return result.lines
        .map((line) => line.split('\t'))
        .filter(([n, p]) => n && isGlossSessionName(n) && Number(p) > 1)
        .map(([name, pid, command]) => ({
          name: name!,
          panePid: Number(pid),
          currentCommand: command ?? '',
        }));
    },
    async hasSession(name) {
      check(name);
      const { outcome } = await run(['has-session', '-t', '=' + name], true);
      if (outcome.reason === 'exited' && outcome.code === 0) return true;
      if (sessionAbsent(outcome)) return false;
      throw tmuxFailure(outcome);
    },
    async capturePane(name) {
      check(name);
      return (await run(['capture-pane', '-p', '-t', '=' + name + ':'])).lines.join('\n');
    },
    async capturePaneStyled(name) {
      check(name);
      return (await run(['capture-pane', '-e', '-p', '-t', '=' + name + ':'])).lines.join('\n');
    },
    async paneCursor(name) {
      check(name);
      const { lines } = await run([
        'display-message',
        '-p',
        '-t',
        '=' + name + ':',
        '#{cursor_x} #{cursor_y} #{pane_in_mode}',
      ]);
      const match = CURSOR.exec(lines.join('').trim());
      if (!match) throw new Error('tmux did not report the cursor');
      return { x: Number(match[1]), y: Number(match[2]), inMode: match[3] === '1' };
    },
    async captureRows(name, start, end) {
      check(name);
      const row = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= MAX_PANE_ROW;
      if (!row(start) || !row(end) || start > end) throw new Error('Invalid rows');
      const target = '=' + name + ':';
      return (
        await run([
          'capture-pane',
          '-e',
          '-p',
          '-S',
          String(start),
          '-E',
          String(end),
          '-t',
          target,
        ])
      ).lines.join('\n');
    },
    async loadBuffer(buffer, text) {
      checkBuffer(buffer);
      await run(['load-buffer', '-b', buffer, '-'], false, text);
    },
    async pasteBuffer(name, buffer) {
      check(name);
      checkBuffer(buffer);
      await run(['paste-buffer', '-p', '-r', '-d', '-b', buffer, '-t', '=' + name + ':']);
    },
    async deleteBuffer(buffer) {
      checkBuffer(buffer);
      const { outcome } = await run(['delete-buffer', '-b', buffer], true);
      if (outcome.reason === 'exited' && outcome.code === 0) return;
      if (serverAbsent(outcome)) return;
      if (
        outcome.reason === 'exited' &&
        /^(?:no buffer|unknown buffer):? /.test(outcome.diagnostics)
      )
        return;
      throw tmuxFailure(outcome);
    },
    async sendKeys(name, keys) {
      check(name);
      await run(['send-keys', '-t', '=' + name + ':', '--', ...keys]);
    },
    async pressStash(name) {
      check(name);
      await run(['send-keys', '-t', '=' + name + ':', '--', 'C-s']);
    },
    async typeText(name, text) {
      check(name);
      await run(['send-keys', '-t', '=' + name + ':', '-l', '--', text]);
      await run(['send-keys', '-t', '=' + name + ':', '--', 'Enter']);
    },
    async resizeWindow(name, cols, rows) {
      check(name);
      if (![cols, rows].every((n) => Number.isSafeInteger(n) && n >= 10 && n <= 1000))
        throw new Error('Invalid size');
      await run(['resize-window', '-t', '=' + name + ':', '-x', String(cols), '-y', String(rows)]);
    },
    // tmux's mouse option stays off so the browser keeps its own text selection; the wheel is routed here instead,
    // mirroring tmux's default wheel binding: copy-mode scrolls, mouse-aware apps (Claude) get wheel reports,
    // other full-screen apps get arrow keys, and a plain shell enters copy mode to browse its history.
    async scroll(name, wheel) {
      check(name);
      if (!isTerminalWheel(wheel)) throw new Error('Invalid scroll');
      const target = '=' + name + ':';
      const state = await run([
        'display-message',
        '-p',
        '-t',
        target,
        '#{pane_in_mode} #{mouse_any_flag} #{mouse_sgr_flag} #{alternate_on} #{pane_height}',
      ]);
      const fields = (state.lines.at(-1) ?? '').split(' ');
      const [inMode, mouse, sgr, alternate] = fields.map((f) => f === '1');
      const height = Number(fields[4]) || 24;
      const up = wheel.lines < 0;
      const count = String(Math.abs(wheel.lines));
      if (inMode) {
        await run(['send-keys', '-X', '-N', count, '-t', target, up ? 'scroll-up' : 'scroll-down']);
      } else if (mouse) {
        const report = wheelReport(up, wheel.col, wheel.row, sgr === true);
        const bytes = Array.from({ length: Math.abs(wheel.lines) }, () => report).flat();
        await run(['send-keys', '-H', '-t', target, ...bytes.map((b) => b.toString(16))]);
      } else if (alternate) {
        // Full-screen apps that ignore the mouse (Codex) scroll by page and read arrow keys as prompt history.
        // A page per third of a screen of wheel movement keeps a single notch from jumping a whole screen.
        const before = pageCarry.get(name) ?? 0;
        const carry = (Math.sign(before) === Math.sign(wheel.lines) ? before : 0) + wheel.lines;
        const step = Math.max(3, Math.floor(height / 3));
        const pages = Math.trunc(carry / step);
        pageCarry.set(name, carry - pages * step);
        if (pages)
          await run([
            'send-keys',
            '-N',
            String(Math.abs(pages)),
            '-t',
            target,
            up ? 'PPage' : 'NPage',
          ]);
      } else if (up) {
        await run([
          'copy-mode',
          '-e',
          '-t',
          target,
          ';',
          'send-keys',
          '-X',
          '-N',
          count,
          '-t',
          target,
          'scroll-up',
        ]);
      }
    },
    async exitCopyMode(name) {
      check(name);
      await run(['copy-mode', '-q', '-t', '=' + name + ':']);
    },
    async killSession(name) {
      check(name);
      pageCarry.delete(name);
      const { outcome } = await run(['kill-session', '-t', '=' + name], true);
      if ((outcome.reason === 'exited' && outcome.code === 0) || sessionAbsent(outcome)) return;
      throw tmuxFailure(outcome);
    },
    attachArgv(name) {
      check(name);
      return [executable, ...base, 'attach-session', '-t', '=' + name];
    },
  };
}
