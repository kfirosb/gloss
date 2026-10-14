import type { Target } from './contracts.js';

/** Lifecycle of a session Gloss launched in its private tmux server. */
export type LaunchState = 'starting' | 'running' | 'unidentified' | 'ended';

export interface SessionRecord {
  sessionTitle?: string;
  id: string;
  target: Target;
  canonicalRoot: string;
  projectName: string;
  branch?: string;
  worktreePath?: string;
  /** Repository project key (git common dir), supplied when listing sessions. */
  projectKey?: string;
  /** The record's folder no longer exists, supplied when listing sessions. */
  folderMissing?: boolean;
  enabled: boolean;
}

export interface WorkspaceData {
  composer: string;
  attachmentIds: string[];
  selectedDiscussion: number[];
  review: { draftId: string; revision: number; localizedText: string } | null;
  composerAttempt: { requestId: string; text: string; attachmentIds: string[] } | null;
  layout: {
    mode: 'split' | 'columns' | 'rows' | 'bottom';
    order: ('live' | 'assistant' | 'composer')[];
    liveSize: number;
    discussionSize: number;
  };
}

export interface WorkspaceRecord { sessionId: string; revision: number; data: WorkspaceData }

export interface SessionStore {
  updateSessionTitle(id: string, title: string): void;
  listSessions(): SessionRecord[];
  /** Removes a session's saved history from this app only. */
  deleteSession?(id: string): void;
  registerSession(record: SessionRecord): SessionRecord;
  readWorkspace(sessionId: string): WorkspaceRecord;
  writeWorkspace(sessionId: string, expectedRevision: number, data: WorkspaceData): WorkspaceRecord;
}

export class WorkspaceConflict extends Error {
  readonly code = 'workspace-conflict';

  constructor(readonly current: WorkspaceRecord) {
    super('Workspace changed');
    this.name = 'WorkspaceConflict';
  }
}

export function defaultWorkspace(): WorkspaceData {
  return {
    composer: '',
    attachmentIds: [],
    selectedDiscussion: [],
    review: null,
    composerAttempt: null,
    layout: {
      mode: 'split',
      order: ['live', 'assistant', 'composer'],
      liveSize: 50,
      discussionSize: 60,
    },
  };
}

/** Disclosed setup prompts for new launches. Each costs one model request and makes the agent create its transcript so Gloss can connect. */
export const CLAUDE_SETUP_PROMPT = 'Reply with READY only. Do not use tools.';
export const CODEX_SETUP_PROMPT = 'Reply with READY only. Do not run commands.';
/** What a launch runs: an agent, or a plain login shell ("terminal"). */
export type LaunchAgent = 'claude' | 'codex' | 'shell';
/** How terminal tabs open: the popup over the conversation, or in place of the conversation panels. */
export type TerminalView = 'popup' | 'workspace';
/** A live terminal as the catalog publishes it; never a session. */
export interface TerminalEntry { key: string; launchId: string; title: string; busy: boolean; folder: string; projectKey: string; projectName: string; originSessionId?: string }
