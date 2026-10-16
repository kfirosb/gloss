import {
  ATTACHMENT_AND_IMAGE_LIMIT_MESSAGE,
  MAX_ATTACHMENTS,
  MAX_IMAGES,
  MAX_INSTRUCTION_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_TEXT_CHARS,
} from './content-policy.js';
import {
  isFileReference,
  uniqueReferences,
  type FileRegistry,
  type FileReference,
} from './file-references.js';
import {
  DIALOG_OPEN_REASON,
  REQUEST_ID_PATTERN,
  TYPING_STARTED_REASON,
  WORKING_HOLD_REASON,
  isAwaitingEvidence,
  isDeliverySubmitted,
  isDeliveryTransport,
  isDeliveryUnresolved,
  sendGate,
  type Attachment,
  type DeliveryEvidence,
  type DeliveryRoute,
  type DeliveryTransport,
} from './contracts.js';
import type {
  AgentAdapter,
  AgentEvent,
  CodingConnection,
  ConversationSnapshot,
  ConversationStore,
  Delivery,
  Draft,
  LanguageInput,
  LanguageSession,
  AgentMessage,
  SourceMessage,
  Target,
} from './contracts.js';
import { TRANSLATION_PROMPT_VERSION } from './language-style.js';
import { randomUUID } from 'node:crypto';
import { ResponseSummaries } from './response-summaries.js';
import type { SummarySource, ResponseSummary } from './summary-contracts.js';
import {
  languageName,
  legacyLanguageSettings,
  needsReplyTranslation,
  needsSendTranslation,
  type LanguageSettings,
} from './language-settings.js';
import { translateMessageResult } from './translations.js';
import { orderAgentMessages, type SendContext } from './contracts.js';

export interface WorkflowDependencies {
  files?: FileRegistry;
  readFileContext?: (files: FileReference[]) => Promise<NonNullable<LanguageInput['fileContext']>>;
  conversationId: string;
  language: string;
  languageSettings?: () => LanguageSettings;
  projectContext: string | (() => string);
  languageModel: string;
  languageSession: LanguageSession;
  agents: AgentAdapter[];
  store: ConversationStore;
  createId?: (prefix: 'draft' | 'delivery') => string;
  /** Account-level quota observations from the live agent's own transcript; never part of the conversation. */
  onUsage?: (usage: import('./usage.js').ProviderUsage) => void;
  /** How often a held message is checked again besides every status change, in milliseconds. Tests shorten it. */
  heldRecheckMs?: number;
}

export interface Workflow {
  reviewFileText(
    text: string,
    mode: 'summary' | 'translation',
    signal: AbortSignal,
  ): Promise<string>;
  summarizeResponse(source: SummarySource): Promise<ResponseSummary>;
  connect(target: Target): Promise<void>;
  ingestSourceMessage(message: SourceMessage): void;
  loadOlderHistory(): Promise<void>;
  discuss(text: string, attachments?: Attachment[]): Promise<string>;
  prepare(): Promise<Draft>;
  checkComposer(requestId: string): Promise<void>;
  releaseComposer(requestId: string): void;
  sendComposer(
    requestId: string,
    text: string,
    attachments?: Attachment[],
    transport?: SendContext['transport'],
  ): Promise<Delivery>;
  translateComposer(text: string): Promise<string>;
  refreshLanguageSettings(): void;
  translateMessage(sourceId: string): Promise<void>;
  prepareDirect(indices: number[], expected?: { id: string; revision: number }): Promise<Draft>;
  sendReview(
    id: string,
    revision: number,
    localizedText: string,
    transport?: SendContext['transport'],
  ): Promise<Delivery>;
  prepareReview(indices: number[]): Promise<Draft>;
  approveReview(
    id: string,
    localizedText: string,
    expected?: { id: string; revision: number },
  ): Promise<Draft>;
  editApproved(id: string, revision: number, englishText: string): Draft;
  reviseDraft(id: string, text: string): Promise<Draft>;
  resetInstruction(id: string, revision: number): void;
  discardDraft(id: string): void;
  send(id: string, revision: number, transport?: SendContext['transport']): Promise<Delivery>;
  /** The route a Claude send would take now, or why there is none. */
  deliveryRoute(): Promise<DeliveryRoute>;
  invalidateProjectContext(): Promise<void>;
  snapshot(): ConversationSnapshot;
  subscribe(listener: (snapshot: ConversationSnapshot) => void): () => void;
  close(): Promise<void>;
}

/** Remembered channel request IDs, enough to deduplicate recent native echoes. */
const SEEN_CHANNEL_LIMIT = 1000;
/** Default re-check interval for held messages, in milliseconds. */
const HELD_RECHECK_MS = 2000;
const CHECKING_TERMINAL_REASON = 'Checking the terminal';
const EARLIER_HELD_REASON = 'Waiting for an earlier message to reach the terminal';
const RELEASED_BEFORE_SENDING_REASON = 'Not sent: released before Gloss typed it';
const NOT_CONNECTED_REASON = 'Claude is not connected';
const ROUTE_UNAVAILABLE_REASON =
  'Gloss couldn’t check how to reach this session; it will check again';
const NOT_TYPED_REASON = 'Gloss couldn’t reach the terminal; nothing was sent';

const copy = <T>(value: T): T => structuredClone(value);

function assertAttachmentLimits(attachments: readonly Attachment[]) {
  if (
    attachments.length > MAX_ATTACHMENTS ||
    attachments.filter((f) => f.kind !== 'file').length > MAX_IMAGES
  )
    throw new Error(ATTACHMENT_AND_IMAGE_LIMIT_MESSAGE);
}

const sameTarget = (left: Target, right: Target) =>
  left.agent === right.agent &&
  left.sessionRef === right.sessionRef &&
  left.projectId === right.projectId;

export function createWorkflow(deps: WorkflowDependencies): Workflow {
  const createId =
    deps.createId ??
    ((prefix: 'draft' | 'delivery') => `${prefix}-${globalThis.crypto.randomUUID()}`);
  const restored = deps.store.load(deps.conversationId);
  let state: ConversationSnapshot = restored
    ? { ...restored, codingState: 'disconnected' }
    : {
        id: deps.conversationId,
        codingState: 'disconnected',
        codingMessages: [],
        discussion: [],
        deliveries: [],
        language: deps.language,
        languageSessionId: deps.languageSession.id,
        languageModel: deps.languageModel,
        sourceRevision: 0,
      };
  let lastGoodSettings: LanguageSettings | undefined;
  let settingsWarned = false;
  const readSettings = (): LanguageSettings => {
    try {
      return (lastGoodSettings =
        deps.languageSettings?.() ?? legacyLanguageSettings(deps.language));
    } catch (error) {
      if (!settingsWarned) {
        settingsWarned = true;
        console.warn('Language settings unavailable; using last known settings', error);
      }
      return lastGoodSettings ?? legacyLanguageSettings(deps.language);
    }
  };
  let settings: LanguageSettings = readSettings();
  state.languageSettings = settings;
  state.language = settings.assist;
  let connection: CodingConnection | undefined;
  state.discussion = state.discussion.map((turn, index) => ({
    ...turn,
    id: turn.id ?? `${state.id}:legacy:${index}`,
    complete: turn.complete ?? Boolean(turn.text.trim()),
  }));
  let connectionGeneration = 0;
  let eventAbort: AbortController | undefined;
  let closed = false;
  let languageContextVersion = 0;
  let languageTail: Promise<void> = Promise.resolve();
  const activeLanguageOperations = new Set<AbortController>();
  const summaries = new ResponseSummaries(
    () => state,
    deps.store,
    deps.languageSession,
    deps.languageModel,
  );
  const listeners = new Set<(snapshot: ConversationSnapshot) => void>();
  let composerOperation = false;
  let reviewOperation = false;
  const reviews = new Map<string, Draft>();
  const translating = new Set<string>();
  const mergeMessage = (message: AgentMessage, cursor?: string, sourceSessionId?: string) => {
    const current = state.codingMessages.findIndex((item) => item.sourceId === message.sourceId);
    if (current >= 0 && state.codingMessages[current]!.revision >= message.revision) return false;
    if (current >= 0) state.codingMessages[current] = copy(message);
    else state.codingMessages.push(copy(message));
    orderAgentMessages(state.codingMessages, state.target?.agent);
    if (sourceSessionId) {
      if (
        state.sourceSessionId !== sourceSessionId ||
        message.revision >= (state.sourceSequence ?? -1)
      ) {
        state.sourceSessionId = sourceSessionId;
        state.sourceSequence = message.revision;
        if (cursor) state.sourceCursor = cursor;
      }
    }
    state.sourceRevision += 1;
    return true;
  };

  const translationQueue = new Map<string, AgentMessage>();
  const dropPendingTranslations = () => {
    for (const id of translationQueue.keys()) translating.delete(id);
    translationQueue.clear();
    let changed = false;
    for (const message of state.codingMessages)
      if (message.translationStatus === 'pending') {
        delete message.translationStatus;
        changed = true;
      }
    return changed;
  };
  if (!needsReplyTranslation(settings)) dropPendingTranslations();
  let translatingOne = false;
  const pumpTranslations = async () => {
    if (closed || translatingOne || !translationQueue.size) return;
    if (!needsReplyTranslation(settings)) {
      dropPendingTranslations();
      return;
    }
    const source = orderAgentMessages([...translationQueue.values()], state.target?.agent).at(-1)!;
    translationQueue.delete(source.sourceId);
    translatingOne = true;
    const target = settings.reply;
    const generation = connectionGeneration;
    const abort = new AbortController();
    activeLanguageOperations.add(abort);
    try {
      const result = await translateMessageResult(
        {
          sourceScope: state.id,
          sourceId: source.sourceId,
          sourceRevision: source.revision,
          text: source.text,
          complete: source.complete,
          language: target,
          promptLanguage: languageName(target),
          model: state.languageModel,
          promptVersion: TRANSLATION_PROMPT_VERSION,
          signal: abort.signal,
        },
        { store: deps.store, session: deps.languageSession },
      );
      const current = state.codingMessages.find((message) => message.sourceId === source.sourceId);
      if (
        !closed &&
        generation === connectionGeneration &&
        current?.revision === source.revision &&
        settings.reply === target &&
        needsReplyTranslation(settings)
      ) {
        current.translatedText = result.text;
        current.translationStatus = result.status === 'complete' ? 'complete' : 'error';
        publish();
      } else if (
        !closed &&
        generation === connectionGeneration &&
        current?.revision === source.revision &&
        current.translationStatus === 'pending'
      ) {
        delete current.translationStatus;
        publish();
      }
    } finally {
      activeLanguageOperations.delete(abort);
      translating.delete(source.sourceId);
      translatingOne = false;
      if (!closed) void pumpTranslations();
    }
  };
  const translateIfNeeded = (source: AgentMessage) => {
    if (!needsReplyTranslation(settings)) return;
    const current = state.codingMessages.find((message) => message.sourceId === source.sourceId);
    if (!source.complete || !current || current.translationStatus === 'complete') return;
    if (translating.has(source.sourceId)) return;
    translating.add(source.sourceId);
    current.translationStatus = 'pending';
    translationQueue.set(source.sourceId, copy(source));
    publish();
    queueMicrotask(() => {
      void pumpTranslations();
    });
  };

  const publish = (persist = true) => {
    state.languageSettings = settings;
    state.language = settings.assist;
    if (persist) deps.store.save(copy(state));
    for (const listener of listeners) listener(copy(state));
  };

  const languageInput = (discussion = state.discussion): LanguageInput => ({
    language: settings.assist,
    deliveryLanguage: languageName(settings.send),
    projectContext:
      typeof deps.projectContext === 'function' ? deps.projectContext() : deps.projectContext,
    codingMessages: copy(state.codingMessages),
    discussion: copy(discussion),
  });

  const resolveReferences = async (attachments: Attachment[] = []) => {
    const files = uniqueReferences(attachments);
    if (files.some((f) => isFileReference(f) && f.sessionId !== state.id))
      throw new Error('File belongs to another session');
    if (!deps.files) return copy(files);
    const resolved = (
      await Promise.all(files.map((f) => deps.files!.resolve(state.id, [f.id])))
    ).flat();
    for (const file of resolved) {
      const captured = files.find((f) => f.id === file.id)!;
      if (
        captured.path !== file.path ||
        (isFileReference(captured) &&
          (captured.worktreePath !== file.worktreePath ||
            captured.kind !== file.kind ||
            captured.index !== file.index))
      )
        throw new Error('Captured reference changed');
    }
    return resolved;
  };
  const withFileContext = async (input: LanguageInput): Promise<LanguageInput> => {
    const turns = input.selectedDiscussion ?? input.discussion.slice(-16);
    const files = await resolveReferences(turns.flatMap((t) => t.attachments ?? []));
    const normalized = files.filter(isFileReference);
    const normalizeTurns = (items: LanguageInput['discussion']) =>
      items.map((turn) => ({
        ...turn,
        ...(turn.attachments
          ? {
              attachments: uniqueReferences(turn.attachments).map(
                (f) => files.find((resolved) => resolved.id === f.id) ?? f,
              ),
            }
          : {}),
      }));
    return {
      ...input,
      discussion: normalizeTurns(input.discussion),
      ...(input.selectedDiscussion
        ? { selectedDiscussion: normalizeTurns(input.selectedDiscussion) }
        : {}),
      ...(normalized.length && deps.readFileContext
        ? { fileContext: await deps.readFileContext(normalized) }
        : {}),
    };
  };
  const prepareLanguage = async (input: LanguageInput, signal: AbortSignal) =>
    deps.languageSession.prepare(await withFileContext(input), signal);
  const supportsReferences = (files: Attachment[]) =>
    files.every((f) =>
      f.kind === 'file'
        ? connection?.capabilities.fileReferences
        : connection?.capabilities.imageAttachments || connection?.capabilities.fileReferences,
    );

  const clearSubmittedDraft = (delivery: Delivery) => {
    if (
      isDeliverySubmitted(delivery) &&
      state.composerDraft?.id === delivery.draftId &&
      state.composerDraft.revision === delivery.revision
    )
      delete state.composerDraft;
    const draft = state.currentDraft;
    if (
      isDeliverySubmitted(delivery) &&
      draft?.id === delivery.draftId &&
      draft.revision === delivery.revision &&
      sameTarget(draft.target, delivery.target)
    ) {
      delete state.currentDraft;
    }
  };

  // Recover a stop between persisting the handoff and saving draft cleanup.
  for (const delivery of state.deliveries) clearSubmittedDraft(delivery);

  /** Deliveries claimed before `delivery` for the same session, oldest first. */
  const earlierFor = (delivery: Delivery): Delivery[] => {
    const index = state.deliveries.findIndex((item) => item.id === delivery.id);
    return (index < 0 ? state.deliveries : state.deliveries.slice(0, index))
      .filter((item) => item.id !== delivery.id && sameTarget(item.target, delivery.target))
      .map(copy);
  };
  /** Exact native evidence; never sends. */
  const confirmEvidence = async (
    active: CodingConnection,
    delivery: Delivery,
  ): Promise<boolean | DeliveryEvidence> =>
    active.reconcileDelivery
      ? active.reconcileDelivery(copy(delivery), earlierFor(delivery))
      : false;
  const markSent = (delivery: Delivery, evidence: true | DeliveryEvidence) => {
    delivery.state = 'sent';
    delete delivery.reason;
    if (evidence !== true) delivery.nativeMessageId = evidence.nativeMessageId;
  };
  /** Stores the evidence that settled `delivery`; the caller broadcasts. */
  const settleWithEvidence = (delivery: Delivery, evidence: true | DeliveryEvidence) => {
    markSent(delivery, evidence);
    deps.store.updateDelivery(copy(delivery));
    clearSubmittedDraft(delivery);
  };
  const holdReason = () =>
    state.codingState === 'working' ? WORKING_HOLD_REASON : DIALOG_OPEN_REASON;
  /** Claude needs a route; other agents have one transport. Throws the route's reason when there is none. */
  const resolveTransport = async (
    target: Target,
    explicit: DeliveryTransport | undefined,
    active: CodingConnection,
  ): Promise<DeliveryTransport | undefined> => {
    if (target.agent !== 'claude') return undefined;
    if (explicit) return explicit;
    if (!active.deliveryRoute) return 'channel';
    const route = await active.deliveryRoute();
    if (route.transport === null) throw new Error(route.reason);
    return route.transport;
  };
  /** Cancels a message nothing was sent for yet, so no later check, nor one running now, can type or send it. */
  const cancelHeld = (delivery: Delivery) => {
    delivery.state = 'failed';
    delivery.reason = RELEASED_BEFORE_SENDING_REASON;
    deps.store.updateDelivery(copy(delivery));
  };
  /** Abandoning a review draft cancels its held messages; one whose typing started is never touched. */
  const cancelHeldFor = (draftId: string) => {
    for (const delivery of state.deliveries)
      if (delivery.draftId === draftId && delivery.state === 'held') cancelHeld(delivery);
  };
  const sameTargetHeld = (target: Target) =>
    state.deliveries.find((item) => item.state === 'held' && sameTarget(item.target, target));
  /** Deliveries handed to the agent whose send has not returned yet. A held one among them is being checked. */
  const dispatching = new Set<string>();
  let heldTimer: NodeJS.Timeout | undefined;
  let heldTail: Promise<void> = Promise.resolve();
  const stopHeldRecheck = () => {
    if (heldTimer) clearInterval(heldTimer);
    heldTimer = undefined;
  };
  const startHeldRecheck = () => {
    if (heldTimer || closed) return;
    heldTimer = setInterval(() => void retryHeld(), deps.heldRecheckMs ?? HELD_RECHECK_MS);
    heldTimer.unref();
  };
  /**
   * Hands a claimed delivery to the agent once; nothing is ever resent. A terminal send stays `held`, in memory and on
   * disk, until its adapter reports typing, so a check that finds the terminal unchanged changes nothing, Don't send
   * stays available during it, and a crash before typing retries it once. Any other transport is persisted as
   * `sending` before the write, so a crash during it is recovered as unconfirmed.
   */
  const dispatchClaimed = async (delivery: Delivery, active: CodingConnection): Promise<void> => {
    const terminal = delivery.transport === 'tmux';
    let stored = JSON.stringify(delivery);
    let typingStarted = false;
    dispatching.add(delivery.id);
    try {
      if (!terminal && delivery.state !== 'sending') {
        const sending: Delivery = { ...copy(delivery), state: 'sending' };
        delete sending.reason;
        deps.store.updateDelivery(sending);
        delivery.state = 'sending';
        delete delivery.reason;
        stored = JSON.stringify(delivery);
        publish(false);
      }
      const onTyping = ({ nativeAfterRevision }: { nativeAfterRevision: number }): undefined => {
        // Don't send was pressed during the check: refusing here means the adapter types nothing.
        if (delivery.state !== 'held') throw new Error(RELEASED_BEFORE_SENDING_REASON);
        const typing: Delivery = {
          ...copy(delivery),
          state: 'sending',
          reason: TYPING_STARTED_REASON,
          nativeAfterRevision,
        };
        deps.store.updateDelivery(typing);
        Object.assign(delivery, typing);
        typingStarted = true;
        stored = JSON.stringify(delivery);
        publish(false);
        return undefined;
      };
      try {
        const result = await active.send(
          delivery.id,
          delivery.englishText,
          delivery.attachments,
          delivery.transport
            ? {
                panelSessionId: state.id,
                transport: delivery.transport,
                earlier: earlierFor(delivery),
                ...(terminal ? { onTyping } : {}),
              }
            : undefined,
        );
        // Released while it was checked; nothing was typed, and the release already stored that.
        if (terminal && !typingStarted && delivery.state === 'failed') return;
        if (result.channelGeneration) delivery.channelGeneration = result.channelGeneration;
        if (result.nativeMessageId) delivery.nativeMessageId = result.nativeMessageId;
        if (result.nativeAfterRevision !== undefined)
          delivery.nativeAfterRevision = result.nativeAfterRevision;
        if (typingStarted && (result.state === 'held' || result.state === 'failed')) {
          // Once typing started the text may be in the terminal: never claim it was held or not sent.
          delivery.state = 'unconfirmed';
          delivery.reason = TYPING_STARTED_REASON;
        } else if (
          // Native acceptance can arrive before the transport finishes. Never downgrade it.
          delivery.state !== 'sent' &&
          !(
            delivery.state === 'queued' &&
            (result.state === 'sending' || result.state === 'unconfirmed')
          )
        ) {
          delivery.state = result.state;
          if (result.reason !== undefined) delivery.reason = result.reason;
          else delete delivery.reason;
          if (
            delivery.state === 'sending' ||
            (delivery.state === 'sent' && active.capabilities.acknowledgement === 'none')
          ) {
            delivery.state = 'unconfirmed';
            delivery.reason ??= 'The adapter cannot confirm delivery';
          }
        }
      } catch (error) {
        if (terminal && !typingStarted && delivery.state === 'failed') return;
        if (terminal && !typingStarted) {
          // The adapter types only after typing-started is stored, so a throw before it typed nothing.
          delivery.state = 'failed';
          delivery.reason = NOT_TYPED_REASON;
        } else if (delivery.state !== 'sent' && delivery.state !== 'queued') {
          delivery.state = 'unconfirmed';
          delivery.reason = error instanceof Error ? error.message : 'Delivery outcome is unknown';
        }
      }
      if (delivery.state !== 'sent' && delivery.state !== 'held') {
        try {
          const evidence = await confirmEvidence(active, delivery);
          if (evidence) markSent(delivery, evidence);
        } catch {
          /* Preserve uncertainty. */
        }
      }
      if (JSON.stringify(delivery) !== stored) {
        deps.store.updateDelivery(copy(delivery));
        clearSubmittedDraft(delivery);
        publish();
      }
      if (delivery.state === 'held') startHeldRecheck();
    } finally {
      dispatching.delete(delivery.id);
    }
  };
  /**
   * Sends held messages in claim order once their gate opens; stops at the first one still held or being checked.
   * Serialized. Only a change of state or reason is stored and broadcast.
   */
  const retryHeld = (): Promise<void> => {
    heldTail = heldTail
      .then(async () => {
        for (;;) {
          const active = connection;
          if (closed || !active) return;
          const next = sameTargetHeld(active.target);
          if (!next) {
            stopHeldRecheck();
            return;
          }
          // Its first send is still checking the terminal; that send re-checks when it ends.
          if (dispatching.has(next.id)) return;
          if (sendGate(state.codingState, active.capabilities, next.transport) !== 'send') {
            const reason = state.codingState === 'disconnected' ? next.reason : holdReason();
            if (reason !== undefined && reason !== next.reason) {
              next.reason = reason;
              deps.store.updateDelivery(copy(next));
              publish(false);
            }
            startHeldRecheck();
            return;
          }
          await dispatchClaimed(next, active);
          if (next.state === 'held') return;
        }
      })
      .catch(() => {
        /* A failed check leaves the message held for the next one. */
      });
    return heldTail;
  };

  const reconcilePending = async (active: CodingConnection) => {
    if (!active.reconcileDelivery) return;
    const generation = connectionGeneration;
    const stillCurrent = () =>
      !closed &&
      connection === active &&
      connectionGeneration === generation &&
      state.target !== undefined &&
      sameTarget(state.target, active.target);
    for (const delivery of state.deliveries) {
      if (!stillCurrent()) return;
      if (!isAwaitingEvidence(delivery) || !sameTarget(delivery.target, active.target)) continue;
      try {
        const evidence = await confirmEvidence(active, delivery);
        if (!stillCurrent()) return;
        if (!evidence || !state.deliveries.includes(delivery) || !isAwaitingEvidence(delivery))
          continue;
        settleWithEvidence(delivery, evidence);
        publish();
      } catch {
        /* Native events trigger status-only checks, never retries of the send. */
      }
    }
  };

  /** Channel deliveries Claude has read into its context and not yet answered with a finished turn. */
  const seenChannel = new Set<string>();
  const consumeEvent = async (event: AgentEvent, active: CodingConnection) => {
    if (event.type === 'usage') {
      deps.onUsage?.(event.usage);
      return;
    }
    if (event.type === 'channel-seen') {
      seenChannel.add(event.requestId);
      if (seenChannel.size > SEEN_CHANNEL_LIMIT) {
        const oldest = seenChannel.values().next();
        if (!oldest.done) seenChannel.delete(oldest.value);
      }
      return;
    }
    if (event.type === 'gap') {
      state.sourceGaps = [...new Set([...(state.sourceGaps ?? []), event.reason])].slice(-20);
      publish();
      return;
    }
    if (event.type === 'status') {
      state.codingState = event.state;
      publish();
      await reconcilePending(active);
      void retryHeld();
      return;
    }
    if (event.type === 'message') {
      const merged = mergeMessage(event.message);
      if (merged) {
        publish();
        translateIfNeeded(copy(event.message));
        // Claude's channel prompt can produce a normal native assistant turn
        // without invoking the channel's explicit reply tool. That completed
        // turn is still evidence that Claude answered the oldest handoff.
        if (
          event.message.role === 'assistant' &&
          event.message.complete &&
          !event.message.sourceId.startsWith('channel:') &&
          active.target.agent === 'claude'
        ) {
          const pending = state.deliveries.filter(
            (item) =>
              item.transport === 'channel' &&
              ['sending', 'queued'].includes(item.state) &&
              sameTarget(item.target, active.target),
          );
          // A turn answers every channel message Claude read during it. Without that
          // evidence (older transcripts), it answers only the oldest handoff.
          const seen = pending.filter((item) => seenChannel.has(item.id));
          for (const delivery of seen.length ? seen : pending.slice(0, 1)) {
            delivery.state = 'sent';
            delete delivery.reason;
            seenChannel.delete(delivery.id);
            deps.store.updateDelivery(copy(delivery));
            clearSubmittedDraft(delivery);
          }
          if (pending.length) publish();
        }
      }
      // Queue receipt IDs can differ from accepted native UserMessage client IDs.
      // Let the adapter verify its exact acceptance evidence after it arrives.
      if (event.message.role === 'user') await reconcilePending(active);
      return;
    }
    if (event.type === 'delivery') {
      const delivery = state.deliveries.find(
        (item) => item.id === event.requestId || item.nativeMessageId === event.requestId,
      );
      if (
        !delivery ||
        delivery.state === 'sent' ||
        (delivery.state === 'queued' &&
          (event.state === 'sending' || event.state === 'unconfirmed'))
      )
        return;
      if (
        event.state === 'sent' &&
        (delivery.transport === 'channel' || delivery.attachments?.length) &&
        connection?.reconcileDelivery
      ) {
        const active = connection;
        try {
          if (!(await confirmEvidence(active, delivery)) || closed || connection !== active) return;
        } catch {
          return;
        }
      }
      delivery.state = event.state;
      if (event.reason === undefined) delete delivery.reason;
      else delivery.reason = event.reason;
      deps.store.updateDelivery(copy(delivery));
      clearSubmittedDraft(delivery);
      publish();
    }
  };

  const watchEvents = async (active: CodingConnection, signal: AbortSignal) => {
    try {
      for await (const event of active.events(signal)) {
        if (connection !== active || signal.aborted) return;
        await consumeEvent(event, active);
      }
      if (!signal.aborted && connection === active) {
        state.codingState = 'disconnected';
        publish();
      }
    } catch {
      if (!signal.aborted && connection === active) {
        state.codingState = 'disconnected';
        publish();
      }
    }
  };

  const requireOpen = () => {
    if (closed) throw new Error('Workflow is closed');
  };

  const requireCurrentContext = (version: number) => {
    if (version !== languageContextVersion) throw new Error('Project context changed');
  };

  const languageOperation = <T>(
    contextVersion: number,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const result = languageTail.then(async () => {
      requireOpen();
      requireCurrentContext(contextVersion);
      const abort = new AbortController();
      activeLanguageOperations.add(abort);
      try {
        return await operation(abort.signal);
      } finally {
        activeLanguageOperations.delete(abort);
      }
    });
    languageTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const workflow: Workflow = {
    async reviewFileText(text, mode, signal) {
      requireOpen();
      signal.throwIfAborted();
      if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_CHARS)
        throw new Error(`File review requires text of at most ${MAX_TEXT_CHARS} characters`);
      if (mode !== 'summary' && mode !== 'translation') throw new Error('Invalid file review mode');
      const version = languageContextVersion;
      const result = await languageOperation(version, async (operationSignal) => {
        const combined = AbortSignal.any([signal, operationSignal]);
        combined.throwIfAborted();
        const result =
          mode === 'summary'
            ? await deps.languageSession.summarize(text, settings.assist, combined)
            : await deps.languageSession.translate(text, languageName(settings.reply), combined);
        combined.throwIfAborted();
        return result.trim();
      });
      requireOpen();
      requireCurrentContext(version);
      if (!result || (mode === 'summary' && result.length > MAX_SUMMARY_CHARS))
        throw new Error('Invalid file review output');
      return result;
    },
    summarizeResponse: (source) => summaries.summarize(source),
    async connect(target) {
      requireOpen();
      const generation = ++connectionGeneration;
      const adapter = deps.agents.find((candidate) => candidate.kind === target.agent);
      if (!adapter) throw new Error(`No adapter for ${target.agent}`);
      eventAbort?.abort();
      if (connection) await connection.detach();
      connection = undefined;
      state.codingState = 'disconnected';
      const attached = await adapter.attach(copy(target), { panelSessionId: state.id });
      if (closed) {
        await attached.detach();
        throw new Error('Workflow is closed');
      }
      if (generation !== connectionGeneration) {
        await attached.detach();
        return;
      }
      if (!sameTarget(attached.target, target))
        throw new Error('Adapter attached to a different target');
      connection = attached;
      state.capabilities = copy(attached.capabilities);
      delete state.historyCursor;
      const targetUnchanged = state.target !== undefined && sameTarget(state.target, target);
      const previousMessages = targetUnchanged ? state.codingMessages : [];
      state.target = copy(target);
      state.codingState = 'disconnected';
      state.codingMessages = targetUnchanged ? copy(previousMessages) : [];
      if (!targetUnchanged) state.sourceRevision = 0;
      if (attached.capabilities.history) {
        // A bounded lookback failure must not prevent the independently verified
        // live stream from starting. Preserve cached messages and report the gap.
        const history = await attached.history().catch((error: unknown) => {
          if (!closed && generation === connectionGeneration && connection === attached) {
            const detail = error instanceof Error ? error.message : 'Read failed';
            state.sourceGaps = [
              ...new Set([...(state.sourceGaps ?? []), `Older history unavailable: ${detail}`]),
            ].slice(-20);
          }
          return { messages: [] as AgentMessage[], next: undefined };
        });
        if (closed) {
          if (connection === attached) connection = undefined;
          await attached.detach();
          throw new Error('Workflow is closed');
        }
        if (generation !== connectionGeneration || connection !== attached) {
          await attached.detach();
          return;
        }
        if (history.next) state.historyCursor = history.next;
        const merged = new Map(state.codingMessages.map((message) => [message.sourceId, message]));
        let changes = 0;
        for (const message of history.messages) {
          const current = merged.get(message.sourceId);
          if (!current || current.revision < message.revision) {
            merged.set(message.sourceId, copy(message));
            changes += 1;
          }
        }
        state.codingMessages = [...merged.values()];
        orderAgentMessages(state.codingMessages, target.agent);
        state.sourceRevision += changes;
      }
      if (attached.reconcileDelivery)
        for (const delivery of state.deliveries) {
          if (!isAwaitingEvidence(delivery) || !sameTarget(delivery.target, target)) continue;
          try {
            const evidence = await confirmEvidence(attached, delivery);
            if (evidence) settleWithEvidence(delivery, evidence);
          } catch {
            /* Keep unresolved work if native history cannot be verified. */
          }
        }
      publish();
      for (const message of state.codingMessages) translateIfNeeded(copy(message));
      eventAbort = new AbortController();
      void watchEvents(attached, eventAbort.signal);
      void retryHeld();
    },

    ingestSourceMessage(message) {
      requireOpen();
      if (
        !message.sourceSessionId ||
        !message.sourceId ||
        typeof message.text !== 'string' ||
        !['assistant', 'user'].includes(message.role) ||
        !Number.isSafeInteger(message.sequence) ||
        message.sequence < 0
      ) {
        throw new Error('Invalid source message');
      }
      if (state.target && state.target.sessionRef !== message.sourceSessionId)
        throw new Error('Source session does not match active target');
      const normalized: AgentMessage = {
        sourceId: message.sourceId,
        revision: message.sequence,
        role: message.role,
        text: message.text,
        complete: message.complete ?? true,
        ...(message.timestamp ? { timestamp: message.timestamp } : {}),
      };
      if (!mergeMessage(normalized, message.cursor, message.sourceSessionId)) {
        if (message.sequence >= (state.sourceSequence ?? -1)) {
          state.sourceSessionId = message.sourceSessionId;
          state.sourceSequence = message.sequence;
          if (message.cursor) state.sourceCursor = message.cursor;
          publish();
        }
        translateIfNeeded(normalized);
        return;
      }
      publish();
      translateIfNeeded(normalized);
    },

    async loadOlderHistory() {
      requireOpen();
      const active = connection;
      if (!active) throw new Error('Agent is disconnected');
      const cursor = state.historyCursor;
      if (!cursor) return;
      const page = await active.history(cursor);
      requireOpen();
      if (connection !== active || state.historyCursor !== cursor) return;
      const merged = new Map(page.messages.map((message) => [message.sourceId, copy(message)]));
      for (const message of state.codingMessages) {
        const older = merged.get(message.sourceId);
        if (!older || older.revision <= message.revision) merged.set(message.sourceId, message);
      }
      state.codingMessages = [...merged.values()];
      orderAgentMessages(state.codingMessages, state.target?.agent);
      if (page.next) state.historyCursor = page.next;
      else delete state.historyCursor;
      publish();
    },

    async discuss(text, attachments = []) {
      requireOpen();
      if (!text.trim() && !attachments.length)
        throw new Error('Discussion text or image is required');
      assertAttachmentLimits(attachments);
      attachments = await resolveReferences(attachments);
      const contextVersion = languageContextVersion;
      return languageOperation(contextVersion, async (signal) => {
        requireOpen();
        const known = new Map(
          state.discussion.flatMap((t) => t.attachments ?? []).map((a) => [a.id, a]),
        );
        let nextIndex = Math.max(0, ...[...known.values()].map((a) => a.index ?? 0));
        const indexed = attachments.map((a) => {
          const existing = known.get(a.id);
          if (existing && !isFileReference(a)) return existing;
          const image = { ...a, index: a.index ?? ++nextIndex };
          nextIndex = Math.max(nextIndex, image.index);
          known.set(a.id, image);
          return image;
        });
        state.discussion.push({
          id: randomUUID(),
          complete: true,
          role: 'user',
          text,
          ...(indexed.length ? { attachments: indexed } : {}),
        });
        const assistantId = randomUUID();
        const assistantIndex =
          state.discussion.push({ id: assistantId, complete: false, role: 'assistant', text: '' }) -
          1;
        publish();
        let reply = '';
        const input = await withFileContext(
          languageInput(state.discussion.slice(0, assistantIndex)),
        );
        // Reply attachments belong only to this exchange, not historical context.
        const references = indexed;
        for await (const chunk of deps.languageSession.discuss(input, signal)) {
          requireOpen();
          requireCurrentContext(contextVersion);
          reply += chunk;
          state.discussion[assistantIndex] = {
            id: assistantId,
            complete: false,
            role: 'assistant',
            text: reply,
            ...(references.length ? { attachments: references } : {}),
          };
          publish();
        }
        requireOpen();
        requireCurrentContext(contextVersion);
        state.discussion[assistantIndex]!.complete = true;
        publish();
        return reply;
      });
    },

    releaseComposer(requestId) {
      requireOpen();
      const id = `composer-${requestId}`;
      if (state.composerDraft?.id !== id) return;
      const delivery = state.deliveries.find((d) => d.draftId === id);
      if (composerOperation || delivery?.state === 'sending')
        throw new Error('Delivery is still in progress');
      if (!delivery || !['unconfirmed', 'queued', 'failed', 'held'].includes(delivery.state))
        throw new Error('Delivery cannot be released');
      if (delivery.state === 'held') cancelHeld(delivery);
      deps.store.releaseComposerAttempt(state.id, requestId);
      delete state.composerDraft;
      publish(false);
    },

    async checkComposer(requestId) {
      requireOpen();
      const prior = state.deliveries.find((d) => d.draftId === `composer-${requestId}`);
      if (prior?.state === 'held') {
        await retryHeld();
        return;
      }
      if (
        !prior ||
        prior.state === 'sent' ||
        !connection?.reconcileDelivery ||
        !state.target ||
        !sameTarget(prior.target, state.target)
      )
        return;
      try {
        const evidence = await confirmEvidence(connection, prior);
        if (evidence) {
          settleWithEvidence(prior, evidence);
          publish();
        }
      } catch {
        /* A status check never sends or discards content. */
      }
    },

    async sendComposer(requestId, text, attachments = [], transport) {
      requireOpen();
      if (
        !REQUEST_ID_PATTERN.test(requestId) ||
        typeof text !== 'string' ||
        (!text.trim() && !attachments.length) ||
        text.length > MAX_TEXT_CHARS ||
        attachments.length > MAX_ATTACHMENTS
      )
        throw new Error('Invalid composer request');
      const id = `composer-${requestId}`;
      const prior = state.deliveries.find((d) => d.draftId === id);
      if (prior) {
        if (
          prior.state !== 'sent' &&
          prior.state !== 'held' &&
          connection?.reconcileDelivery &&
          state.target &&
          sameTarget(prior.target, state.target)
        ) {
          try {
            const evidence = await confirmEvidence(connection, prior);
            if (evidence) {
              settleWithEvidence(prior, evidence);
              publish();
            }
          } catch {
            /* Preserve uncertain delivery. */
          }
        }
        return copy(prior);
      }
      if (composerOperation) throw new Error('Composer delivery is in progress; text preserved');
      const pending =
        state.composerDraft &&
        state.deliveries.find(
          (d) => d.draftId === state.composerDraft!.id && isDeliveryUnresolved(d),
        );
      if (pending)
        throw new Error(
          'Previous composer delivery is unresolved; check its delivery before sending again',
        );
      if (!state.target || !connection || state.codingState === 'disconnected')
        throw new Error('Blocked: agent is working or unavailable');
      assertAttachmentLimits(attachments);
      const target = copy(state.target);
      const active = connection;
      composerOperation = true;
      try {
        // Resolved under the composer lock: no second composer send can start while the route is read.
        const composerTransport = await resolveTransport(target, transport, active);
        if (sendGate(state.codingState, active.capabilities, composerTransport) === 'block')
          throw new Error('Blocked: agent is working or unavailable');
        attachments = await resolveReferences(attachments);
        let draft = state.composerDraft;
        if (!draft || draft.id !== id) {
          const englishText = text.trim()
            ? needsSendTranslation(settings)
              ? await this.translateComposer(text)
              : text
            : 'Read the referenced files and inspect referenced images.';
          if (!state.target || !sameTarget(target, state.target))
            throw new Error('Target changed; text preserved');
          draft = {
            id,
            revision: 1,
            target,
            sourceRevision: state.sourceRevision,
            language: state.language,
            localizedText: text,
            englishText,
            ...(attachments.length ? { attachments: copy(attachments) } : {}),
          };
          state.composerDraft = draft;
          publish();
        } else if (
          draft.localizedText !== text ||
          JSON.stringify(draft.attachments?.map((a) => a.id) ?? []) !==
            JSON.stringify(attachments.map((a) => a.id))
        )
          throw new Error('Composer request changed; text preserved');
        return await this.send(draft.id, draft.revision, composerTransport);
      } finally {
        composerOperation = false;
      }
    },

    async translateComposer(text) {
      requireOpen();
      if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_CHARS)
        throw new Error(`Enter text to translate (at most ${MAX_TEXT_CHARS} characters)`);
      if (!needsSendTranslation(settings)) return text;
      const version = languageContextVersion;
      const result = await languageOperation(version, (signal) =>
        deps.languageSession.translate(text, languageName(settings.send), signal),
      );
      requireOpen();
      requireCurrentContext(version);
      if (!result.trim()) throw new Error('Translation returned no text; your input is preserved');
      return result;
    },

    async prepareDirect(indices, expected) {
      if (reviewOperation) throw new Error('Instruction operation is in progress');
      const validate = () => {
        const current = state.currentDraft;
        if (
          current
            ? !expected || expected.id !== current.id || expected.revision !== current.revision
            : expected !== undefined
        )
          throw new Error('Prepared instruction changed. Confirm replacement again.');
        if (
          current &&
          state.deliveries.some(
            (d) =>
              d.draftId === current.id &&
              d.revision === current.revision &&
              isDeliveryUnresolved(d),
          )
        )
          throw new Error('Delivery outcome is unresolved; instruction preserved');
      };
      validate();
      reviewOperation = true;
      try {
        const draft = await this.prepareReview(indices);
        validate();
        state.currentDraft = copy(draft);
        reviews.delete(draft.id);
        publish();
        return copy(draft);
      } finally {
        reviewOperation = false;
      }
    },

    async sendReview(id, revision, localizedText, transport) {
      requireOpen();
      if (reviewOperation) throw new Error('Instruction operation is in progress');
      const current = state.currentDraft;
      if (!current || current.id !== id || current.revision !== revision) {
        const receipt = state.deliveries.find((d) => d.draftId === id && d.revision === revision);
        if (receipt) return copy(receipt);
        throw new Error('Prepared instruction changed; reopen the review');
      }
      const prior = state.deliveries.find((d) => d.draftId === id && d.revision === revision);
      if (prior && (prior.target.agent === 'claude' || prior.state !== 'failed'))
        return copy(prior);
      if (
        typeof localizedText !== 'string' ||
        !localizedText.trim() ||
        localizedText.length > MAX_TEXT_CHARS
      )
        throw new Error(`A nonempty review of at most ${MAX_TEXT_CHARS} characters is required`);
      if (state.codingState !== 'idle') throw new Error('Blocked: agent is working or unavailable');
      reviewOperation = true;
      try {
        let englishText = current.englishText;
        if (localizedText !== current.localizedText) {
          const version = languageContextVersion;
          const prepared = await languageOperation(version, (signal) =>
            prepareLanguage(
              {
                language: current.language,
                deliveryLanguage: languageName(settings.send),
                projectContext: '',
                codingMessages: [],
                discussion: [],
                selectedDiscussion: [
                  {
                    role: 'user',
                    text: localizedText,
                    ...(current.attachments?.length ? { attachments: current.attachments } : {}),
                  },
                ],
                reviewText: localizedText,
              },
              signal,
            ),
          );
          requireCurrentContext(version);
          if (!prepared.englishText?.trim())
            throw new Error('English preparation failed; review preserved');
          englishText = prepared.englishText;
        }
        if (state.currentDraft?.id !== id || state.currentDraft.revision !== revision)
          throw new Error('Prepared instruction changed');
        const next = {
          ...current,
          localizedText,
          englishText,
          revision: revision + (prior || localizedText !== current.localizedText ? 1 : 0),
        };
        state.currentDraft = next;
        publish();
        return await this.send(next.id, next.revision, transport);
      } finally {
        reviewOperation = false;
      }
    },

    async prepareReview(indices) {
      requireOpen();
      if (
        !Array.isArray(indices) ||
        !indices.length ||
        indices.some(
          (i) =>
            !Number.isSafeInteger(i) ||
            i < 0 ||
            (!state.discussion[i]?.text.trim() && !state.discussion[i]?.attachments?.length),
        )
      )
        throw new Error('Select at least one completed message');
      if (!state.target || !connection) throw new Error('Agent is disconnected');
      const selected = [...new Set(indices)].sort((a, b) => a - b);
      const target = copy(state.target);
      const sourceRevision = state.sourceRevision;
      const version = languageContextVersion;
      const prepared = await languageOperation(version, (signal) => {
        // Capture after earlier discussion work finishes, never a streaming fragment.
        const turns = selected.map((i) => copy(state.discussion[i]!));
        if (turns.reduce((n, turn) => n + turn.text.length, 0) > MAX_TEXT_CHARS)
          throw new Error('Selection is too large; select fewer messages');
        return prepareLanguage({ ...languageInput(), selectedDiscussion: turns }, signal);
      });
      requireOpen();
      requireCurrentContext(version);
      if (!state.target || !sameTarget(target, state.target)) throw new Error('Target changed');
      const attachments = await resolveReferences(
        selected.flatMap((i) => state.discussion[i]?.attachments ?? []),
      );
      requireOpen();
      requireCurrentContext(version);
      if (!state.target || !sameTarget(target, state.target)) throw new Error('Target changed');
      const review: Draft = {
        ...(attachments.length ? { attachments } : {}),
        id: createId('draft'),
        revision: 1,
        target,
        sourceRevision,
        language: state.language,
        ...prepared,
        selectedDiscussion: selected,
      };
      reviews.set(review.id, review);
      return copy(review);
    },

    async approveReview(id, localizedText, expected) {
      requireOpen();
      const review = reviews.get(id);
      if (!review) throw new Error('Review expired. Prepare again; your selections are preserved.');
      if (
        typeof localizedText !== 'string' ||
        !localizedText.trim() ||
        localizedText.length > MAX_TEXT_CHARS
      )
        throw new Error(`A nonempty review of at most ${MAX_TEXT_CHARS} characters is required`);
      const validate = () => {
        requireOpen();
        if (reviews.get(id) !== review) throw new Error('Review already approved or expired');
        if (!state.target || !sameTarget(review.target, state.target))
          throw new Error('Target changed');
        const current = state.currentDraft;
        if (
          current
            ? !expected || expected.id !== current.id || expected.revision !== current.revision
            : expected !== undefined
        )
          throw new Error('Queue changed. Review the existing instruction before replacing it.');
        if (
          current &&
          state.deliveries.some(
            (d) =>
              d.draftId === current.id &&
              d.revision === current.revision &&
              isDeliveryUnresolved(d),
          )
        )
          throw new Error(
            'Delivery is still pending or unconfirmed. Keep this review until its outcome is known.',
          );
      };
      validate();
      let englishText = review.englishText;
      if (localizedText !== review.localizedText) {
        const version = languageContextVersion;
        const prepared = await languageOperation(version, (signal) =>
          prepareLanguage(
            {
              language: review.language,
              deliveryLanguage: languageName(settings.send),
              projectContext: '',
              codingMessages: [],
              discussion: [],
              selectedDiscussion: [
                {
                  role: 'user',
                  text: localizedText,
                  ...(review.attachments?.length ? { attachments: review.attachments } : {}),
                },
              ],
              reviewText: localizedText,
            },
            signal,
          ),
        );
        requireCurrentContext(version);
        if (!prepared.englishText?.trim())
          throw new Error('English preparation failed; review preserved');
        englishText = prepared.englishText;
      }
      // Generation may take time: recheck both the destination and replacement approval.
      validate();
      state.currentDraft = { ...copy(review), localizedText, englishText };
      reviews.delete(id);
      publish();
      return copy(state.currentDraft);
    },

    editApproved(id, revision, englishText) {
      requireOpen();
      const current = state.currentDraft;
      if (!current || current.id !== id || current.revision !== revision)
        throw new Error('Queue changed; reopen the instruction');
      if (!englishText?.trim() || englishText.length > MAX_INSTRUCTION_CHARS)
        throw new Error('A nonempty instruction is required');
      if (
        state.deliveries.some(
          (d) => d.draftId === id && d.revision === revision && isDeliveryUnresolved(d),
        )
      )
        throw new Error('Cannot edit an instruction with an unresolved delivery');
      state.currentDraft = { ...current, revision: revision + 1, englishText };
      publish();
      return copy(state.currentDraft);
    },

    async prepare() {
      requireOpen();
      if (!state.target || !connection || state.codingState === 'disconnected') {
        throw new Error('Agent is disconnected');
      }
      const target = copy(state.target);
      const sourceRevision = state.sourceRevision;
      const contextVersion = languageContextVersion;
      const prepared = await languageOperation(contextVersion, (signal) =>
        prepareLanguage(languageInput(), signal),
      );
      requireOpen();
      requireCurrentContext(contextVersion);
      if (!state.target || !sameTarget(target, state.target)) throw new Error('Target changed');
      if (sourceRevision !== state.sourceRevision) throw new Error('Source revision changed');
      const attachments = await resolveReferences(
        state.discussion.slice(-16).flatMap((t) => t.attachments ?? []),
      );
      requireOpen();
      requireCurrentContext(contextVersion);
      if (!state.target || !sameTarget(target, state.target)) throw new Error('Target changed');
      const draft: Draft = {
        ...(attachments.length ? { attachments } : {}),
        id: createId('draft'),
        revision: 1,
        target,
        sourceRevision,
        language: state.language,
        localizedText: prepared.localizedText,
        englishText: prepared.englishText,
      };
      state.currentDraft = draft;
      publish();
      return copy(draft);
    },

    async reviseDraft(id, text) {
      requireOpen();
      const current = state.currentDraft;
      if (!current || current.id !== id) throw new Error('Draft not found');
      if (!text.trim()) throw new Error('Draft text is required');
      const expectedRevision = current.revision;
      const expectedTarget = copy(current.target);
      const sourceRevision = state.sourceRevision;
      const contextVersion = languageContextVersion;
      const prepared = await languageOperation(contextVersion, (signal) =>
        prepareLanguage(
          {
            ...languageInput([]),
            selectedDiscussion: [
              {
                role: 'user',
                text: current.englishText,
                ...(current.attachments?.length ? { attachments: current.attachments } : {}),
              },
              { role: 'user', text },
            ],
          },
          signal,
        ),
      );
      requireOpen();
      requireCurrentContext(contextVersion);
      if (
        !state.currentDraft ||
        state.currentDraft.id !== id ||
        state.currentDraft.revision !== expectedRevision
      )
        throw new Error('Stale draft revision');
      if (!state.target || !sameTarget(expectedTarget, state.target))
        throw new Error('Target changed');
      if (sourceRevision !== state.sourceRevision) throw new Error('Source revision changed');
      const revised: Draft = {
        ...current,
        revision: current.revision + 1,
        sourceRevision,
        localizedText: prepared.localizedText,
        englishText: prepared.englishText,
      };
      state.currentDraft = revised;
      publish();
      return copy(revised);
    },

    resetInstruction(id, revision) {
      requireOpen();
      if (reviewOperation)
        throw new Error('Instruction operation is in progress; try reset again when it finishes');
      const draft = state.currentDraft;
      if (!draft || draft.id !== id || draft.revision !== revision)
        throw new Error('Instruction changed; reopen it before resetting');
      delete state.currentDraft;
      reviews.delete(id);
      // Reset detaches the review and cancels a message still held; it never cancels or forgets one already handed over.
      cancelHeldFor(id);
      publish();
    },

    discardDraft(id) {
      requireOpen();
      if (!state.currentDraft || state.currentDraft.id !== id) throw new Error('Draft not found');
      delete state.currentDraft;
      cancelHeldFor(id);
      publish();
    },

    async send(id, revision, transport) {
      requireOpen();
      const prior = state.deliveries.find(
        (delivery) => delivery.draftId === id && delivery.revision === revision,
      );
      if (prior) return copy(prior);
      if (transport !== undefined && !isDeliveryTransport(transport))
        throw new Error('Invalid delivery transport');
      const draft = state.currentDraft?.id === id ? state.currentDraft : state.composerDraft;
      if (!draft || draft.id !== id) throw new Error('Draft not found');
      if (draft.revision !== revision) throw new Error('Stale draft revision');
      if (!state.target || !sameTarget(draft.target, state.target))
        throw new Error('Target changed');
      if (!connection || state.codingState === 'disconnected')
        throw new Error('Agent is disconnected');
      if (draft.attachments?.length && !supportsReferences(draft.attachments))
        throw new Error(
          'This agent connection does not support image attachments or file references; instruction preserved',
        );
      const deliveryConnection = connection;
      const deliveryTransport = await resolveTransport(draft.target, transport, deliveryConnection);
      const gate = sendGate(state.codingState, deliveryConnection.capabilities, deliveryTransport);
      if (gate === 'block')
        throw new Error(
          state.codingState === 'approval-required'
            ? 'Agent approval is required'
            : 'Agent is busy',
        );
      const attachments = draft.attachments?.length
        ? await resolveReferences(draft.attachments)
        : [];
      const englishText = draft.englishText;
      requireOpen();
      if (
        connection !== deliveryConnection ||
        !state.target ||
        !sameTarget(draft.target, state.target)
      )
        throw new Error('Target changed');
      if (
        state.currentDraft?.id === id
          ? state.currentDraft.revision !== revision
          : state.composerDraft?.id !== id || state.composerDraft.revision !== revision
      )
        throw new Error('Draft changed');
      // A send waits behind an earlier held one, so messages reach the session in the order they were sent.
      const behind = sameTargetHeld(draft.target) !== undefined;
      const holdNow = gate === 'hold' || behind;
      const delivery: Delivery = {
        id: createId('delivery'),
        draftId: draft.id,
        revision: draft.revision,
        target: copy(draft.target),
        englishText,
        ...(attachments.length
          ? {
              attachments: copy(attachments),
              ...(attachments.every(isFileReference)
                ? { referenceFormat: 'manifest-v1' as const }
                : {}),
            }
          : {}),
        // A terminal send is stored as held until its adapter reports typing, so a crash before typing retries it once.
        state: holdNow || deliveryTransport === 'tmux' ? 'held' : 'sending',
        ...(holdNow
          ? { reason: behind ? EARLIER_HELD_REASON : holdReason() }
          : deliveryTransport === 'tmux'
            ? { reason: CHECKING_TERMINAL_REASON }
            : {}),
        ...(deliveryTransport ? { transport: deliveryTransport } : {}),
      };
      if (!deps.store.claimDelivery(copy(delivery))) {
        const latest = deps.store.load(state.id);
        const existing = latest?.deliveries.find(
          (item) => item.draftId === id && item.revision === revision,
        );
        if (!existing) throw new Error('Delivery was claimed by another workflow');
        return copy(existing);
      }
      state.deliveries.push(delivery);
      publish();
      if (holdNow) {
        startHeldRecheck();
        return copy(delivery);
      }
      await dispatchClaimed(delivery, deliveryConnection);
      // Messages that waited behind this one go now instead of at the next re-check.
      if (delivery.state !== 'held' && sameTargetHeld(delivery.target)) void retryHeld();
      return copy(delivery);
    },

    async deliveryRoute() {
      requireOpen();
      const active = connection;
      if (!active || !state.target) return { transport: null, reason: NOT_CONNECTED_REASON };
      if (!active.deliveryRoute) return { transport: 'channel' };
      try {
        return await active.deliveryRoute();
      } catch {
        return { transport: null, reason: ROUTE_UNAVAILABLE_REASON };
      }
    },

    async invalidateProjectContext() {
      requireOpen();
      languageContextVersion += 1;
      const contextVersion = languageContextVersion;
      for (const abort of activeLanguageOperations) abort.abort();
      const reset = languageTail.then(async () => {
        requireOpen();
        requireCurrentContext(contextVersion);
        await deps.languageSession.resetContext();
        requireOpen();
        requireCurrentContext(contextVersion);
      });
      languageTail = reset.then(
        () => undefined,
        () => undefined,
      );
      await reset;
    },

    snapshot() {
      state.languageSettings = settings;
      return copy(state);
    },

    refreshLanguageSettings() {
      if (closed) return;
      const previous = settings;
      settings = readSettings();
      if (JSON.stringify(previous) === JSON.stringify(settings)) return;
      if (!needsReplyTranslation(settings)) dropPendingTranslations();
      if (
        needsReplyTranslation(settings) &&
        (!needsReplyTranslation(previous) || previous.reply !== settings.reply)
      ) {
        const recent = state.codingMessages
          .filter((m) => m.role === 'assistant' && m.complete && m.translationStatus !== 'complete')
          .slice(-20);
        for (const message of recent) translateIfNeeded(message);
      }
      publish();
    },

    async translateMessage(sourceId) {
      requireOpen();
      const message = state.codingMessages.find((m) => m.sourceId === sourceId);
      if (!message || message.role !== 'assistant' || !message.complete)
        throw new Error('Message unavailable for translation');
      if (!needsReplyTranslation(settings)) throw new Error('Translation is off for this session');
      translateIfNeeded(message);
    },

    subscribe(listener) {
      requireOpen();
      listeners.add(listener);
      listener(copy(state));
      return () => {
        listeners.delete(listener);
      };
    },

    async close() {
      summaries.close();
      if (closed) return;
      closed = true;
      stopHeldRecheck();
      connectionGeneration += 1;
      eventAbort?.abort();
      for (const abort of activeLanguageOperations) abort.abort();
      if (connection) await connection.detach();
      await deps.languageSession.close();
      listeners.clear();
    },
  };

  return workflow;
}
