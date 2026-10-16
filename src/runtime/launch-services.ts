import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { AgentAdapter, AgentKind, Target } from '../core/contracts.js';
import type { LanguageOverride } from '../core/language-settings.js';
import type { SessionStore } from '../core/session-contracts.js';
import { createAttentionMonitor } from './attention-monitor.js';
import { createClaudeExecutable } from './claude-config.js';
import { collectProcess, runProcess, type ProcessRunner } from './process-runner.js';
import type { OpenSessionCandidate } from '../core/session-catalog.js';
import {
  createSessionLauncher,
  defaultShell,
  type LaunchRecord,
  type LaunchStore,
} from './session-launcher.js';
import type { SessionManager } from './session-manager.js';
import { createTerminalBridge } from './terminal-bridge.js';
import { createTmux, sessionNameFor, type Tmux } from './tmux.js';
import { insideFolderReal } from './worktrees.js';
import type { GlossTerminal } from '../agents/claude/tmux-delivery.js';

const MAX_ANCESTRY = 16;

/** True when `pid` is `ancestor` or a descendant of it, walking `ps` at most 16 levels up. */
export async function descendsFrom(
  pid: number,
  ancestor: number,
  runner: ProcessRunner,
  signal: AbortSignal,
): Promise<boolean> {
  let current = pid;
  for (let level = 0; level <= MAX_ANCESTRY; level += 1) {
    if (current === ancestor) return true;
    if (level === MAX_ANCESTRY || signal.aborted || !Number.isInteger(current) || current <= 1)
      return false;
    const result = await collectProcess(
      runner('/bin/ps', ['-o', 'ppid=', '-p', String(current)], '', signal, {
        timeoutMs: 2000,
        maxOutputBytes: 1024,
      }),
    );
    const parent = Number(result.lines.join('').trim());
    if (result.outcome.code !== 0 || !Number.isInteger(parent) || parent <= 0 || parent === current)
      return false;
    current = parent;
  }
  return false;
}

/** A thread may be created slightly before the launch is recorded (clocks, write order). */
export const LAUNCH_CLOCK_SKEW_MS = 2000;

/**
 * Matches a launched Codex session by folder and creation time, for Codex versions whose conversations run in a
 * shared app-server daemon (so the writer is not a descendant of the launch's pane). A thread belongs to a launch
 * when it is open in the launch's folder, was created at or after the launch (less a small skew), and no other launch
 * or launch-owned panel already has it. Launches waiting in the same folder take threads in launch order: the
 * earliest launch gets the earliest thread.
 */
export function matchCodexByFolderTime(
  launch: LaunchRecord,
  candidates: readonly OpenSessionCandidate[],
  launches: readonly LaunchRecord[],
  claimed: ReadonlySet<string>,
  skewMs = LAUNCH_CLOCK_SKEW_MS,
): Target | undefined {
  const pool = candidates
    .filter(
      (c) =>
        c.support === 'supported' &&
        c.target.agent === 'codex' &&
        c.createdAt !== undefined &&
        c.target.projectId === launch.folder &&
        !claimed.has(c.target.sessionRef),
    )
    .sort(
      (a, b) =>
        a.createdAt! - b.createdAt! || a.target.sessionRef.localeCompare(b.target.sessionRef),
    );
  const waiting = launches
    .filter(
      (l) =>
        l.agent === 'codex' &&
        l.state !== 'ended' &&
        !l.sessionRef &&
        !l.panelSessionId &&
        l.folder === launch.folder &&
        l.id !== launch.id,
    )
    .concat(launch)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (const waiter of waiting) {
    const index = pool.findIndex((c) => c.createdAt! >= waiter.createdAt - skewMs);
    if (index < 0) {
      if (waiter.id === launch.id) return undefined;
      continue;
    }
    const [taken] = pool.splice(index, 1);
    if (waiter.id === launch.id) return taken!.target;
  }
  return undefined;
}

/** Native Codex sessions already owned by another launch, directly or through that launch's registered panel. */
export function claimedCodexRefs(
  launch: LaunchRecord,
  launches: readonly LaunchRecord[],
  sessions: readonly { id: string; target: Target }[],
): Set<string> {
  const claimed = new Set<string>();
  for (const other of launches) {
    if (other.id === launch.id || other.agent !== 'codex') continue;
    if (other.sessionRef) claimed.add(other.sessionRef);
    const panel = other.panelSessionId
      ? sessions.find((s) => s.id === other.panelSessionId)
      : undefined;
    if (panel?.target.agent === 'codex') claimed.add(panel.target.sessionRef);
  }
  return claimed;
}

/** Launches of `agent` that own a session, directly or through their registered panel, in any state. */
function owningLaunches(
  agent: 'claude' | 'codex',
  sessionRef: string,
  launches: readonly LaunchRecord[],
  sessions: readonly { id: string; target: Target }[],
): LaunchRecord[] {
  return launches.filter(
    (l) =>
      l.agent === agent &&
      (l.sessionRef === sessionRef ||
        (l.panelSessionId !== undefined &&
          sessions.some(
            (s) =>
              s.id === l.panelSessionId &&
              s.target.agent === agent &&
              s.target.sessionRef === sessionRef,
          ))),
  );
}

/**
 * Liveness of a Codex thread Gloss launched: true while any launch that owns it (directly or through its
 * registered panel) still runs in tmux, false once all of them ended, undefined for threads it never launched.
 * The launcher's watch moves launches whose tmux session is gone to ended.
 */
export function launchedCodexLiveness(
  sessionRef: string,
  launches: readonly LaunchRecord[],
  sessions: readonly { id: string; target: Target }[],
): boolean | undefined {
  const owning = owningLaunches('codex', sessionRef, launches, sessions);
  return owning.length ? owning.some((l) => l.state !== 'ended') : undefined;
}

/** The one live Claude launch owning a session, directly or through its panel; none when absent or ambiguous. */
export function claudeLaunchFor(
  sessionRef: string,
  launches: readonly LaunchRecord[],
  sessions: readonly { id: string; target: Target }[],
): LaunchRecord | undefined {
  const live = owningLaunches('claude', sessionRef, launches, sessions).filter(
    (l) => l.state !== 'ended',
  );
  return live.length === 1 ? live[0] : undefined;
}

/** The Claude adapter's view of the tmux pane a launch runs in. */
export function glossTerminalFor(
  tmux: Tmux,
  launch: Pick<LaunchRecord, 'id' | 'panePid'>,
): GlossTerminal {
  const name = sessionNameFor(launch.id);
  return {
    launchId: launch.id,
    panePid: launch.panePid,
    capture: () => tmux.capturePaneStyled(name),
    cursor: () => tmux.paneCursor(name),
    loadBuffer: (buffer, text) => tmux.loadBuffer(buffer, text),
    pasteBuffer: (buffer) => tmux.pasteBuffer(name, buffer),
    deleteBuffer: (buffer) => tmux.deleteBuffer(buffer),
    pressEnter: () => tmux.sendKeys(name, ['Enter']),
  };
}

/** Caches the tmux promise; a failure is forgotten so a later launch retries (for example after installing tmux). */
export function cachedTmux(create: () => Promise<Tmux> = () => createTmux()): () => Promise<Tmux> {
  let cached: Promise<Tmux> | undefined;
  return () => {
    if (!cached) {
      const attempt = create();
      cached = attempt;
      attempt.catch(() => {
        if (cached === attempt) cached = undefined;
      });
    }
    return cached;
  };
}

export const parseVersion = (text: string) => /\d+\.\d+\.\d+/.exec(text)?.[0];

export function createLaunchApplyLanguage(
  store: { writeLanguageOverride?(id: string, override: LanguageOverride | null): void },
  sessions: { refreshLanguageSettings(id?: string): void },
  catalog: { refresh(): void },
) {
  return async (panelId: string, override: LanguageOverride) => {
    if (!store.writeLanguageOverride) throw new Error('Language settings unavailable');
    store.writeLanguageOverride(panelId, override);
    sessions.refreshLanguageSettings(panelId);
    catalog.refresh();
  };
}

async function findOnPath(name: string): Promise<string> {
  const directories = [
    join(homedir(), '.local', 'bin'),
    ...(process.env.PATH ?? '').split(':').filter(isAbsolute),
  ].filter((directory) => !/(?:^|\/)\.superset(?:-[^/]*)?\/bin\/?$/.test(directory));
  for (const directory of directories) {
    try {
      const candidate = join(directory, name);
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      /* Next PATH entry. */
    }
  }
  throw new Error(`${name} executable unavailable`);
}

/** Folders the user picked in the folder browser; filled by the picker route. */
export const approvedFolders = new Set<string>();
/** A folder may be launched in when the user picked it, or a registered or discovered session uses it (compared by real path). */
export async function knownFolder(
  folder: string,
  sessionFolders: (string | undefined)[],
): Promise<boolean> {
  if (approvedFolders.has(folder)) return true;
  const candidates = [
    ...new Set(sessionFolders.filter((f): f is string => typeof f === 'string' && isAbsolute(f))),
  ];
  if (candidates.includes(folder)) return true;
  for (const candidate of candidates)
    if ((await realpath(candidate).catch(() => undefined)) === folder) return true;
  return false;
}

export function createLaunchServices(options: {
  store: LaunchStore &
    Pick<SessionStore, 'listSessions'> & { listConnectedFolders?(): { path: string }[] } & {
      writeLanguageOverride?(id: string, override: LanguageOverride | null): void;
    };
  codex: AgentAdapter;
  application: () => {
    sessions?: SessionManager;
    catalog?: {
      refresh(): void;
      snapshot?(): { entries: { target: Target; worktreePath?: string }[] };
    };
  };
  tmux?: () => Promise<Tmux>;
  runner?: ProcessRunner;
}) {
  const tmux = options.tmux ?? cachedTmux();
  const runner = options.runner ?? runProcess;
  const live = () => options.application();
  const launcher = createSessionLauncher({
    shell: defaultShell(),
    tmux,
    store: options.store,
    sessions: { register: (...args) => live().sessions!.register(...args) },
    claudeExecutable: createClaudeExecutable(),
    async findCodex(launch, signal): Promise<Target | undefined> {
      // A cached probe from before the launch cannot contain its thread.
      const scan = await options.codex.discoverOpen?.(signal, { fresh: true });
      const launches = launcher.list();
      const claimed = claimedCodexRefs(launch, launches, options.store.listSessions());
      const candidates = (scan?.candidates ?? []).filter(
        (c) => c.support === 'supported' && !claimed.has(c.target.sessionRef),
      );
      // Exact first: a writer running under the launch's own pane. Threads created before the launch cannot be its own; skip their probes.
      for (const candidate of candidates) {
        if (
          candidate.nativePid === undefined ||
          (candidate.createdAt !== undefined &&
            candidate.createdAt < launch.createdAt - LAUNCH_CLOCK_SKEW_MS)
        )
          continue;
        if (await descendsFrom(candidate.nativePid, launch.panePid, runner, signal))
          return candidate.target;
      }
      // Codex app-server daemon: the writer is shared, so match by folder and creation time.
      return matchCodexByFolderTime(launch, candidates, launches, claimed);
    },
    resolveExecutable: () => findOnPath('codex'),
    knownFolder: (folder) =>
      knownFolder(folder, [
        ...(options.store.listConnectedFolders?.().map((f) => f.path) ?? []),
        ...options.store
          .listSessions()
          .flatMap((r) => [r.target.projectId, r.worktreePath, r.canonicalRoot]),
        ...(live().catalog?.snapshot?.().entries ?? []).flatMap((e) => [
          e.worktreePath,
          e.target.projectId,
        ]),
      ]),
    applyLanguage: (panelId, override) => {
      const app = live();
      return createLaunchApplyLanguage(
        options.store,
        app.sessions!,
        app.catalog ?? { refresh() {} },
      )(panelId, override);
    },
  });
  const terminals = createTerminalBridge({ tmux, launches: () => launcher.list() });
  const attention = createAttentionMonitor({
    tmux,
    launches: () => launcher.list(),
    async agentVersion(agent: AgentKind) {
      const executable = await findOnPath(agent);
      const result = await collectProcess(
        runner(executable, ['--version'], '', AbortSignal.timeout(5000), {
          timeoutMs: 4000,
          maxOutputBytes: 8192,
          maxDiagnosticBytes: 1024,
        }),
      );
      return parseVersion(result.lines.join('\n'));
    },
  });
  // Includes launches in subfolders: removing a folder must not run under a live agent.
  const endLaunchesInFolder = async (folder: string) => {
    const live = launcher.list().filter((l) => l.state !== 'ended');
    const inside = await Promise.all(live.map((l) => insideFolderReal(l.folder, folder)));
    await Promise.all(live.filter((_, i) => inside[i]).map((l) => launcher.end(l.id)));
  };
  /** Gloss's own pane for a Claude session, while its tmux session lives. */
  const glossTerminal = async (sessionRef: string): Promise<GlossTerminal | undefined> => {
    const launch = claudeLaunchFor(sessionRef, launcher.list(), options.store.listSessions());
    if (!launch) return undefined;
    const current = await tmux();
    return (await current.hasSession(sessionNameFor(launch.id)))
      ? glossTerminalFor(current, launch)
      : undefined;
  };
  return {
    launcher,
    terminals,
    attention,
    approveFolder: (folder: string) => {
      approvedFolders.add(folder);
    },
    endLaunchesInFolder,
    launchedCodexLive: (sessionRef: string) =>
      launchedCodexLiveness(sessionRef, launcher.list(), options.store.listSessions()),
    glossTerminal,
  };
}
