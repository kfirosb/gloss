import type { AgentKind } from './contracts.js';
import { shellQuote } from './command-text.js';
import { PAST_SESSIONS_LIMIT } from './launch-settings.js';
import { normalizeSessionTitle } from './session-title.js';

export type PastSessionState = 'closed' | 'open-in-gloss' | 'open-outside';

/** What an adapter knows about one past conversation of a folder. */
export interface AgentPastSession {
  agent: AgentKind;
  sessionRef: string;
  title?: string;
  /** Epoch ms; absent when unknown (never 0). */
  lastActiveAt?: number;
  branch?: string;
}

export interface PastSession {
  agent: AgentKind;
  sessionRef: string;
  panelSessionId?: string;
  title: string;
  /** ISO time; absent when unknown. */
  lastActiveAt?: string;
  branch?: string;
  state: PastSessionState;
}

export interface PastSessionsResponse {
  folder: string;
  entries: PastSession[];
}

type PastSessionSource = AgentPastSession & { panelSessionId?: string };

const AGENT_NAMES: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex' };

export const pastSessionKey = (agent: AgentKind, sessionRef: string) => `${agent}:${sessionRef}`;

/** Title fallback: `${agentName} · ${date}`, or just the agent name when the time is unknown; applies normalizeSessionTitle to a given title first. */
export function pastSessionTitle(
  entry: Pick<AgentPastSession, 'agent' | 'title' | 'lastActiveAt'>,
): string {
  const given = normalizeSessionTitle(entry.title);
  if (given) return given;
  const name = AGENT_NAMES[entry.agent];
  return entry.lastActiveAt === undefined
    ? name
    : `${name} · ${new Date(entry.lastActiveAt).toLocaleDateString()}`;
}

/** Sort comparator: newest first, entries without a time after all dated ones (stable among themselves). */
export function latestFirst(
  a: Pick<AgentPastSession, 'lastActiveAt'>,
  b: Pick<AgentPastSession, 'lastActiveAt'>,
): number {
  if (a.lastActiveAt === undefined || b.lastActiveAt === undefined)
    return (a.lastActiveAt === undefined ? 1 : 0) - (b.lastActiveAt === undefined ? 1 : 0);
  return b.lastActiveAt - a.lastActiveAt;
}

/** The later of two times, either of which may be unknown. */
function latest(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  return b === undefined ? a : Math.max(a, b);
}

/** Two entries for one conversation: keep the panel id and Gloss's own title, and the latest activity. */
function combine(a: PastSessionSource, b: PastSessionSource): PastSessionSource {
  const withPanel = a.panelSessionId || !b.panelSessionId ? a : b;
  const other = withPanel === a ? b : a;
  const merged: PastSessionSource = { ...other, ...withPanel };
  delete merged.lastActiveAt;
  const time = latest(a.lastActiveAt, b.lastActiveAt);
  if (time !== undefined) merged.lastActiveAt = time;
  const title = withPanel.title ?? other.title;
  if (title !== undefined) merged.title = title;
  const branch = withPanel.branch ?? other.branch;
  if (branch !== undefined) merged.branch = branch;
  return merged;
}

/** Dedupes by (agent, sessionRef), prefers the entry with a panelSessionId then a Gloss title, sorts by lastActiveAt desc with unknown times last (so they drop first), truncates to limit, skips hidden. */
export function mergePastSessions(
  sources: readonly PastSessionSource[],
  hidden: ReadonlySet<string>,
  stateOf: (agent: AgentKind, sessionRef: string) => PastSessionState,
  limit: number = PAST_SESSIONS_LIMIT,
): PastSession[] {
  const byKey = new Map<string, PastSessionSource>();
  for (const source of sources) {
    const key = pastSessionKey(source.agent, source.sessionRef);
    if (hidden.has(key)) continue;
    const existing = byKey.get(key);
    byKey.set(key, existing ? combine(existing, source) : source);
  }
  return [...byKey.values()]
    .sort(latestFirst)
    .slice(0, limit)
    .map((entry) => ({
      agent: entry.agent,
      sessionRef: entry.sessionRef,
      ...(entry.panelSessionId ? { panelSessionId: entry.panelSessionId } : {}),
      title: pastSessionTitle(entry),
      ...(entry.lastActiveAt !== undefined
        ? { lastActiveAt: new Date(entry.lastActiveAt).toISOString() }
        : {}),
      ...(entry.branch ? { branch: entry.branch } : {}),
      state: stateOf(entry.agent, entry.sessionRef),
    }));
}

/** The command the user can paste when Gloss cannot reopen: `claude --resume <id>` or `codex resume <id>`, plus a cd variant. */
export function manualResumeCommand(
  agent: AgentKind,
  sessionRef: string,
  folder: string,
): { command: string; cdCommand: string } {
  // Real ids are plain tokens; quote anything else so a pasted command cannot run extra shell syntax.
  const ref = /^[\w.-]+$/.test(sessionRef) ? sessionRef : shellQuote(sessionRef);
  const command = agent === 'claude' ? `claude --resume ${ref}` : `codex resume ${ref}`;
  return { command, cdCommand: `cd ${shellQuote(folder)} && ${command}` };
}
