import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import type { AgentKind, Target } from '../core/contracts.js';
import { validateLanguageOverride, type LanguageOverride } from '../core/language-settings.js';
import { UNSAFE_COMMAND_CHARACTER, MAX_RUN_COMMAND_LENGTH } from '../core/command-text.js';
import type { SessionManager } from './session-manager.js';
import { sessionNameFor, type Tmux } from './tmux.js';
import type { LaunchSettings } from '../core/launch-settings.js';
import { uuid } from '../agents/shared.js';
import {
  glossOwnsSession,
  MOVE_IN_GLOSS_REASON,
  type GlossLaunches,
} from '../agents/claude/move.js';

import {
  CLAUDE_SETUP_PROMPT,
  CODEX_SETUP_PROMPT,
  type LaunchAgent,
  type LaunchState,
} from '../core/session-contracts.js';
export type { LaunchState } from '../core/session-contracts.js';
const MISSING_REASON = 'Session is no longer running';
export interface LaunchRecord {
  id: string;
  agent: LaunchAgent;
  folder: string;
  panePid: number;
  sessionRef?: string;
  panelSessionId?: string;
  languageOverride?: LanguageOverride;
  state: LaunchState;
  reason?: string;
  createdAt: number;
  /** Shell launches only. */
  title?: string;
  originSessionId?: string;
  /** Shell launches only; in-memory, filled by list(). */
  busy?: boolean;
}
export interface LaunchStore {
  listLaunches(): LaunchRecord[];
  putLaunch(record: LaunchRecord): void;
  deleteLaunch(id: string): void;
  readLaunchSettings(): LaunchSettings;
  writeLaunchSettings(settings: LaunchSettings): void;
}
/** What `resume` starts, as checked by `prepareResume`; only an object `prepareResume` returned is accepted, once. */
export interface PreparedResume {
  readonly sessionRef: string;
  readonly cwd: string;
  readonly argv: readonly string[];
}
export interface SessionLauncher {
  launch(input: {
    agent: LaunchAgent;
    folder: string;
    languageOverride?: LanguageOverride;
    prompt?: string;
  }): Promise<LaunchRecord>;
  /**
   * Everything reopening an existing Claude session needs, checked before anything is closed: a valid id, a known
   * folder, the Claude executable, tmux, an open launcher and no Gloss launch owning the session. Throws otherwise.
   */
  prepareResume(input: { sessionRef: string; folder: string }): Promise<PreparedResume>;
  /** Reopens the prepared session in Gloss's tmux with `claude --resume <id>`: no first message, no channel flags. */
  resume(prepared: PreparedResume): Promise<LaunchRecord>;
  /** Types a command into the folder's idle terminal, starting one when none is free. Never runs anything by itself. */
  run(input: {
    folder: string;
    command: string;
    originSessionId?: string;
  }): Promise<{ launch: LaunchRecord; reused: boolean; typed: boolean }>;
  list(): LaunchRecord[];
  reconcile(): Promise<void>;
  end(launchId: string): Promise<void>;
  /** Retries connecting a launch that has no panel yet. */
  identify(launchId: string): Promise<void>;
  /** Discovery saw a new native session of this agent: retry launches of that agent that gave up connecting. */
  noticeDiscovery(agent: AgentKind): void;
  /** Re-checks tmux periodically so sessions that exit on their own move to Saved. */
  watch(): void;
  subscribe(listener: (records: LaunchRecord[]) => void): () => void;
  close(): void;
}
/**
 * Disclosed setup prompt for a new Codex launch. Codex creates its thread only on the first prompt, so without it the
 * app could not connect until the user typed in the terminal. It costs one model request.
 */
export { CODEX_SETUP_PROMPT } from '../core/session-contracts.js';
/** Identification attempts back off (1 s, 5 s, 15 s) and then stop instead of polling. */
export const IDENTIFY_RETRY_DELAYS_MS = [1000, 5000, 15000];
/** Pause between the two Ctrl+C presses End sends. */
const EXIT_KEY_GAP_MS = 300;
/** After asking a session to exit, poll this often, this many times, before killing it. */
const EXIT_POLL_MS = 500;
const EXIT_POLL_ATTEMPTS = 20;
/** Step between readiness checks while a new session starts. */
const READY_POLL_MS = 100;
const MAX_ORIGIN_SESSION_ID_CHARS = 128;
export const MAX_PROMPT_LENGTH = 4000;
/** A first message typed into the New session dialog; absent means the disclosed default. */
export function validatePrompt(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('Invalid first message');
  const text = value.trim();
  if (!text || text.length > MAX_PROMPT_LENGTH) throw new Error('Invalid first message');
  return text;
}
/** Text typed into a terminal by Run: literal, trailing newlines dropped (Enter is added by tmux). */
export function validateCommand(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid command');
  const text = value.replace(/[\r\n]+$/, '');
  if (!text.trim() || text.length > MAX_RUN_COMMAND_LENGTH || UNSAFE_COMMAND_CHARACTER.test(text))
    throw new Error('Invalid command');
  return text;
}
export function defaultShell(env: NodeJS.ProcessEnv = process.env): string {
  const shell = env.SHELL;
  return shell && isAbsolute(shell) ? shell : '/bin/zsh';
}
const TITLE = /^Terminal(?: (\d+))?$/;
/** Lowest free number among live terminals of one folder: Terminal, Terminal 2, Terminal 3 … */
export function nextTerminalTitle(existing: string[]): string {
  const used = new Set(
    existing.map((t) => {
      const m = TITLE.exec(t);
      return m ? Number(m[1] ?? 1) : 0;
    }),
  );
  let n = 1;
  while (used.has(n)) n++;
  return n === 1 ? 'Terminal' : `Terminal ${n}`;
}

/** Launches of `agent` that own a session, directly or through their registered panel, in any state. */
export function owningLaunches(
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

/** The Claude launches owning a session, with whether each ended one's tmux pane still runs (live ones aren't asked). */
export function claudeOwners(
  sessionRef: string,
  launches: readonly LaunchRecord[],
  sessions: readonly { id: string; target: Target }[],
  paneAlive: (launchId: string) => Promise<boolean>,
): Promise<GlossLaunches['owners']> {
  return Promise.all(
    owningLaunches('claude', sessionRef, launches, sessions).map(async (launch) => ({
      state: launch.state,
      paneAlive: launch.state === 'ended' && (await paneAlive(launch.id)),
    })),
  );
}

export function createSessionLauncher(options: {
  tmux: () => Promise<Tmux>;
  store: LaunchStore;
  sessions: Pick<SessionManager, 'register'>;
  /** Registered panels, to tell which launches own a native session through their panel. */
  panels(): readonly { id: string; target: Target }[];
  /** The verified Claude executable. Launches need no channel setup: Gloss types into their tmux pane. */
  claudeExecutable(): Promise<string>;
  /** Finds the native Codex session a launch started: by process ancestry first, then by folder and creation time. */
  findCodex(launch: LaunchRecord, signal: AbortSignal): Promise<Target | undefined>;
  resolveExecutable(name: 'codex'): Promise<string>;
  knownFolder(folder: string): Promise<boolean>;
  applyLanguage?(panelId: string, override: LanguageOverride): void | Promise<void>;
  /** The marker table for the installed agent version, used to make sure End never answers a prompt. */
  shell?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  identifyTimeoutMs?: number;
  watchIntervalMs?: number;
  readyTimeoutMs?: number;
  /** Waits between identification attempts; after the last one the launch shows as not connected until Retry or new discovery. */
  retryDelaysMs?: number[];
}): SessionLauncher {
  const now = options.now ?? Date.now;
  const shell = options.shell ?? defaultShell();
  const shellName = basename(shell);
  const readyTimeoutMs = options.readyTimeoutMs ?? 5000;
  const busy = new Map<string, boolean>();
  const preparedResumes = new WeakSet<PreparedResume>();
  /** Sessions whose resume is between its ownership check and its recorded launch. */
  const resuming = new Set<string>();
  const list = (): LaunchRecord[] =>
    options.store
      .listLaunches()
      .map((r) => (r.agent === 'shell' ? { ...r, busy: busy.get(r.id) ?? false } : r));
  const notify = () => {
    if (!closed)
      for (const listener of listeners) {
        try {
          listener(list());
        } catch {
          /* Subscribers do not control launch lifecycle. */
        }
      }
  };
  const sleep = options.sleep ?? ((ms) => delay(ms));
  const timeoutMs = options.identifyTimeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error('Invalid identification timeout');
  const retryDelays = options.retryDelaysMs ?? IDENTIFY_RETRY_DELAYS_MS;
  const listeners = new Set<(records: LaunchRecord[]) => void>();
  const identification = new Map<string, AbortController>();
  const ending = new Map<string, Promise<void>>();
  /** One set per reconcile in flight: the shells started since its tmux listing began. */
  const listings = new Set<Set<string>>();
  let closed = false;
  let watcher: ReturnType<typeof setInterval> | undefined;
  const requireOpen = () => {
    if (closed) throw new Error('Session launcher is closed');
  };
  const get = (id: string) => {
    const record = options.store.listLaunches().find((r) => r.id === id);
    if (!record) throw Object.assign(new Error('Unknown launch'), { code: 'unknown-session' });
    return record;
  };
  const put = (record: LaunchRecord) => {
    options.store.putLaunch(record);
    notify();
  };
  const cancel = (id: string) => {
    identification.get(id)?.abort();
    identification.delete(id);
  };
  const active = (id: string, controller: AbortController) =>
    !closed && !controller.signal.aborted && !ending.has(id) && get(id).state !== 'ended';
  // Bound even dependencies that ignore cancellation. Their late results are never persisted.
  function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        cleanup();
        reject(new Error('Identification cancelled'));
      };
      const cleanup = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }
  async function validFolder(folder: string) {
    if (typeof folder !== 'string' || !isAbsolute(folder))
      throw new Error('Choose a project folder');
    try {
      const canonical = await realpath(folder);
      if ((await stat(canonical)).isDirectory() && (await options.knownFolder(canonical)))
        return canonical;
    } catch {
      /* Present a stable validation error for unavailable paths. */
    }
    throw new Error('Choose a project folder');
  }
  async function connect(id: string, target: Target, controller: AbortController) {
    if (!active(id, controller)) return;
    if (target.agent !== get(id).agent || target.projectId !== get(id).folder || !target.sessionRef)
      throw new Error('Launch target identity mismatch');
    const panel = await cancellable(
      options.sessions.register(target, undefined, controller.signal),
      controller.signal,
    );
    if (!active(id, controller)) return;
    const record = get(id);
    if (record.languageOverride && Object.keys(record.languageOverride).length) {
      try {
        if (!options.applyLanguage) throw new Error('Language settings unavailable');
        await cancellable(
          Promise.resolve(options.applyLanguage(panel.id, record.languageOverride)),
          controller.signal,
        );
      } catch (error) {
        if (active(id, controller))
          put({
            ...get(id),
            sessionRef: target.sessionRef,
            panelSessionId: panel.id,
            state: 'unidentified',
            reason: 'Started, language settings not applied',
          });
        throw error;
      }
    }
    if (!active(id, controller)) return;
    const { reason: _reason, ...current } = get(id);
    // Running once the panel is registered: from here the tab is a normal session row, and its
    // route line shows how Gloss reaches it (its own terminal while this pane runs the session).
    put({ ...current, sessionRef: target.sessionRef, panelSessionId: panel.id, state: 'running' });
  }
  function identify(id: string, firstAttempt?: () => void): Promise<void> {
    if (closed || ending.has(id) || identification.has(id) || get(id).state === 'ended')
      return Promise.resolve();
    const controller = new AbortController();
    identification.set(id, controller);
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      controller.abort();
    }, timeoutMs);
    const started = performance.now();
    const task = (async () => {
      let waited = 0;
      let attempt = 0;
      try {
        while (active(id, controller)) {
          const record = get(id);
          let target: Target | undefined;
          if (record.agent !== 'shell' && record.sessionRef)
            target = {
              agent: record.agent,
              sessionRef: record.sessionRef,
              projectId: record.folder,
            };
          else
            target = await cancellable(
              options.findCodex(record, controller.signal),
              controller.signal,
            ).catch(() => undefined);
          if (!active(id, controller)) break;
          if (target) {
            // A new Claude session writes no transcript until its first prompt lands; keep retrying within the budget.
            try {
              await connect(id, target, controller);
              return;
            } catch (error) {
              if (!/transcript pointer/i.test(error instanceof Error ? error.message : ''))
                throw error;
              firstAttempt?.();
              firstAttempt = undefined;
            }
          }
          // Back off between attempts, then stop: a later Retry or newly discovered session restarts identification.
          const remaining = timeoutMs - Math.max(waited, performance.now() - started);
          if (remaining <= 0 || attempt >= retryDelays.length) {
            expired = true;
            break;
          }
          const delay = Math.min(retryDelays[attempt++]!, remaining);
          await cancellable(sleep(delay), controller.signal);
          // An injected immediate sleep still consumes the polling budget.
          waited += delay;
        }
      } catch {
        if (active(id, controller) && get(id).reason !== 'Started, language settings not applied')
          put({ ...get(id), state: 'unidentified', reason: 'Started, not connected' });
      } finally {
        firstAttempt?.();
        clearTimeout(timer);
        if (identification.get(id) === controller) identification.delete(id);
        if (expired && !closed && !ending.has(id) && get(id).state !== 'ended')
          put({ ...get(id), state: 'unidentified', reason: 'Started, not connected' });
        controller.abort();
      }
    })();
    return task;
  }
  // retry: also restart identification for launches without a panel (startup and explicit reconcile only;
  // the periodic watch only notices sessions that ended).
  async function reconcile(retry: boolean) {
    requireOpen();
    // Shells started while this listing is in flight may be missing from it: they are skipped, never deleted.
    const startedSince = new Set<string>();
    listings.add(startedSince);
    try {
      await reconcileListed(retry, startedSince);
    } finally {
      listings.delete(startedSince);
    }
  }
  async function reconcileListed(retry: boolean, startedSince: Set<string>) {
    let live: Map<string, { panePid: number; currentCommand: string }>;
    try {
      live = new Map(
        (await (await options.tmux()).listSessions()).map((s) => [
          s.name,
          { panePid: s.panePid, currentCommand: s.currentCommand },
        ]),
      );
    } catch {
      return;
    } // A failed listing gives no evidence that sessions ended.
    if (closed) return;
    let busyChanged = false;
    for (const record of options.store.listLaunches()) {
      if (ending.has(record.id) || startedSince.has(record.id)) continue;
      const pane = live.get(sessionNameFor(record.id));
      const panePid = pane?.panePid;
      if (record.state === 'ended') {
        // A launch marked missing while its tmux session lives on (a listing gap around a restart) is adopted back;
        // launches ended on purpose stay ended.
        if (panePid !== undefined && record.reason === MISSING_REASON) {
          const kept = { ...get(record.id) };
          delete kept.reason;
          if (kept.agent === 'shell') {
            busy.set(kept.id, pane!.currentCommand !== shellName);
            put({ ...kept, panePid, state: 'running' });
            continue;
          }
          put({ ...kept, panePid, state: kept.panelSessionId ? 'running' : 'starting' });
          if (!kept.panelSessionId) void identify(record.id);
        } else if (record.agent === 'shell') {
          options.store.deleteLaunch(record.id);
          busy.delete(record.id);
          notify();
        }
        continue;
      }
      if (panePid === undefined) {
        // A shell that exited is gone for good: no Saved entry, no history (spec: deleted on that reconcile).
        if (record.agent === 'shell') {
          options.store.deleteLaunch(record.id);
          busy.delete(record.id);
          notify();
          continue;
        }
        cancel(record.id);
        put({ ...get(record.id), state: 'ended', reason: MISSING_REASON });
        continue;
      }
      if (record.agent === 'shell') {
        const next = pane!.currentCommand !== shellName;
        if (busy.get(record.id) !== next) {
          busy.set(record.id, next);
          busyChanged = true;
        }
        if (record.panePid !== panePid) put({ ...get(record.id), panePid });
        continue;
      }
      const moved = record.panePid !== panePid;
      if (moved) {
        cancel(record.id);
        put({ ...get(record.id), panePid });
      }
      if ((retry || moved) && (!record.panelSessionId || record.state === 'unidentified'))
        void identify(record.id);
    }
    if (busyChanged) notify();
  }
  // End must never answer a native prompt, so it never sends Enter or typed text: Ctrl+C twice cancels a prompt
  // or clears input and never selects a menu option. A session that survives is killed.
  async function askToExit(tmux: Tmux, name: string) {
    await tmux.sendKeys(name, ['C-c']);
    await sleep(EXIT_KEY_GAP_MS);
    await tmux.sendKeys(name, ['C-c']);
  }
  const liveShells = (folder: string) =>
    list().filter(
      (r) => r.agent === 'shell' && r.state !== 'ended' && !ending.has(r.id) && r.folder === folder,
    );
  async function startShell(
    tmux: Tmux,
    cwd: string,
    originSessionId?: string,
  ): Promise<LaunchRecord> {
    const id = randomUUID();
    const title = nextTerminalTitle(liveShells(cwd).map((r) => r.title ?? 'Terminal'));
    for (const startedSince of listings) startedSince.add(id);
    const { panePid } = await tmux.newSession(sessionNameFor(id), cwd, [shell, '-l'], {
      ELECTRON_RUN_AS_NODE: '',
    });
    busy.set(id, false);
    put({
      id,
      agent: 'shell',
      folder: cwd,
      panePid,
      state: 'running',
      createdAt: now(),
      title,
      ...(originSessionId ? { originSessionId } : {}),
    });
    return list().find((r) => r.id === id)!;
  }
  /** Starts an agent's tmux session and records the launch; a Claude launch waits for its first identification attempt. */
  async function startAgent(
    tmux: Tmux,
    input: {
      agent: 'claude' | 'codex';
      cwd: string;
      argv: string[];
      sessionRef?: string | undefined;
      language?: LanguageOverride | undefined;
    },
  ): Promise<LaunchRecord> {
    requireOpen();
    const id = randomUUID();
    // A reconcile listing already in flight cannot contain this session: it must not end it as missing.
    for (const startedSince of listings) startedSince.add(id);
    const { panePid } = await tmux.newSession(sessionNameFor(id), input.cwd, input.argv, {
      ELECTRON_RUN_AS_NODE: '',
    });
    const record: LaunchRecord = {
      id,
      agent: input.agent,
      folder: input.cwd,
      panePid,
      state: 'starting',
      createdAt: now(),
      ...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
      ...(input.language ? { languageOverride: input.language } : {}),
    };
    put(record);
    if (input.agent === 'claude')
      await new Promise<void>((done) => {
        void identify(id, done).finally(done);
      });
    else void identify(id);
    return get(id);
  }
  /** Spec 5 / C1: a Claude launch owns the session (directly or through its panel) unless it ended and its pane is gone. */
  async function requireNotInGloss(tmux: Tmux, sessionRef: string) {
    const owners = await claudeOwners(
      sessionRef,
      options.store.listLaunches(),
      options.panels(),
      (launchId) => tmux.hasSession(sessionNameFor(launchId)),
    );
    if (glossOwnsSession({ owners })) throw new Error(MOVE_IN_GLOSS_REASON);
  }
  return {
    async launch({ agent, folder, languageOverride, prompt }) {
      requireOpen();
      if (agent !== 'claude' && agent !== 'codex' && agent !== 'shell')
        throw new Error('Unsupported agent');
      const firstMessage = agent === 'shell' ? undefined : validatePrompt(prompt);
      const language =
        languageOverride === undefined ? undefined : validateLanguageOverride(languageOverride);
      if (language && Object.keys(language).length && !options.applyLanguage)
        throw new Error('Language settings unavailable');
      const cwd = await validFolder(folder);
      const tmux = await options.tmux();
      if (agent === 'shell') return startShell(tmux, cwd);
      const extra = options.store.readLaunchSettings().extraArgs[agent];
      let sessionRef: string | undefined;
      let argv: string[];
      if (agent === 'claude') {
        const claude = await options.claudeExecutable();
        sessionRef = randomUUID();
        // No MCP config and no development-channel flag: Gloss delivers by typing into this tmux pane.
        // The prompt goes last, after `--`, so neither a variadic extra option nor a prompt starting with "-" is misread.
        argv = [
          claude,
          '--session-id',
          sessionRef,
          ...extra,
          '--',
          firstMessage ?? CLAUDE_SETUP_PROMPT,
        ];
      } else {
        // `codex [OPTIONS] -- [PROMPT]`: after `--` an extra option that takes a value cannot swallow the prompt, and a prompt starting with "-" is not read as an option.
        argv = [
          await options.resolveExecutable('codex'),
          ...extra,
          '--',
          firstMessage ?? CODEX_SETUP_PROMPT,
        ];
      }
      return startAgent(tmux, { agent, cwd, argv, sessionRef, language });
    },
    async prepareResume({ sessionRef, folder }) {
      requireOpen();
      if (typeof sessionRef !== 'string' || !uuid.test(sessionRef))
        throw new Error('Invalid session');
      const cwd = await validFolder(folder);
      const tmux = await options.tmux();
      const claude = await options.claudeExecutable();
      const extra = options.store.readLaunchSettings().extraArgs.claude;
      await requireNotInGloss(tmux, sessionRef);
      requireOpen();
      // `--resume <id>` first, so a variadic extra option has nothing of Gloss's to swallow.
      const prepared: PreparedResume = Object.freeze({
        sessionRef,
        cwd,
        argv: Object.freeze([claude, '--resume', sessionRef, ...extra]),
      });
      preparedResumes.add(prepared);
      return prepared;
    },
    async resume(prepared) {
      requireOpen();
      // Single use: a failed start is never repeated with the same preparation.
      if (!preparedResumes.delete(prepared)) throw new Error('Unknown resume');
      const { sessionRef } = prepared;
      // Until this launch is recorded, a concurrent resume of the same session can't see it as an owner.
      if (resuming.has(sessionRef)) throw new Error(MOVE_IN_GLOSS_REASON);
      resuming.add(sessionRef);
      try {
        const tmux = await options.tmux();
        // Time passes between preparing and starting (the outside session closes meanwhile): check ownership again.
        await requireNotInGloss(tmux, sessionRef);
        return await startAgent(tmux, {
          agent: 'claude',
          cwd: prepared.cwd,
          argv: [...prepared.argv],
          sessionRef,
        });
      } finally {
        resuming.delete(sessionRef);
      }
    },
    async run({ folder, command, originSessionId }) {
      requireOpen();
      const text = validateCommand(command);
      const origin =
        originSessionId === undefined
          ? undefined
          : String(originSessionId).slice(0, MAX_ORIGIN_SESSION_ID_CHARS);
      const cwd = await validFolder(folder);
      const tmux = await options.tmux();
      const titleNumber = (r: LaunchRecord) => Number(TITLE.exec(r.title ?? 'Terminal')?.[1] ?? 1);
      const panes = new Map((await tmux.listSessions()).map((s) => [s.name, s.currentCommand]));
      const idle = liveShells(cwd)
        .filter((r) => panes.get(sessionNameFor(r.id)) === shellName)
        .sort((a, b) => titleNumber(a) - titleNumber(b))[0];
      if (idle) {
        busy.set(idle.id, true);
        await tmux.typeText(sessionNameFor(idle.id), text);
        if (origin && get(idle.id).originSessionId !== origin)
          put({ ...get(idle.id), originSessionId: origin });
        else notify();
        return { launch: list().find((r) => r.id === idle.id)!, reused: true, typed: true };
      }
      const launch = await startShell(tmux, cwd, origin);
      const name = sessionNameFor(launch.id);
      let ready = false;
      for (let waited = 0; waited < readyTimeoutMs; waited += READY_POLL_MS) {
        const listed = await tmux.listSessions().catch(() => undefined);
        if (listed) {
          const pane = listed.find((s) => s.name === name);
          if (!pane) break; // The pane is gone: no point waiting.
          if (pane.currentCommand === shellName) {
            ready = true;
            break;
          }
        }
        await sleep(READY_POLL_MS);
      }
      const typed = await tmux.typeText(name, text).then(
        () => ready,
        () => false,
      );
      const current = list().find((r) => r.id === launch.id);
      if (!current) throw new Error('Terminal is no longer running');
      busy.set(launch.id, true);
      notify();
      return { launch: { ...current, busy: true }, reused: false, typed };
    },
    list,
    reconcile: () => reconcile(true),
    identify(launchId) {
      requireOpen();
      const record = get(launchId);
      if (record.agent === 'shell') throw new Error('Terminals have nothing to identify');
      if (record.state === 'ended' || ending.has(launchId))
        throw Object.assign(new Error('Unknown launch'), { code: 'unknown-session' });
      if (record.state === 'unidentified' && !identification.has(launchId)) {
        const { reason: _reason, ...rest } = record;
        put({ ...rest, state: 'starting' });
      }
      return identify(launchId);
    },
    noticeDiscovery(agent) {
      if (closed) return;
      for (const record of options.store.listLaunches()) {
        if (
          record.agent !== agent ||
          record.state !== 'unidentified' ||
          record.panelSessionId ||
          identification.has(record.id) ||
          ending.has(record.id)
        )
          continue;
        void identify(record.id);
      }
    },
    watch() {
      if (closed || watcher) return;
      let running = false;
      watcher = setInterval(() => {
        // Nothing to watch: skip, so a machine without tmux is not probed every few seconds.
        if (running || closed || !options.store.listLaunches().some((r) => r.state !== 'ended'))
          return;
        running = true;
        reconcile(false)
          .catch(() => {})
          .finally(() => {
            running = false;
          });
      }, options.watchIntervalMs ?? 3000);
      (watcher as { unref?: () => void }).unref?.();
    },
    end(launchId) {
      requireOpen();
      const record = get(launchId);
      if (record.state === 'ended') return Promise.resolve();
      const existing = ending.get(launchId);
      if (existing) return existing;
      cancel(launchId);
      const task = (async () => {
        const tmux = await options.tmux();
        const name = sessionNameFor(launchId);
        if (record.agent === 'shell') {
          await tmux.sendKeys(name, ['C-c']).catch(() => undefined);
          await tmux.killSession(name);
          if (await tmux.hasSession(name)) throw new Error('Session is still running');
          busy.delete(launchId);
          put({ ...get(launchId), state: 'ended', reason: 'Ended by you' });
          return;
        }
        const asked = await askToExit(tmux, name).then(
          () => true,
          () => false,
        );
        if (asked)
          for (let i = 0; i < EXIT_POLL_ATTEMPTS && (await tmux.hasSession(name)); i++)
            await sleep(EXIT_POLL_MS);
        if (await tmux.hasSession(name)) {
          await tmux.killSession(name);
          if (await tmux.hasSession(name)) throw new Error('Session is still running');
        }
        put({ ...get(launchId), state: 'ended', reason: 'Ended by you' });
      })().finally(() => ending.delete(launchId));
      ending.set(launchId, task);
      return task;
    },
    subscribe(listener) {
      requireOpen();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      if (watcher) clearInterval(watcher);
      watcher = undefined;
      for (const controller of identification.values()) controller.abort();
      identification.clear();
      listeners.clear();
    },
  };
}
