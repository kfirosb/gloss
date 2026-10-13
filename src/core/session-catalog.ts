import type { Target } from './contracts.js';

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
  /** Set when Language Assistant launched this session. */
  launchId?: string;
  launchState?: import('./session-contracts.js').LaunchState;
  /** Shown when Language Assistant cannot tell whether this launched session needs the user. */
  attentionNotice?: string;
}
export interface CatalogSnapshot {
  epoch: string;
  sequence: number;
  entries: CatalogEntry[];
  discovery: { state: 'healthy' | 'stale'; error?: string };
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
  subscribe(listener: (snapshot: CatalogSnapshot) => void): () => void;
  close(): Promise<void>;
}
