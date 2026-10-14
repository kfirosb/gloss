import type { Target } from './contracts.js';
import type { Attention } from './attention.js';
import type { TerminalEntry } from './session-contracts.js';

export interface OpenSessionCandidate {
  sessionTitle?: string;
  target: Target;
  support: 'supported' | 'unsupported';
  /** Native process id holding the session, when discovery observed it (used for launch ancestry). */
  nativePid?: number;
  /** When the native session was created (epoch ms), when its metadata records it; used to match launches by folder and time. */
  createdAt?: number;
  reason?: string;
  /** Native activity observed during discovery, shown when the panel cannot connect. */
  activity?: import('./contracts.js').CodingState;
}
export interface OpenSessionScan {
  candidates: OpenSessionCandidate[];
  complete: boolean;
  error?: string;
}

/** Per-session record of the newest response the user has looked at. */
export interface SeenStore {
  /** Newest response sequence the user has seen, or undefined when the session was never seen. */
  seenSequence(sessionId: string): number | undefined;
  /** Records that the user saw responses up to `sequence`; a value lower than the stored one is ignored. */
  markSeen(sessionId: string, sequence: number, at?: number): void;
}

export interface CatalogEntry {
  sessionTitle?: string;
  key: string;
  sessionId?: string;
  target: Target;
  projectKey: string;
  projectName: string;
  worktreePath?: string;
  branch?: string;
  open: boolean;
  activity: import('./contracts.js').CodingState | 'connecting' | 'unknown';
  availability: 'available' | 'unavailable';
  reason?: string;
  /** True when the session's folder no longer exists on disk (from cached project metadata). */
  folderMissing?: boolean;
  /** Short language flow such as HE→EN→HE, shown on the session tab. */
  languageCode?: string;
  /** Set when Gloss launched this session. */
  launchId?: string;
  launchState?: import('./session-contracts.js').LaunchState;
  /** Shown when Gloss cannot tell whether this launched session needs the user. */
  attentionNotice?: string;
  /** What the session needs from the user; absent means 'none'. Derived by the server, never stored. */
  attention?: Attention;
  /** Revision of the newest completed assistant message, when the session has one. */
  latestResponseSequence?: number;
}
export interface CatalogSnapshot {
  epoch: string;
  sequence: number;
  entries: CatalogEntry[];
  /** Live terminals started from Gloss; never sessions, never saved. */
  terminals?: TerminalEntry[];
  discovery: { state: 'healthy' | 'stale'; error?: string };
  /** Account-level quota per provider, when the host tracks it. */
  usage?: import('./usage.js').UsageSnapshot;
}
export interface SessionCatalog {
  start(): void;
  snapshot(): CatalogSnapshot;
  /** Re-publish rows after outside state, such as language settings, changed. */
  refresh(): void;
  /** Drops a removed session's row and subscription; it reappears only if discovery sees it open again. */
  forget(sessionId: string): void;
  /** Entry for a saved session, if the catalog lists one. */
  entryFor(sessionId: string): CatalogEntry | undefined;
  /** Records that the user saw responses up to `sequence` and republishes when that changes an entry. */
  markSeen(sessionId: string, sequence: number): 'updated' | 'unchanged' | 'unknown';
  subscribe(listener: (snapshot: CatalogSnapshot) => void): () => void;
  close(): Promise<void>;
}
