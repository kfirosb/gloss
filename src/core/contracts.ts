import type { OpenSessionScan } from './session-catalog.js';
import type { FileReference } from './file-references.js';
import type { LanguageSettings } from './language-settings.js';
import type { ActivityEvent, ActivitySnapshot } from './activity-contracts.js';
export type { FileReference, FileReferenceStore, FileRegistry } from './file-references.js';
export type AgentKind = 'claude' | 'codex';
/** Composer request IDs; also embedded in native channel and delivery markers. */
export const REQUEST_ID_SOURCE = '[a-zA-Z0-9-]{1,100}';
export const REQUEST_ID_PATTERN = new RegExp(`^${REQUEST_ID_SOURCE}$`);
export type CodingState = 'idle' | 'working' | 'approval-required' | 'disconnected';
export type DeliveryState = 'sending' | 'queued' | 'sent' | 'failed' | 'unconfirmed';

export interface Target {
  agent: AgentKind;
  sessionRef: string;
  projectId: string;
}
export interface ImageAttachment {
  kind?: 'image';
  index?: number;
  id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
}
export type Attachment = FileReference | ImageAttachment;
export interface Draft {
  attachments?: Attachment[];
  selectedDiscussion?: number[];
  id: string;
  revision: number;
  target: Target;
  sourceRevision: number;
  language: string;
  localizedText: string;
  englishText: string;
}
export interface Delivery {
  transport?: 'channel' | 'peer';
  channelGeneration?: string;
  referenceFormat?: 'manifest-v1';
  attachments?: Attachment[];
  nativeMessageId?: string;
  nativeAfterRevision?: number;
  id: string;
  draftId: string;
  revision: number;
  target: Target;
  englishText: string;
  state: DeliveryState;
  reason?: string;
}
/** The channel accepted the handoff; Claude's matching reply is still pending. */
export function isChannelAwaitingReply(delivery: Pick<Delivery, 'state' | 'transport'>): boolean {
  return delivery.transport === 'channel' && delivery.state === 'queued';
}
/** A submitted draft can be released without claiming that Claude has replied. */
export function isDeliverySubmitted(delivery: Pick<Delivery, 'state' | 'transport'>): boolean {
  return delivery.state === 'sent' || isChannelAwaitingReply(delivery);
}
export interface AgentMessage {
  clientId?: string;
  sourceId: string;
  revision: number;
  role: 'user' | 'assistant';
  text: string;
  complete: boolean;
  timestamp?: string;
  translatedText?: string;
  translationStatus?: 'pending' | 'complete' | 'error';
}
/** Revisions belong to a source namespace. Claude channel sequences are not byte offsets. */
export function orderAgentMessages(messages: AgentMessage[], agent?: AgentKind): AgentMessage[] {
  if (agent !== 'claude') return messages.sort((a, b) => a.revision - b.revision);
  return messages.sort((a, b) => {
    const time = (message: AgentMessage) => Date.parse(message.timestamp ?? '') || 0;
    const chronological = time(a) - time(b);
    if (chronological) return chronological;
    const channelA = a.sourceId.startsWith('channel:');
    const channelB = b.sourceId.startsWith('channel:');
    return channelA === channelB ? a.revision - b.revision : Number(channelA) - Number(channelB);
  });
}
export function canSendWhileWorking(
  capabilities:
    | Pick<AgentCapabilities, 'sendWhileBusy' | 'channelSendWhileBusy' | 'peerSendWhileBusy'>
    | undefined,
  transport?: 'channel' | 'peer',
): boolean {
  return Boolean(
    capabilities?.sendWhileBusy ||
    (transport === 'channel' && capabilities?.channelSendWhileBusy) ||
    (transport === 'peer' && capabilities?.peerSendWhileBusy),
  );
}
export interface AgentCapabilities {
  imageAttachments?: boolean;
  fileReferences?: boolean;
  history: boolean;
  liveMessages: boolean;
  attachExisting: boolean;
  sendWhileBusy: boolean;
  /** Verified channel transport queues messages until the agent is free, so it may send while 'working'. */
  channelSendWhileBusy?: boolean;
  /** Claude queues peer messages that arrive during a turn, so a peer send may go out while 'working'. */
  peerSendWhileBusy?: boolean;
  acknowledgement: 'none' | 'queued' | 'accepted';
}
export type AgentEvent =
  | { type: 'message'; message: AgentMessage }
  | { type: 'usage'; usage: import('./usage.js').ProviderUsage }
  /** Claude read this Gloss channel message into its context; its next finished turn answers it. */
  | { type: 'channel-seen'; requestId: string }
  | { type: 'status'; state: CodingState }
  | { type: 'delivery'; requestId: string; state: DeliveryState; reason?: string }
  | { type: 'activity'; event: ActivityEvent }
  | { type: 'gap'; reason: string };
export interface CodingConnection {
  target: Target;
  capabilities: AgentCapabilities;
  history(cursor?: string): Promise<{ messages: AgentMessage[]; next?: string }>;
  events(signal: AbortSignal): AsyncIterable<AgentEvent>;
  reconcileDelivery?(delivery: Delivery): Promise<boolean>;
  send(
    requestId: string,
    englishText: string,
    attachments?: Attachment[],
    context?: SendContext,
  ): Promise<{
    state: DeliveryState;
    reason?: string;
    nativeMessageId?: string;
    nativeAfterRevision?: number;
    channelGeneration?: string;
  }>;
  detach(): Promise<void>;
}
export interface SendContext {
  panelSessionId: string;
  transport: 'channel' | 'peer';
}
export interface AgentAdapter {
  kind: AgentKind;
  discover(projectPath: string): Promise<Target[]>;
  /** `fresh` asks for a scan that does not reuse a recent cached probe, e.g. to identify a new launch. */
  discoverOpen?(signal: AbortSignal, options?: { fresh?: boolean }): Promise<OpenSessionScan>;
  attach(target: Target, context?: { panelSessionId: string }): Promise<CodingConnection>;
}
export interface LanguageTurn {
  id?: string;
  complete?: boolean;
  attachments?: Attachment[];
  role: 'user' | 'assistant';
  text: string;
}
export interface LanguageInput {
  fileContext?: { id: string; index: number; text?: string; unreadable?: string }[];
  reviewText?: string;
  language: string;
  deliveryLanguage?: string;
  projectContext: string;
  codingMessages: AgentMessage[];
  discussion: LanguageTurn[];
  selectedDiscussion?: LanguageTurn[];
}
export interface LanguageSession {
  summarize(text: string, language: string, signal: AbortSignal): Promise<string>;
  id: string;
  discuss(input: LanguageInput, signal: AbortSignal): AsyncIterable<string>;
  prepare(
    input: LanguageInput,
    signal: AbortSignal,
  ): Promise<{ localizedText: string; englishText: string }>;
  translate(text: string, language: string, signal: AbortSignal): Promise<string>;
  resetContext(): Promise<void>;
  close(): Promise<void>;
}
export interface LanguageBackend {
  models(): Promise<{ id: string; label: string }[]>;
  /** `scope` attributes the session's spend, normally to the panel session that owns it. */
  open(model: string, resumeId?: string, options?: { scope?: string }): Promise<LanguageSession>;
  /** Asks the provider for fresh quota windows; absent when the provider cannot report them on demand. */
  refreshUsage?(signal: AbortSignal): Promise<void>;
}
export interface HostAdapter {
  openPanel(url: string): Promise<void>;
  revealCodingSession(target: Target): Promise<void>;
}

export interface ConversationSnapshot {
  id: string;
  target?: Target;
  codingState: CodingState;
  codingMessages: AgentMessage[];
  discussion: LanguageTurn[];
  currentDraft?: Draft;
  composerDraft?: Draft;
  deliveries: Delivery[];
  language: string;
  languageSettings?: LanguageSettings;
  languageSessionId: string;
  languageModel: string;
  sourceRevision: number;
  historyCursor?: string;
  sourceSessionId?: string;
  sourceCursor?: string;
  sourceSequence?: number;
  capabilities?: AgentCapabilities;
  sourceGaps?: string[];
  activity?: ActivitySnapshot;
  hostMetadata?: Record<string, unknown>;
}

export interface SourceMessage {
  timestamp?: string;
  sourceSessionId: string;
  sourceId: string;
  sequence: number;
  role: 'user' | 'assistant';
  text: string;
  complete?: boolean;
  cursor?: string;
}

export interface TranslationKey {
  sourceScope: string;
  sourceId: string;
  sourceRevision: number;
  contentHash: string;
  language: string;
  model: string;
  promptVersion: string;
}

export interface ConversationSummary {
  id: string;
  projectId?: string;
  target?: Target;
  language: string;
  languageModel: string;
  sourceRevision: number;
}

export interface ConversationStore {
  releaseComposerAttempt(conversationId: string, requestId: string): void;
  getSummary(key: import('./summary-contracts.js').SummaryKey): string | undefined;
  putSummary(key: import('./summary-contracts.js').SummaryKey, text: string): void;
  load(id: string): ConversationSnapshot | undefined;
  save(snapshot: ConversationSnapshot): void;
  claimDelivery(delivery: Delivery): boolean;
  updateDelivery(delivery: Delivery): void;
  getTranslation(key: TranslationKey): string | undefined;
  putTranslation(key: TranslationKey, text: string): void;
  readContext(projectId: string): string | undefined;
  writeContext(projectId: string, text: string): void;
  deleteContext(projectId: string): void;
  deleteConversation(id: string): void;
  list(projectId?: string): ConversationSummary[];
  recoverInFlightDeliveries(): number;
}
