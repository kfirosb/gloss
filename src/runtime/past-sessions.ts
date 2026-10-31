import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createAsyncCache } from '../core/async-cache.js';
import type { AgentAdapter, AgentKind } from '../core/contracts.js';
import {
  mergePastSessions,
  pastSessionKey,
  type AgentPastSession,
  type PastSessionsResponse,
} from '../core/past-sessions.js';
import type { HiddenSessionStore, SessionStore } from '../core/session-contracts.js';
import { owningLaunches, type SessionLauncher } from './session-launcher.js';

/** A reopened Saved sessions menu reuses the folder's listing for this long instead of rescanning. */
export const PAST_SESSIONS_CACHE_MS = 5000;
/** An open-session scan slower than this leaves its agent's entries without `open-outside`. */
const OPEN_SCAN_TIMEOUT_MS = 10_000;

export interface PastSessionsService {
  list(folder: unknown): Promise<PastSessionsResponse>;
  /** Whether the agent reports this conversation open now, from a fresh scan; a failed or slow scan reports false. */
  openOutside(agent: AgentKind, sessionRef: string): Promise<boolean>;
  /** Drops cached listings, after something changed what a listing would show (hide, reopen, remove). */
  invalidate(): void;
  close(): void;
}

export function createPastSessionsService(options: {
  store: Pick<SessionStore, 'listSessions'> & Partial<HiddenSessionStore>;
  agents: readonly AgentAdapter[];
  launcher?: Pick<SessionLauncher, 'list'>;
  knownFolder(folder: string): Promise<boolean>;
  /** Whether an ended launch's tmux pane still runs; absent means ended launches don't own their session. */
  paneAlive?(launchId: string): Promise<boolean>;
  /** Whether a Gloss panel is an open tab now; open tabs are not saved sessions, so their conversations are left out. */
  openPanel?(panelSessionId: string): boolean;
  now?: () => number;
  log?: (message: string) => void;
}): PastSessionsService {
  const log = options.log ?? ((message: string) => console.warn(message));
  const cache = createAsyncCache<string, PastSessionsResponse>({
    ttlMs: PAST_SESSIONS_CACHE_MS,
    ...(options.now ? { now: options.now } : {}),
  });
  const closing = new AbortController();
  const failed = (what: string, agent: AgentKind) => (error: unknown) => {
    log(`${what} failed for ${agent}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  };

  /** A stored session's own folder paths, as recorded. */
  const storedPaths = (row: ReturnType<SessionStore['listSessions']>[number]) =>
    [row.target.projectId, row.worktreePath].filter((path) => path !== undefined);
  /**
   * The real path of a known folder, or a folder that no longer exists but that a stored session
   * names exactly (a deleted worktree): its saved rows stay listable and removable.
   */
  const canonicalFolder = async (
    folder: unknown,
  ): Promise<{ folder: string; missing: boolean }> => {
    const refuse = () => new Error('Choose a project folder');
    if (typeof folder !== 'string' || !isAbsolute(folder)) throw refuse();
    const real = await realpath(folder).catch(() => undefined);
    if (real === undefined) {
      if (options.store.listSessions().some((row) => storedPaths(row).includes(folder)))
        return { folder, missing: true };
      throw refuse();
    }
    if (!(await options.knownFolder(real))) throw refuse();
    return { folder: real, missing: false };
  };

  /** Gloss's own rows for the folder; they carry no time of their own and take the agent's entry's when it has one. */
  const glossRows = async (folder: string, missing: boolean) => {
    const rows = options.store.listSessions();
    // A missing folder has no real path, so its rows are matched by the path they recorded.
    const inFolder = await Promise.all(
      rows.map(async (row) => {
        if (missing) return storedPaths(row).includes(folder);
        for (const path of storedPaths(row))
          if ((await realpath(path).catch(() => undefined)) === folder) return true;
        return false;
      }),
    );
    return rows
      .filter((_, index) => inFolder[index])
      .map((row) => ({
        agent: row.target.agent,
        sessionRef: row.target.sessionRef,
        panelSessionId: row.id,
        ...(row.sessionTitle !== undefined ? { title: row.sessionTitle } : {}),
      }));
  };

  const scanSignal = () =>
    AbortSignal.any([closing.signal, AbortSignal.timeout(OPEN_SCAN_TIMEOUT_MS)]);
  /** Keys of conversations each agent reports open now; a scan counts even when incomplete. */
  const openOutside = async (): Promise<Set<string>> => {
    const signal = scanSignal();
    const scans = await Promise.all(
      options.agents.map((agent) =>
        agent.discoverOpen?.(signal).catch(failed('Open session scan', agent.kind)),
      ),
    );
    return new Set(
      scans.flatMap((scan) =>
        (scan?.candidates ?? []).map((c) => pastSessionKey(c.target.agent, c.target.sessionRef)),
      ),
    );
  };

  /** Owned by a Gloss launch that runs, or that ended while its tmux pane still lives. */
  const openInGloss = async (agent: AgentKind, sessionRef: string): Promise<boolean> => {
    const owners = owningLaunches(
      agent,
      sessionRef,
      options.launcher?.list() ?? [],
      options.store.listSessions(),
    );
    for (const launch of owners) {
      if (launch.state !== 'ended') return true;
      if (await options.paneAlive?.(launch.id).catch(() => false)) return true;
    }
    return false;
  };

  /** A missing folder lists only Gloss's rows: the agents have nothing to read there, and it cannot be reopened in. */
  const read = async (folder: string, missing: boolean): Promise<PastSessionsResponse> => {
    const [rows, listings, outside] = await Promise.all([
      glossRows(folder, missing),
      missing
        ? []
        : Promise.all(
            options.agents.map((agent) =>
              agent.listPast?.(folder).catch(failed('Past session listing', agent.kind)),
            ),
          ),
      missing ? new Set<string>() : openOutside(),
    ]);
    const sources = [...rows, ...listings.flatMap((listing): AgentPastSession[] => listing ?? [])];
    // Left out like hidden ones, before the cap: removed conversations and those open as tabs.
    const hidden = new Set([
      ...(options.store.listHiddenSessions?.() ?? []).map((h) =>
        pastSessionKey(h.agent, h.sessionRef),
      ),
      ...rows
        .filter((row) => options.openPanel?.(row.panelSessionId))
        .map((row) => pastSessionKey(row.agent, row.sessionRef)),
    ]);
    // Only the listed entries need ownership checks, and those may ask tmux; the merge's state callback is synchronous.
    const merged = mergePastSessions(sources, hidden, () => 'closed');
    const entries = await Promise.all(
      merged.map(async (entry) => {
        if (await openInGloss(entry.agent, entry.sessionRef))
          return { ...entry, state: 'open-in-gloss' as const };
        if (outside.has(pastSessionKey(entry.agent, entry.sessionRef)))
          return { ...entry, state: 'open-outside' as const };
        return entry;
      }),
    );
    return { folder, entries, ...(missing ? { folderMissing: true } : {}) };
  };

  return {
    async list(folder) {
      if (closing.signal.aborted) throw new Error('Past sessions unavailable');
      const { folder: key, missing } = await canonicalFolder(folder);
      // Keyed apart, so a folder that reappears at the same path is not answered from its missing listing.
      return cache.get(missing ? `missing:${key}` : key, () => read(key, missing));
    },
    async openOutside(agent, sessionRef) {
      const adapter = options.agents.find((a) => a.kind === agent);
      const scan = await adapter
        ?.discoverOpen?.(scanSignal(), { fresh: true })
        .catch(failed('Open session scan', agent));
      return (scan?.candidates ?? []).some(
        (c) => c.target.agent === agent && c.target.sessionRef === sessionRef,
      );
    },
    invalidate() {
      cache.clear();
    },
    close() {
      closing.abort();
      cache.clear();
    },
  };
}
