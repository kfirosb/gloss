import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { AgentKind, Target } from '../core/contracts.js';
import { validateLanguageOverride, type LanguageOverride } from '../core/language-settings.js';
import type { SessionManager } from './session-manager.js';
import { sessionNameFor, type Tmux } from './tmux.js';

import { CLAUDE_SETUP_PROMPT, CODEX_SETUP_PROMPT, type LaunchAgent, type LaunchState, type TerminalView } from '../core/session-contracts.js';
export type { LaunchState } from '../core/session-contracts.js';
const MISSING_REASON = 'Session is no longer running';
export interface LaunchRecord {
  id: string; agent: LaunchAgent; folder: string; panePid: number;
  sessionRef?: string; panelSessionId?: string; languageOverride?: LanguageOverride;
  state: LaunchState; reason?: string; createdAt: number;
  /** Shell launches only. */
  title?: string; originSessionId?: string;
  /** Shell launches only; in-memory, filled by list(). */
  busy?: boolean;
}
export interface LaunchSettings { extraArgs: Record<AgentKind, string[]>; popup: 'auto' | 'current-tab' | 'dot-only'; terminalView: TerminalView }
export interface LaunchStore {
  listLaunches(): LaunchRecord[]; putLaunch(record: LaunchRecord): void; deleteLaunch(id: string): void;
  readLaunchSettings(): LaunchSettings; writeLaunchSettings(settings: LaunchSettings): void;
}
export interface SessionLauncher {
  launch(input: { agent: AgentKind; folder: string; languageOverride?: LanguageOverride }): Promise<LaunchRecord>;
  list(): LaunchRecord[]; reconcile(): Promise<void>; end(launchId: string): Promise<void>;
  /** Retries connecting a launch that has no panel yet. */
  identify(launchId: string): Promise<void>;
  /** Discovery saw a new native session of this agent: retry launches of that agent that gave up connecting. */
  noticeDiscovery(agent: AgentKind): void;
  /** Re-checks tmux periodically so sessions that exit on their own move to Saved. */
  watch(): void;
  subscribe(listener: (records: LaunchRecord[]) => void): () => void; close(): void;
}
/**
 * Disclosed setup prompt for a new Codex launch. Codex creates its thread only on the first prompt, so without it the
 * app could not connect until the user typed in the terminal. It costs one model request.
 */
export { CODEX_SETUP_PROMPT } from '../core/session-contracts.js';
/** Identification attempts back off (1 s, 5 s, 15 s) and then stop instead of polling. */
export const IDENTIFY_RETRY_DELAYS_MS = [1000, 5000, 15000];
export function splitArgs(text: string): string[] {
  const out: string[] = []; let current = ''; let quote: '"' | "'" | undefined; let started = false;
  for (const ch of text) {
    if (quote) { if (ch === quote) quote = undefined; else current += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) { if (started) out.push(current); current = ''; started = false; continue; }
    current += ch; started = true;
  }
  if (quote) throw new Error('Unclosed quote in launch arguments');
  if (started) out.push(current);
  return out;
}

export function createSessionLauncher(options: {
  tmux: () => Promise<Tmux>; store: LaunchStore; sessions: Pick<SessionManager, 'register'>;
  prepareClaude(folder: string): Promise<{ claude: string; mcpConfigPath: string }>;
  /** Finds the native Codex session a launch started: by process ancestry first, then by folder and creation time. */
  findCodex(launch: LaunchRecord, signal: AbortSignal): Promise<Target | undefined>;
  resolveExecutable(name: 'codex'): Promise<string>; knownFolder(folder: string): Promise<boolean>;
  applyLanguage?(panelId: string, override: LanguageOverride): void | Promise<void>;
  /** The marker table for the installed agent version, used to make sure End never answers a prompt. */
  now?: () => number; sleep?: (ms: number) => Promise<void>; identifyTimeoutMs?: number; watchIntervalMs?: number;
  /** Waits between identification attempts; after the last one the launch shows as not connected until Retry or new discovery. */
  retryDelaysMs?: number[];
}): SessionLauncher {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const timeoutMs = options.identifyTimeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid identification timeout');
  const retryDelays = options.retryDelaysMs ?? IDENTIFY_RETRY_DELAYS_MS;
  const listeners = new Set<(records: LaunchRecord[]) => void>();
  const identification = new Map<string, AbortController>();
  const ending = new Map<string, Promise<void>>();
  let closed = false; let watcher: ReturnType<typeof setInterval> | undefined;
  const requireOpen = () => { if (closed) throw new Error('Session launcher is closed'); };
  const get = (id: string) => {
    const record = options.store.listLaunches().find(r => r.id === id);
    if (!record) throw Object.assign(new Error('Unknown launch'), { code: 'unknown-session' });
    return record;
  };
  const put = (record: LaunchRecord) => {
    options.store.putLaunch(record);
    if (!closed) for (const listener of listeners) { try { listener(options.store.listLaunches()); } catch { /* Subscribers do not control launch lifecycle. */ } }
  };
  const cancel = (id: string) => { identification.get(id)?.abort(); identification.delete(id); };
  const active = (id: string, controller: AbortController) => !closed && !controller.signal.aborted && !ending.has(id) && get(id).state !== 'ended';
  // Bound even dependencies that ignore cancellation. Their late results are never persisted.
  function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => { cleanup(); reject(new Error('Identification cancelled')); };
      const cleanup = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }
  async function validFolder(folder: string) {
    if (typeof folder !== 'string' || !isAbsolute(folder)) throw new Error('Choose a project folder');
    try {
      const canonical = await realpath(folder);
      if ((await stat(canonical)).isDirectory() && await options.knownFolder(canonical)) return canonical;
    } catch { /* Present a stable validation error for unavailable paths. */ }
    throw new Error('Choose a project folder');
  }
  async function connect(id: string, target: Target, controller: AbortController) {
    if (!active(id, controller)) return;
    if (target.agent !== get(id).agent || target.projectId !== get(id).folder || !target.sessionRef) throw new Error('Launch target identity mismatch');
    const panel = await cancellable(options.sessions.register(target, undefined, controller.signal), controller.signal);
    if (!active(id, controller)) return;
    const record = get(id);
    if (record.languageOverride && Object.keys(record.languageOverride).length) {
      try {
        if (!options.applyLanguage) throw new Error('Language settings unavailable');
        await cancellable(Promise.resolve(options.applyLanguage(panel.id, record.languageOverride)), controller.signal);
      } catch (error) {
        if (active(id, controller)) put({ ...get(id), sessionRef: target.sessionRef, panelSessionId: panel.id, state: 'unidentified', reason: 'Started, language settings not applied' });
        throw error;
      }
    }
    if (!active(id, controller)) return;
    const { reason: _reason, ...current } = get(id);
    // Running once the panel is registered: from here the tab is a normal session row whose own
    // activity shows whether the channel is still connecting.
    put({ ...current, sessionRef: target.sessionRef, panelSessionId: panel.id, state: 'running' });
  }
  function identify(id: string, firstAttempt?: () => void): Promise<void> {
    if (closed || ending.has(id) || identification.has(id) || get(id).state === 'ended') return Promise.resolve();
    const controller = new AbortController(); identification.set(id, controller);
    let expired = false;
    const timer = setTimeout(() => { expired = true; controller.abort(); }, timeoutMs);
    const started = performance.now();
    const task = (async () => {
      let waited = 0; let attempt = 0;
      try {
        while (active(id, controller)) {
          const record = get(id);
          let target: Target | undefined;
          if (record.agent !== 'shell' && record.sessionRef) target = { agent: record.agent, sessionRef: record.sessionRef, projectId: record.folder };
          else target = await cancellable(options.findCodex(record, controller.signal), controller.signal).catch(() => undefined);
          if (!active(id, controller)) break;
          if (target) {
            // A new Claude session writes no transcript until its first prompt lands; keep retrying within the budget.
            try { await connect(id, target, controller); return; }
            catch (error) { if (!/transcript pointer/i.test(error instanceof Error ? error.message : '')) throw error; firstAttempt?.(); firstAttempt = undefined; }
          }
          // Back off between attempts, then stop: a later Retry or newly discovered session restarts identification.
          const remaining = timeoutMs - Math.max(waited, performance.now() - started);
          if (remaining <= 0 || attempt >= retryDelays.length) { expired = true; break; }
          const delay = Math.min(retryDelays[attempt++]!, remaining);
          await cancellable(sleep(delay), controller.signal);
          // An injected immediate sleep still consumes the polling budget.
          waited += delay;
        }
      } catch {
        if (active(id, controller) && get(id).reason !== 'Started, language settings not applied') put({ ...get(id), state: 'unidentified', reason: 'Started, not connected' });
      } finally {
        firstAttempt?.();
        clearTimeout(timer);
        if (identification.get(id) === controller) identification.delete(id);
        if (expired && !closed && !ending.has(id) && get(id).state !== 'ended') put({ ...get(id), state: 'unidentified', reason: 'Started, not connected' });
        controller.abort();
      }
    })();
    return task;
  }
  // retry: also restart identification for launches without a panel (startup and explicit reconcile only;
  // the periodic watch only notices sessions that ended).
  async function reconcile(retry: boolean) {
    requireOpen();
    let live: Map<string, number>;
    try { live = new Map((await (await options.tmux()).listSessions()).map(s => [s.name, s.panePid])); }
    catch { return; } // A failed listing gives no evidence that sessions ended.
    if (closed) return;
    for (const record of options.store.listLaunches()) {
      if (ending.has(record.id)) continue;
      const panePid = live.get(sessionNameFor(record.id));
      if (record.state === 'ended') {
        // A launch marked missing while its tmux session lives on (a listing gap around a restart) is adopted back;
        // launches ended on purpose stay ended.
        if (panePid !== undefined && record.reason === MISSING_REASON) {
          const kept = { ...get(record.id) }; delete kept.reason;
          put({ ...kept, panePid, state: kept.panelSessionId ? 'running' : 'starting' });
          if (!kept.panelSessionId) void identify(record.id);
        }
        continue;
      }
      if (panePid === undefined) { cancel(record.id); put({ ...get(record.id), state: 'ended', reason: MISSING_REASON }); continue; }
      const moved = record.panePid !== panePid;
      if (moved) { cancel(record.id); put({ ...get(record.id), panePid }); }
      if ((retry || moved) && (!record.panelSessionId || record.state === 'unidentified')) void identify(record.id);
    }
  }
  // End must never answer a native prompt, so it never sends Enter or typed text: Ctrl+C twice cancels a prompt
  // or clears input and never selects a menu option. A session that survives is killed.
  async function askToExit(tmux: Tmux, name: string) {
    await tmux.sendKeys(name, ['C-c']); await sleep(300); await tmux.sendKeys(name, ['C-c']);
  }
  return {
    async launch({ agent, folder, languageOverride }) {
      requireOpen();
      if (agent !== 'claude' && agent !== 'codex') throw new Error('Unsupported agent');
      const language = languageOverride === undefined ? undefined : validateLanguageOverride(languageOverride);
      if (language && Object.keys(language).length && !options.applyLanguage) throw new Error('Language settings unavailable');
      const cwd = await validFolder(folder); const tmux = await options.tmux();
      const extra = options.store.readLaunchSettings().extraArgs[agent];
      const id = randomUUID(); let sessionRef: string | undefined; let argv: string[];
      if (agent === 'claude') {
        const { claude, mcpConfigPath } = await options.prepareClaude(cwd); sessionRef = randomUUID();
        // The prompt must come first: --mcp-config and --dangerously-load-development-channels are variadic, so a trailing positional would be parsed as another option value. Extra args may be variadic too, so they go last.
        argv = [claude, CLAUDE_SETUP_PROMPT, '--session-id', sessionRef, '--mcp-config', mcpConfigPath, '--dangerously-load-development-channels', 'server:language-assistant', ...extra];
      } else {
        // `codex [OPTIONS] [PROMPT]`: the prompt goes first so an extra option that takes a value cannot swallow it.
        argv = [await options.resolveExecutable('codex'), CODEX_SETUP_PROMPT, ...extra];
      }
      requireOpen();
      const { panePid } = await tmux.newSession(sessionNameFor(id), cwd, argv, { ELECTRON_RUN_AS_NODE: '' });
      const record: LaunchRecord = { id, agent, folder: cwd, panePid, state: 'starting', createdAt: now(), ...(sessionRef ? { sessionRef } : {}), ...(language ? { languageOverride: language } : {}) };
      put(record);
      if (agent === 'claude') await new Promise<void>(done => { void identify(id, done).finally(done); }); else void identify(id);
      return get(id);
    },
    list: () => options.store.listLaunches(),
    reconcile: () => reconcile(true),
    identify(launchId) {
      requireOpen(); const record = get(launchId);
      if (record.state === 'ended' || ending.has(launchId)) throw Object.assign(new Error('Unknown launch'), { code: 'unknown-session' });
      if (record.state === 'unidentified' && !identification.has(launchId)) { const { reason: _reason, ...rest } = record; put({ ...rest, state: 'starting' }); }
      return identify(launchId);
    },
    noticeDiscovery(agent) {
      if (closed) return;
      for (const record of options.store.listLaunches()) {
        if (record.agent !== agent || record.state !== 'unidentified' || record.panelSessionId || identification.has(record.id) || ending.has(record.id)) continue;
        void identify(record.id);
      }
    },
    watch() {
      if (closed || watcher) return; let running = false;
      watcher = setInterval(() => {
        // Nothing to watch: skip, so a machine without tmux is not probed every few seconds.
        if (running || closed || !options.store.listLaunches().some(r => r.state !== 'ended')) return; running = true;
        reconcile(false).catch(() => {}).finally(() => { running = false; });
      }, options.watchIntervalMs ?? 3000);
      (watcher as { unref?: () => void }).unref?.();
    },
    end(launchId) {
      requireOpen(); const record = get(launchId);
      if (record.state === 'ended') return Promise.resolve();
      const existing = ending.get(launchId); if (existing) return existing;
      cancel(launchId);
      const task = (async () => {
        const tmux = await options.tmux(); const name = sessionNameFor(launchId);
        const asked = await askToExit(tmux, name).then(() => true, () => false);
        if (asked) for (let i = 0; i < 20 && await tmux.hasSession(name); i++) await sleep(500);
        if (await tmux.hasSession(name)) {
          await tmux.killSession(name);
          if (await tmux.hasSession(name)) throw new Error('Session is still running');
        }
        put({ ...get(launchId), state: 'ended', reason: 'Ended by you' });
      })().finally(() => ending.delete(launchId));
      ending.set(launchId, task); return task;
    },
    subscribe(listener) { requireOpen(); listeners.add(listener); return () => listeners.delete(listener); },
    close() { closed = true; if (watcher) clearInterval(watcher); watcher = undefined; for (const controller of identification.values()) controller.abort(); identification.clear(); listeners.clear(); },
  };
}
