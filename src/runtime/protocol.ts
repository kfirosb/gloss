import type {
  ConversationSnapshot,
  Target,
  Draft,
  SourceMessage,
  AgentKind,
} from '../core/contracts.js';
export type Action =
  | { type: 'connect'; target: Target }
  | { type: 'discuss'; text: string; attachmentIds?: string[] }
  | { type: 'translate-composer'; text: string }
  | { type: 'check-composer'; requestId: string }
  | { type: 'release-composer'; requestId: string }
  | {
      type: 'send-composer';
      requestId: string;
      text: string;
      attachmentIds?: string[];
      transport?: 'channel' | 'peer';
    }
  | { type: 'prepare'; indices: number[]; expected?: { id: string; revision: number } }
  | {
      type: 'send-review';
      draftId: string;
      revision: number;
      localizedText: string;
      transport?: 'channel' | 'peer';
    }
  | {
      type: 'approve';
      reviewId: string;
      localizedText: string;
      expected?: { id: string; revision: number };
    }
  | { type: 'edit-approved'; draftId: string; revision: number; englishText: string }
  | { type: 'revise'; draftId: string; text: string }
  | { type: 'reset-instruction'; draftId: string; revision: number }
  | { type: 'discard'; draftId: string }
  | { type: 'send'; draftId: string; revision: number; transport?: 'channel' | 'peer' }
  | { type: 'translate-message'; sourceId: string }
  | { type: 'translate-activity-report'; taskId: string }
  | { type: 'older-history' };
export interface RuntimeSnapshot {
  sessionId?: string;
  sequence: number;
  snapshot: ConversationSnapshot;
  review?: Draft;
  translation?: string;
}

export interface SourcePayload extends SourceMessage {
  agent?: AgentKind;
}
export type DiscoveredTarget = import('./project-metadata.js').ProjectMetadata & { target: Target };
