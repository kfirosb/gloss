import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { collectProcess, type ProcessRunner } from '../../runtime/process-runner.js';
import { LsofMissing, lsofPath } from '../../runtime/platform-tools.js';
import { uuid } from '../shared.js';

/**
 * Codex 0.162 runs conversations inside a shared app-server daemon. The daemon keeps a thread loaded, and keeps
 * holding its writer lock, after the terminal client (TUI) that used it exits. Lock ownership alone therefore does
 * not mean anyone is attached. These helpers decide which locked threads are OPEN: something can still process a
 * queued message for them.
 */

/** A thread may be created slightly before the client process start time we can observe (whole-second ps clock). */
export const ATTACH_CLOCK_SKEW_MS = 2000;

/** Native subcommands that are not an interactive terminal client of a thread. `resume` and `fork` are clients. */
const NON_CLIENT_SUBCOMMANDS = new Set([
  'agents',
  'exec',
  'e',
  'review',
  'login',
  'logout',
  'mcp',
  'plugin',
  'app-server',
  'remote-control',
  'app',
  'completion',
  'update',
  'doctor',
  'sandbox',
  'debug',
  'apply',
  'a',
  'queue',
  'archive',
  'delete',
  'migrate-rollouts',
  'unarchive',
  'cloud',
  'exec-server',
  'features',
  'help',
]);
/** Top-level options that take a value, so the value is not mistaken for the prompt or a subcommand. */
const VALUE_OPTIONS = new Set([
  '-c',
  '--config',
  '--enable',
  '--disable',
  '--remote',
  '--remote-auth-token-env',
  '-i',
  '--image',
  '-m',
  '--model',
  '--local-provider',
  '-p',
  '--profile',
  '-s',
  '--sandbox',
  '-C',
  '--cd',
  '--add-dir',
  '-a',
  '--ask-for-approval',
]);

export interface CodexProcess {
  pid: number;
  /** Approximate start, epoch ms (ps reports whole seconds of elapsed time). */
  startedAt: number;
  role: 'daemon' | 'client' | 'other';
  /** Exact thread named on a `codex resume <UUID>` command line. */
  resume?: string;
  /** Value of -C/--cd, possibly relative to the process working directory. */
  cd?: string;
}

/** `[[dd-]hh:]mm:ss` elapsed time in milliseconds. */
export function parseElapsed(text: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return undefined;
  const [, days = '0', hours = '0', minutes, seconds] = match;
  return (
    (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds!)) * 1000
  );
}

/** Classifies a `codex` command line (argv[0] included) as the app-server daemon, a terminal client, or other. */
export function classifyCodexCommand(args: string): Pick<CodexProcess, 'role' | 'resume' | 'cd'> {
  // ps joins argv with spaces, so locate the end of the executable path by its `codex` basename.
  const executable = /(?:^|\/)codex(?=\s|$)/.exec(args);
  if (!executable) return { role: 'other' };
  const tokens = args
    .slice(executable.index + executable[0].length)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.includes('app-server')) return { role: 'daemon' };
  let cd: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '--') break;
    const [name, inline] =
      token.startsWith('--') && token.includes('=')
        ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)]
        : [token, undefined];
    if (VALUE_OPTIONS.has(name)) {
      const value = inline ?? tokens[++i];
      if ((name === '-C' || name === '--cd') && value) cd = value;
      continue;
    }
    if (token.startsWith('-')) continue;
    // The first positional is a subcommand or the user prompt.
    if (NON_CLIENT_SUBCOMMANDS.has(token)) return { role: 'other' };
    if (token === 'resume') {
      const next = tokens.slice(i + 1).find((t) => !t.startsWith('-'));
      return {
        role: 'client',
        ...(next && uuid.test(next) ? { resume: next } : {}),
        ...(cd ? { cd } : {}),
      };
    }
    break;
  }
  return { role: 'client', ...(cd ? { cd } : {}) };
}

/** One shell-free `ps` over the process table; only processes whose short name is `codex` are kept. */
export async function codexProcesses(
  runner: ProcessRunner,
  signal: AbortSignal,
  now: number,
): Promise<Map<number, CodexProcess>> {
  const result = await collectProcess(
    runner('/bin/ps', ['-axww', '-o', 'pid=,etime=,ucomm=,args='], '', signal, {
      timeoutMs: 3000,
      maxOutputBytes: 4 * 1024 * 1024,
    }),
  );
  if (result.outcome.reason !== 'exited' || result.outcome.code !== 0)
    throw new Error('Codex process probe failed');
  const processes = new Map<number, CodexProcess>();
  for (const line of result.lines) {
    const match = /^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match || match[3] !== 'codex') continue;
    const elapsed = parseElapsed(match[2]!);
    if (elapsed === undefined) continue;
    const pid = Number(match[1]);
    processes.set(pid, { pid, startedAt: now - elapsed, ...classifyCodexCommand(match[4]!) });
  }
  return processes;
}

/** Working directories of the given processes, from one read-only `lsof`. Exited processes are simply missing. */
export async function processDirectories(
  pids: number[],
  runner: ProcessRunner,
  signal: AbortSignal,
): Promise<Map<number, string>> {
  const directories = new Map<number, string>();
  if (!pids.length) return directories;
  const result = await collectProcess(
    runner(lsofPath(), ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')], '', signal, {
      timeoutMs: 3000,
      maxOutputBytes: 256 * 1024,
    }),
  );
  if (result.outcome.reason === 'spawn-error') throw new LsofMissing();
  if (result.outcome.reason !== 'exited' || ![0, 1].includes(result.outcome.code ?? -1))
    throw new Error('Codex client directory probe failed');
  let pid = 0;
  for (const line of result.lines) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid && isAbsolute(line.slice(1)) && !directories.has(pid))
      directories.set(pid, line.slice(1));
  }
  return directories;
}

export interface LockedThread {
  id: string;
  /** Process holding the thread's writer lock. */
  ownerPid: number;
  /** Thread working directory and creation time from native metadata; needed only for daemon-held threads. */
  cwd?: string;
  createdAt?: number;
}
export interface ThreadLiveness {
  open: boolean;
  reason: string;
}
/** For threads Gloss launched: true while the launch's tmux session runs, false once it ended. */
export type LaunchedLiveness = (sessionRef: string) => boolean | undefined;

/**
 * Decides which locked threads are open, in this precedence:
 * 1. A thread Gloss launched is open while its launch's tmux session runs. After the launch ended, only
 *    an exact signal (a terminal client holding the lock, or `codex resume <id>`) reopens it.
 * 2. A lock held by a terminal client itself (not the daemon) is open.
 * 3. A daemon-held lock is open only when a live terminal client is attached: `codex resume <id>` names it exactly,
 *    or a client running in the thread's folder started before the thread was created. A client can show one thread
 *    at a time, so each client claims at most one thread (the newest it could have created). Anything else is closed.
 */
export function decideLiveness(
  threads: LockedThread[],
  processes: ReadonlyMap<number, CodexProcess>,
  directories: ReadonlyMap<number, string>,
  launched?: LaunchedLiveness,
): Map<string, ThreadLiveness> {
  const result = new Map<string, ThreadLiveness>();
  const lockOwners = new Set(threads.map((t) => t.ownerPid));
  // Clients of the daemon: terminal clients that do not hold a writer lock of their own.
  const clients = [...processes.values()].filter(
    (p) => p.role === 'client' && !lockOwners.has(p.pid),
  );
  const resumed = new Set(clients.flatMap((c) => (c.resume ? [c.resume] : [])));
  const daemonHeld: LockedThread[] = [];
  for (const thread of threads) {
    const owner = processes.get(thread.ownerPid);
    const exact = owner?.role === 'client' || (owner?.role === 'daemon' && resumed.has(thread.id));
    const launch = launched?.(thread.id);
    if (launch === true)
      result.set(thread.id, { open: true, reason: 'Launched session is running' });
    else if (exact)
      result.set(thread.id, {
        open: true,
        reason:
          owner?.role === 'client'
            ? 'Terminal client holds the session'
            : 'Terminal client resumed the session',
      });
    else if (launch === false)
      result.set(thread.id, { open: false, reason: 'Launched session has ended' });
    else if (owner?.role === 'daemon') daemonHeld.push(thread);
    else result.set(thread.id, { open: false, reason: 'No Codex process holds the session' });
  }
  // Folder and time: newest clients first, each taking the newest unclaimed thread it could have started.
  const folder = (client: CodexProcess) => {
    const cwd = directories.get(client.pid);
    if (!cwd) return undefined;
    return client.cd ? resolve(cwd, client.cd) : cwd;
  };
  const pool = daemonHeld
    .filter((t) => t.cwd && t.createdAt !== undefined && !resumed.has(t.id))
    .sort((a, b) => b.createdAt! - a.createdAt! || a.id.localeCompare(b.id));
  const claimed = new Set<string>();
  for (const client of clients
    .filter((c) => !c.resume)
    .sort((a, b) => b.startedAt - a.startedAt || a.pid - b.pid)) {
    const where = folder(client);
    if (!where) continue;
    const thread = pool.find(
      (t) =>
        !claimed.has(t.id) &&
        t.cwd === where &&
        t.createdAt! >= client.startedAt - ATTACH_CLOCK_SKEW_MS,
    );
    if (thread) claimed.add(thread.id);
  }
  for (const thread of daemonHeld) {
    result.set(
      thread.id,
      claimed.has(thread.id)
        ? { open: true, reason: 'Terminal client attached in the session folder' }
        : {
            open: false,
            reason: 'No Codex terminal is attached; the shared app-server only keeps it loaded',
          },
    );
  }
  return result;
}

/** Probes processes (and, when the daemon holds locks, client folders) and decides liveness for the locked threads. */
export async function resolveLiveness(
  threads: LockedThread[],
  options: { runner: ProcessRunner; signal: AbortSignal; now: number; launched?: LaunchedLiveness },
): Promise<Map<string, ThreadLiveness>> {
  if (!threads.length) return new Map();
  // lsof reports real paths; compare thread folders the same way.
  threads = await Promise.all(
    threads.map(async (t) =>
      t.cwd ? { ...t, cwd: await realpath(t.cwd).catch(() => t.cwd!) } : t,
    ),
  );
  const processes = await codexProcesses(options.runner, options.signal, options.now);
  const needsFolders = threads.some((t) => processes.get(t.ownerPid)?.role === 'daemon');
  const lockOwners = new Set(threads.map((t) => t.ownerPid));
  const directories = needsFolders
    ? await processDirectories(
        [...processes.values()]
          .filter((p) => p.role === 'client' && !lockOwners.has(p.pid) && !p.resume)
          .map((p) => p.pid),
        options.runner,
        options.signal,
      )
    : new Map<number, string>();
  for (const [pid, directory] of directories)
    directories.set(pid, await realpath(directory).catch(() => directory));
  return decideLiveness(threads, processes, directories, options.launched);
}
