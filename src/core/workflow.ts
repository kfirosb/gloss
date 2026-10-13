import { isFileReference, uniqueReferences, type FileRegistry, type FileReference } from './file-references.js';
import type { Attachment } from './contracts.js';
import { canSendWhileWorking, isDeliverySubmitted } from './contracts.js';
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
import {randomUUID} from 'node:crypto';
import {ResponseSummaries} from './response-summaries.js';
import type {SummarySource,ResponseSummary} from './summary-contracts.js';
import { languageName, legacyLanguageSettings, needsReplyTranslation, needsSendTranslation, type LanguageSettings } from './language-settings.js';
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
}

export interface Workflow {
  reviewFileText(text:string,mode:'summary'|'translation',signal:AbortSignal):Promise<string>;
  summarizeResponse(source:SummarySource):Promise<ResponseSummary>;
  connect(target: Target): Promise<void>;
  ingestSourceMessage(message: SourceMessage): void;
  loadOlderHistory(): Promise<void>;
  discuss(text: string, attachments?: Attachment[]): Promise<string>;
  prepare(): Promise<Draft>;
  checkComposer(requestId: string): Promise<void>;
  releaseComposer(requestId: string): void;
  sendComposer(requestId: string, text: string, attachments?: Attachment[], transport?: SendContext['transport']): Promise<Delivery>;
  translateComposer(text: string): Promise<string>;
  refreshLanguageSettings(): void;
  translateMessage(sourceId: string): Promise<void>;
  prepareDirect(indices: number[], expected?: { id: string; revision: number }): Promise<Draft>;
  sendReview(id: string, revision: number, localizedText: string, transport?: SendContext['transport']): Promise<Delivery>;
  prepareReview(indices: number[]): Promise<Draft>;
  approveReview(id: string, localizedText: string, expected?: { id: string; revision: number }): Promise<Draft>;
  editApproved(id: string, revision: number, englishText: string): Draft;
  reviseDraft(id: string, text: string): Promise<Draft>;
  resetInstruction(id: string, revision: number): void;
  discardDraft(id: string): void;
  send(id: string, revision: number, transport?: SendContext['transport']): Promise<Delivery>;
  invalidateProjectContext(): Promise<void>;
  snapshot(): ConversationSnapshot;
  subscribe(listener: (snapshot: ConversationSnapshot) => void): () => void;
  close(): Promise<void>;
}

const copy = <T>(value: T): T => structuredClone(value);

const sameTarget = (left: Target, right: Target) =>
  left.agent === right.agent &&
  left.sessionRef === right.sessionRef &&
  left.projectId === right.projectId;

export function createWorkflow(deps: WorkflowDependencies): Workflow {
  const createId = deps.createId ?? ((prefix: 'draft' | 'delivery') =>
    `${prefix}-${globalThis.crypto.randomUUID()}`);
  const restored = deps.store.load(deps.conversationId);
  let state: ConversationSnapshot = restored ? { ...restored, codingState: 'disconnected' } : {
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
  let lastGoodSettings: LanguageSettings | undefined; let settingsWarned = false;
  const readSettings = (): LanguageSettings => {
    try { return lastGoodSettings = deps.languageSettings?.() ?? legacyLanguageSettings(deps.language); }
    catch (error) { if (!settingsWarned) { settingsWarned = true; console.warn('Language settings unavailable; using last known settings', error); } return lastGoodSettings ?? legacyLanguageSettings(deps.language); }
  };
  let settings: LanguageSettings = readSettings();
  state.languageSettings = settings;
  state.language = settings.assist;
  let connection: CodingConnection | undefined;
  state.discussion=state.discussion.map((turn,index)=>({...turn,id:turn.id??`${state.id}:legacy:${index}`,complete:turn.complete??Boolean(turn.text.trim())}));
  let connectionGeneration = 0;
  let eventAbort: AbortController | undefined;
  let closed = false;
  let languageContextVersion = 0;
  let languageTail: Promise<void> = Promise.resolve();
  const activeLanguageOperations = new Set<AbortController>();
  const summaries=new ResponseSummaries(()=>state,deps.store,deps.languageSession,deps.languageModel);
  const listeners = new Set<(snapshot: ConversationSnapshot) => void>();
  let composerOperation = false;
  let reviewOperation = false;
  const reviews = new Map<string, Draft>();
  const translating = new Set<string>();
  const mergeMessage = (message: AgentMessage, cursor?: string, sourceSessionId?: string) => {
    const current = state.codingMessages.findIndex(item => item.sourceId === message.sourceId);
    if (current >= 0 && state.codingMessages[current]!.revision >= message.revision) return false;
    if (current >= 0) state.codingMessages[current] = copy(message);
    else state.codingMessages.push(copy(message));
    orderAgentMessages(state.codingMessages, state.target?.agent);
    if (sourceSessionId) {
      if (state.sourceSessionId !== sourceSessionId || message.revision >= (state.sourceSequence ?? -1)) {
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
    for (const message of state.codingMessages) if (message.translationStatus === 'pending') { delete message.translationStatus; changed = true; }
    return changed;
  };
  if (!needsReplyTranslation(settings)) dropPendingTranslations();
  let translatingOne = false;
  const pumpTranslations = async () => {
    if (closed || translatingOne || !translationQueue.size) return;
    if (!needsReplyTranslation(settings)) { dropPendingTranslations(); return; }
    const source = orderAgentMessages([...translationQueue.values()], state.target?.agent).at(-1)!;
    translationQueue.delete(source.sourceId);
    translatingOne = true;
    const target = settings.reply;
    const generation = connectionGeneration;
    const abort = new AbortController();
    activeLanguageOperations.add(abort);
    try {
      const result = await translateMessageResult({ sourceScope: state.id, sourceId: source.sourceId, sourceRevision: source.revision, text: source.text, complete: source.complete, language: target, promptLanguage: languageName(target), model: state.languageModel, promptVersion: TRANSLATION_PROMPT_VERSION, signal: abort.signal }, { store: deps.store, session: deps.languageSession });
      const current = state.codingMessages.find(message => message.sourceId === source.sourceId);
      if (!closed && generation === connectionGeneration && current?.revision === source.revision && settings.reply === target && needsReplyTranslation(settings)) {
        current.translatedText = result.text;
        current.translationStatus = result.status === 'complete' ? 'complete' : 'error';
        publish();
      }
      else if (!closed && generation === connectionGeneration && current?.revision === source.revision && current.translationStatus === 'pending') { delete current.translationStatus; publish(); }
    } finally {
      activeLanguageOperations.delete(abort);
      translating.delete(source.sourceId);
      translatingOne = false;
      if (!closed) void pumpTranslations();
    }
  };
  const translateIfNeeded = (source: AgentMessage) => {
    if (!needsReplyTranslation(settings)) return;
    const current = state.codingMessages.find(message => message.sourceId === source.sourceId);
    if (!source.complete || !current || current.translationStatus === 'complete') return;
    if (translating.has(source.sourceId)) return;
    translating.add(source.sourceId);
    current.translationStatus = 'pending';
    translationQueue.set(source.sourceId, copy(source));
    publish();
    queueMicrotask(() => { void pumpTranslations(); });
  };

  const publish = (persist = true) => {
    state.languageSettings = settings; state.language = settings.assist;
    if (persist) deps.store.save(copy(state));
    for (const listener of listeners) listener(copy(state));
  };

  const languageInput = (discussion = state.discussion): LanguageInput => ({
    language: settings.assist,
    deliveryLanguage: languageName(settings.send),
    projectContext: typeof deps.projectContext === 'function' ? deps.projectContext() : deps.projectContext,
    codingMessages: copy(state.codingMessages),
    discussion: copy(discussion),
  });

  const resolveReferences = async (attachments: Attachment[] = []) => {
    const files = uniqueReferences(attachments);
    if (files.some(f => isFileReference(f) && f.sessionId !== state.id)) throw new Error('File belongs to another session');
    if (!deps.files) return copy(files);
    const resolved = (await Promise.all(files.map(f => deps.files!.resolve(state.id, [f.id])))).flat();
    for (const file of resolved) {
      const captured = files.find(f => f.id === file.id)!;
      if (captured.path !== file.path || (isFileReference(captured) && (captured.worktreePath !== file.worktreePath || captured.kind !== file.kind || captured.index !== file.index))) throw new Error('Captured reference changed');
    }
    return resolved;
  };
  const withFileContext = async (input: LanguageInput): Promise<LanguageInput> => {
    const turns = input.selectedDiscussion ?? input.discussion.slice(-16);
    const files = await resolveReferences(turns.flatMap(t => t.attachments ?? []));
    const normalized = files.filter(isFileReference);
    const normalizeTurns = (items:LanguageInput['discussion']) => items.map(turn => ({...turn, ...(turn.attachments ? {attachments: uniqueReferences(turn.attachments).map(f => files.find(resolved => resolved.id === f.id) ?? f)} : {})}));
    return { ...input, discussion: normalizeTurns(input.discussion), ...(input.selectedDiscussion ? {selectedDiscussion:normalizeTurns(input.selectedDiscussion)} : {}), ...(normalized.length && deps.readFileContext ? { fileContext: await deps.readFileContext(normalized) } : {}) };
  };
  const prepareLanguage = async (input:LanguageInput, signal:AbortSignal) => deps.languageSession.prepare(await withFileContext(input), signal);
  const supportsReferences = (files:Attachment[]) => files.every(f => f.kind === 'file' ? connection?.capabilities.fileReferences : connection?.capabilities.imageAttachments || connection?.capabilities.fileReferences);

  const clearSubmittedDraft = (delivery: Delivery) => {
    if (isDeliverySubmitted(delivery) && state.composerDraft?.id === delivery.draftId && state.composerDraft.revision === delivery.revision) delete state.composerDraft;
    const draft = state.currentDraft;
    if (isDeliverySubmitted(delivery) && draft?.id === delivery.draftId && draft.revision === delivery.revision && sameTarget(draft.target, delivery.target)) {
      delete state.currentDraft;
    }
  };

  // Recover a stop between persisting the handoff and saving draft cleanup.
  for (const delivery of state.deliveries) clearSubmittedDraft(delivery);

  const reconcilePending = async (active: CodingConnection) => {
    if (!active.reconcileDelivery) return;
    const generation = connectionGeneration;
    const stillCurrent = () => !closed && connection === active && connectionGeneration === generation && state.target !== undefined && sameTarget(state.target, active.target);
    for (const delivery of state.deliveries) {
      if (!stillCurrent()) return;
      if (!['queued', 'sending', 'unconfirmed'].includes(delivery.state) || !sameTarget(delivery.target, active.target)) continue;
      try {
        const accepted = await active.reconcileDelivery(copy(delivery));
        if (!stillCurrent()) return;
        if (!accepted || !state.deliveries.includes(delivery) || !['queued', 'sending', 'unconfirmed'].includes(delivery.state)) continue;
        delivery.state = 'sent'; delete delivery.reason;
        deps.store.updateDelivery(copy(delivery)); clearSubmittedDraft(delivery); publish();
      } catch { /* Native events trigger status-only checks, never retries of the send. */ }
    }
  };

  const consumeEvent = async (event: AgentEvent, active: CodingConnection) => {
    if (event.type === 'gap') {
      state.sourceGaps = [...new Set([...(state.sourceGaps ?? []), event.reason])].slice(-20);
      publish();
      return;
    }
    if (event.type === 'status') {
      state.codingState = event.state;
      publish();
      await reconcilePending(active);
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
        if (event.message.role === 'assistant' && event.message.complete &&
            !event.message.sourceId.startsWith('channel:') && active.target.agent === 'claude') {
          const delivery = state.deliveries.find(item =>
            item.transport === 'channel' && ['sending', 'queued'].includes(item.state) && sameTarget(item.target, active.target),
          );
          if (delivery) {
            delivery.state = 'sent';
            delete delivery.reason;
            deps.store.updateDelivery(copy(delivery));
            clearSubmittedDraft(delivery);
            publish();
          }
        }
      }
      // Queue receipt IDs can differ from accepted native UserMessage client IDs.
      // Let the adapter verify its exact acceptance evidence after it arrives.
      if (event.message.role === 'user') await reconcilePending(active);
      return;
    }
    if (event.type === 'delivery') {
      const delivery = state.deliveries.find((item) => item.id === event.requestId || item.nativeMessageId === event.requestId);
      if (!delivery || delivery.state === 'sent' || (delivery.state === 'queued' && (event.state === 'sending' || event.state === 'unconfirmed'))) return;
      if (event.state === 'sent' && (delivery.transport === 'channel' || delivery.attachments?.length) && connection?.reconcileDelivery) {
        const active = connection;
        try { if (!await active.reconcileDelivery!(copy(delivery)) || closed || connection !== active) return; } catch { return; }
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
    languageTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const workflow: Workflow = {
    async reviewFileText(text,mode,signal) {
      requireOpen();signal.throwIfAborted();
      if(typeof text!=='string'||!text.trim()||text.length>160000)throw new Error('File review requires text of at most 160000 characters');
      if(mode!=='summary'&&mode!=='translation')throw new Error('Invalid file review mode');
      const version=languageContextVersion;
      const result=await languageOperation(version,async operationSignal=>{
        const combined=AbortSignal.any([signal,operationSignal]);combined.throwIfAborted();
        const result=mode==='summary'?await deps.languageSession.summarize(text,settings.assist,combined):await deps.languageSession.translate(text,languageName(settings.reply),combined);
        combined.throwIfAborted();return result.trim();
      });
      requireOpen();requireCurrentContext(version);
      if(!result||(mode==='summary'&&result.length>4000))throw new Error('Invalid file review output');
      return result;
    },
    summarizeResponse:source=>summaries.summarize(source),
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
      if (!sameTarget(attached.target, target)) throw new Error('Adapter attached to a different target');
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
            state.sourceGaps = [...new Set([...(state.sourceGaps ?? []), `Older history unavailable: ${detail}`])].slice(-20);
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
      if (attached.reconcileDelivery) for (const delivery of state.deliveries) {
        if (!['queued', 'sending', 'unconfirmed'].includes(delivery.state) || !sameTarget(delivery.target, target)) continue;
        try {
          if (await attached.reconcileDelivery(delivery)) {
            delivery.state = 'sent'; delete delivery.reason;
            deps.store.updateDelivery(copy(delivery)); clearSubmittedDraft(delivery);
          }
        } catch { /* Keep unresolved work if native history cannot be verified. */ }
      }
      publish();
      for (const message of state.codingMessages) translateIfNeeded(copy(message));
      eventAbort = new AbortController();
      void watchEvents(attached, eventAbort.signal);
    },

    ingestSourceMessage(message) {
      requireOpen();
      if (!message.sourceSessionId || !message.sourceId || typeof message.text !== 'string' || !['assistant', 'user'].includes(message.role) || !Number.isSafeInteger(message.sequence) || message.sequence < 0) {
        throw new Error('Invalid source message');
      }
      if (state.target && state.target.sessionRef !== message.sourceSessionId) throw new Error('Source session does not match active target');
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
      const merged = new Map(page.messages.map(message => [message.sourceId, copy(message)]));
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
      if (!text.trim() && !attachments.length) throw new Error('Discussion text or image is required');
      if (attachments.length > 10 || attachments.filter(f => f.kind !== 'file').length > 4) throw new Error('Attach at most 10 files and 4 images');
      attachments = await resolveReferences(attachments);
      const contextVersion = languageContextVersion;
      return languageOperation(contextVersion, async (signal) => {
        requireOpen();
        const known = new Map(state.discussion.flatMap(t=>t.attachments??[]).map(a=>[a.id,a]));
        let nextIndex = Math.max(0,...[...known.values()].map(a=>a.index??0));
        const indexed=attachments.map(a=>{const existing=known.get(a.id);if(existing && !isFileReference(a))return existing;const image={...a,index:a.index??++nextIndex};nextIndex=Math.max(nextIndex,image.index);known.set(a.id,image);return image;});
        state.discussion.push({ id:randomUUID(),complete:true,role: 'user', text, ...(indexed.length?{attachments:indexed}:{}) });
        const assistantId=randomUUID();
        const assistantIndex = state.discussion.push({ id:assistantId,complete:false,role: 'assistant', text: '' }) - 1;
        publish();
        let reply = '';
        const input = await withFileContext(languageInput(state.discussion.slice(0, assistantIndex)));
        // Reply attachments belong only to this exchange, not historical context.
        const references=indexed;
        for await (const chunk of deps.languageSession.discuss(input, signal)) {
          requireOpen();
          requireCurrentContext(contextVersion);
          reply += chunk;
          state.discussion[assistantIndex] = { id:assistantId,complete:false,role: 'assistant', text: reply, ...(references.length?{attachments:references}:{}) };
          publish();
        }
        requireOpen();
        requireCurrentContext(contextVersion);
        state.discussion[assistantIndex]!.complete=true;
        publish();
        return reply;
      });
    },

    releaseComposer(requestId) {
      requireOpen();
      const id = `composer-${requestId}`;
      if (state.composerDraft?.id !== id) return;
      const delivery = state.deliveries.find(d => d.draftId === id);
      if (composerOperation || delivery?.state === 'sending') throw new Error('Delivery is still in progress');
      if (!delivery || !['unconfirmed', 'queued', 'failed'].includes(delivery.state)) throw new Error('Delivery cannot be released');
      deps.store.releaseComposerAttempt(state.id, requestId);
      delete state.composerDraft;
      publish(false);
    },

    async checkComposer(requestId) {
      requireOpen();
      const prior = state.deliveries.find(d => d.draftId === `composer-${requestId}`);
      if (!prior || prior.state === 'sent' || !connection?.reconcileDelivery || !state.target || !sameTarget(prior.target, state.target)) return;
      try {
        if (await connection.reconcileDelivery(prior)) {
          prior.state = 'sent'; delete prior.reason;
          deps.store.updateDelivery(copy(prior)); clearSubmittedDraft(prior); publish();
        }
      } catch { /* A status check never sends or discards content. */ }
    },

    async sendComposer(requestId, text, attachments = [], transport) {
      requireOpen();
      if (!/^[a-zA-Z0-9-]{1,100}$/.test(requestId) || typeof text !== 'string' || (!text.trim() && !attachments.length) || text.length > 160000 || attachments.length>10) throw new Error('Invalid composer request');
      const id = `composer-${requestId}`;
      const prior = state.deliveries.find(d => d.draftId === id);
      if (prior) {
        if (prior.state !== 'sent' && connection?.reconcileDelivery && state.target && sameTarget(prior.target, state.target)) {
          try { if (await connection.reconcileDelivery(prior)) { prior.state = 'sent'; delete prior.reason; deps.store.updateDelivery(copy(prior)); clearSubmittedDraft(prior); publish(); } } catch { /* Preserve uncertain delivery. */ }
        }
        return copy(prior);
      }
      if (composerOperation) throw new Error('Composer delivery is in progress; text preserved');
      const pending = state.composerDraft && state.deliveries.find(d => d.draftId === state.composerDraft!.id && ['sending', 'queued', 'unconfirmed'].includes(d.state));
      if (pending) throw new Error('Previous composer delivery is unresolved; check its delivery before sending again');
      if (!state.target || !connection || (state.codingState !== 'idle' && !(state.codingState === 'working' && canSendWhileWorking(connection.capabilities, state.target.agent === 'claude' ? (transport ?? 'channel') : transport)))) throw new Error('Blocked: agent is working or unavailable');
      if (attachments.length > 10 || attachments.filter(f => f.kind !== 'file').length > 4) throw new Error('Attach at most 10 files and 4 images');
      const target = copy(state.target);
      composerOperation = true;
      try {
        attachments = await resolveReferences(attachments);
        let draft = state.composerDraft;
        if (!draft || draft.id !== id) {
          const englishText = text.trim() ? (needsSendTranslation(settings) ? await this.translateComposer(text) : text) : 'Read the referenced files and inspect referenced images.';
          if (!state.target || !sameTarget(target, state.target)) throw new Error('Target changed; text preserved');
          draft = { id, revision: 1, target, sourceRevision: state.sourceRevision, language: state.language, localizedText: text, englishText, ...(attachments.length ? { attachments: copy(attachments) } : {}) };
          state.composerDraft = draft;
          publish();
        } else if (draft.localizedText !== text || JSON.stringify(draft.attachments?.map(a=>a.id) ?? []) !== JSON.stringify(attachments.map(a=>a.id))) throw new Error('Composer request changed; text preserved');
        return await this.send(draft.id, draft.revision, transport);
      } finally { composerOperation = false; }
    },

    async translateComposer(text) {
      requireOpen();
      if (typeof text !== 'string' || !text.trim() || text.length > 160000) throw new Error('Enter text to translate (at most 160000 characters)');
      if (!needsSendTranslation(settings)) return text;
      const version = languageContextVersion;
      const result = await languageOperation(version, signal => deps.languageSession.translate(text, languageName(settings.send), signal));
      requireOpen(); requireCurrentContext(version);
      if (!result.trim()) throw new Error('Translation returned no text; your input is preserved');
      return result;
    },

    async prepareDirect(indices, expected) {
      if (reviewOperation) throw new Error('Instruction operation is in progress');
      const validate = () => {
        const current = state.currentDraft;
        if (current ? !expected || expected.id !== current.id || expected.revision !== current.revision : expected !== undefined) throw new Error('Prepared instruction changed. Confirm replacement again.');
        if (current && state.deliveries.some(d => d.draftId === current.id && d.revision === current.revision && ['sending', 'queued', 'unconfirmed'].includes(d.state))) throw new Error('Delivery outcome is unresolved; instruction preserved');
      };
      validate(); reviewOperation = true;
      try {
        const draft = await this.prepareReview(indices);
        validate();
        state.currentDraft = copy(draft);
        reviews.delete(draft.id);
        publish();
        return copy(draft);
      } finally { reviewOperation = false; }
    },

    async sendReview(id, revision, localizedText, transport) {
      requireOpen();
      if (reviewOperation) throw new Error('Instruction operation is in progress');
      const current = state.currentDraft;
      if (!current || current.id !== id || current.revision !== revision) {
        const receipt = state.deliveries.find(d => d.draftId === id && d.revision === revision);
        if (receipt) return copy(receipt);
        throw new Error('Prepared instruction changed; reopen the review');
      }
      const prior = state.deliveries.find(d => d.draftId === id && d.revision === revision);
      if (prior && (prior.target.agent === 'claude' || prior.state !== 'failed')) return copy(prior);
      if (typeof localizedText !== 'string' || !localizedText.trim() || localizedText.length > 160000) throw new Error('A nonempty review of at most 160000 characters is required');
      if (state.codingState !== 'idle') throw new Error('Blocked: agent is working or unavailable');
      reviewOperation = true;
      try {
        let englishText = current.englishText;
        if (localizedText !== current.localizedText) {
          const version = languageContextVersion;
          const prepared = await languageOperation(version, signal => prepareLanguage({
            language: current.language, deliveryLanguage: languageName(settings.send), projectContext: '', codingMessages: [], discussion: [],
            selectedDiscussion: [{ role: 'user', text: localizedText, ...(current.attachments?.length?{attachments:current.attachments}:{}) }], reviewText: localizedText,
          }, signal));
          requireCurrentContext(version);
          if (!prepared.englishText?.trim()) throw new Error('English preparation failed; review preserved');
          englishText = prepared.englishText;
        }
        if (state.currentDraft?.id !== id || state.currentDraft.revision !== revision) throw new Error('Prepared instruction changed');
        const next = { ...current, localizedText, englishText, revision: revision + (prior || localizedText !== current.localizedText ? 1 : 0) };
        state.currentDraft = next;
        publish();
        return await this.send(next.id, next.revision, transport);
      } finally { reviewOperation = false; }
    },

    async prepareReview(indices) {
      requireOpen();
      if (!Array.isArray(indices) || !indices.length || indices.some(i => !Number.isSafeInteger(i) || i < 0 || (!state.discussion[i]?.text.trim() && !state.discussion[i]?.attachments?.length))) throw new Error('Select at least one completed message');
      if (!state.target || !connection) throw new Error('Agent is disconnected');
      const selected = [...new Set(indices)].sort((a, b) => a - b);
      const target = copy(state.target);
      const sourceRevision = state.sourceRevision;
      const version = languageContextVersion;
      const prepared = await languageOperation(version, signal => {
        // Capture after earlier discussion work finishes, never a streaming fragment.
        const turns = selected.map(i => copy(state.discussion[i]!));
        if (turns.reduce((n, turn) => n + turn.text.length, 0) > 160000) throw new Error('Selection is too large; select fewer messages');
        return prepareLanguage({ ...languageInput(), selectedDiscussion: turns }, signal);
      });
      requireOpen(); requireCurrentContext(version);
      if (!state.target || !sameTarget(target, state.target)) throw new Error('Target changed');
      const attachments=await resolveReferences(selected.flatMap(i=>state.discussion[i]?.attachments??[]));
      requireOpen(); requireCurrentContext(version);
      if (!state.target || !sameTarget(target, state.target)) throw new Error('Target changed');
      const review: Draft = { ...(attachments.length?{attachments}:{}), id: createId('draft'), revision: 1, target, sourceRevision, language: state.language, ...prepared, selectedDiscussion: selected };
      reviews.set(review.id, review);
      return copy(review);
    },

    async approveReview(id, localizedText, expected) {
      requireOpen();
      const review = reviews.get(id);
      if (!review) throw new Error('Review expired. Prepare again; your selections are preserved.');
      if (typeof localizedText !== 'string' || !localizedText.trim() || localizedText.length > 160000) throw new Error('A nonempty review of at most 160000 characters is required');
      const validate = () => {
        requireOpen();
        if (reviews.get(id) !== review) throw new Error('Review already approved or expired');
        if (!state.target || !sameTarget(review.target, state.target)) throw new Error('Target changed');
        const current = state.currentDraft;
        if (current ? !expected || expected.id !== current.id || expected.revision !== current.revision : expected !== undefined) throw new Error('Queue changed. Review the existing instruction before replacing it.');
        if (current && state.deliveries.some(d => d.draftId === current.id && d.revision === current.revision && ['sending', 'queued', 'unconfirmed'].includes(d.state))) throw new Error('Delivery is still pending or unconfirmed. Keep this review until its outcome is known.');
      };
      validate();
      let englishText = review.englishText;
      if (localizedText !== review.localizedText) {
        const version = languageContextVersion;
        const prepared = await languageOperation(version, signal => prepareLanguage({
          language: review.language, deliveryLanguage: languageName(settings.send), projectContext: '', codingMessages: [], discussion: [],
          selectedDiscussion: [{ role: 'user', text: localizedText, ...(review.attachments?.length?{attachments:review.attachments}:{}) }], reviewText: localizedText,
        }, signal));
        requireCurrentContext(version);
        if (!prepared.englishText?.trim()) throw new Error('English preparation failed; review preserved');
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
      if (!current || current.id !== id || current.revision !== revision) throw new Error('Queue changed; reopen the instruction');
      if (!englishText?.trim() || englishText.length > 200000) throw new Error('A nonempty instruction is required');
      if (state.deliveries.some(d => d.draftId === id && d.revision === revision && ['sending', 'queued', 'unconfirmed'].includes(d.state))) throw new Error('Cannot edit an instruction with an unresolved delivery');
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
      const prepared = await languageOperation(
        contextVersion,
        (signal) => prepareLanguage(languageInput(), signal),
      );
      requireOpen();
      requireCurrentContext(contextVersion);
      if (!state.target || !sameTarget(target, state.target)) throw new Error('Target changed');
      if (sourceRevision !== state.sourceRevision) throw new Error('Source revision changed');
      const attachments = await resolveReferences(state.discussion.slice(-16).flatMap(t => t.attachments ?? []));
      requireOpen(); requireCurrentContext(contextVersion);
      if (!state.target || !sameTarget(target, state.target)) throw new Error('Target changed');
      const draft: Draft = {
        ...(attachments.length ? {attachments} : {}),
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
      const prepared = await languageOperation(contextVersion, (signal) => prepareLanguage(
        { ...languageInput([]), selectedDiscussion: [
          { role: 'user', text: current.englishText, ...(current.attachments?.length ? {attachments:current.attachments} : {}) },
          { role: 'user', text },
        ] },
        signal,
      ));
      requireOpen();
      requireCurrentContext(contextVersion);
      if (!state.currentDraft || state.currentDraft.id !== id ||
          state.currentDraft.revision !== expectedRevision) throw new Error('Stale draft revision');
      if (!state.target || !sameTarget(expectedTarget, state.target)) throw new Error('Target changed');
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
      if (reviewOperation) throw new Error('Instruction operation is in progress; try reset again when it finishes');
      const draft = state.currentDraft;
      if (!draft || draft.id !== id || draft.revision !== revision) throw new Error('Instruction changed; reopen it before resetting');
      delete state.currentDraft;
      reviews.delete(id);
      // Reset detaches the review, never cancels or forgets a native delivery.
      publish();
    },

    discardDraft(id) {
      requireOpen();
      if (!state.currentDraft || state.currentDraft.id !== id) throw new Error('Draft not found');
      delete state.currentDraft;
      publish();
    },

    async send(id, revision, transport) {
      requireOpen();
      const prior = state.deliveries.find(
        (delivery) => delivery.draftId === id && delivery.revision === revision,
      );
      if (prior) return copy(prior);
      if (transport !== undefined && transport !== 'channel' && transport !== 'peer') throw new Error('Invalid delivery transport');
      const draft = state.currentDraft?.id === id ? state.currentDraft : state.composerDraft;
      if (!draft || draft.id !== id) throw new Error('Draft not found');
      if (draft.revision !== revision) throw new Error('Stale draft revision');
      if (!state.target || !sameTarget(draft.target, state.target)) throw new Error('Target changed');
      if (!connection || state.codingState === 'disconnected') throw new Error('Agent is disconnected');
      if (draft.attachments?.length && !supportsReferences(draft.attachments)) throw new Error('This agent connection does not support image attachments or file references; instruction preserved');
      if (state.codingState === 'approval-required') throw new Error('Agent approval is required');
      if (state.codingState === 'working' && !canSendWhileWorking(connection.capabilities, draft.target.agent === 'claude' ? (transport ?? 'channel') : transport)) {
        throw new Error('Agent is busy');
      }
      const deliveryConnection = connection;
      const attachments = draft.attachments?.length ? await resolveReferences(draft.attachments) : [];
      requireOpen();
      if (connection !== deliveryConnection || !state.target || !sameTarget(draft.target,state.target)) throw new Error('Target changed');
      if (state.currentDraft?.id === id ? state.currentDraft.revision !== revision : state.composerDraft?.id !== id || state.composerDraft.revision !== revision) throw new Error('Draft changed');

      const delivery: Delivery = {
        id: createId('delivery'),
        draftId: draft.id,
        revision: draft.revision,
        target: copy(draft.target),
        englishText: draft.englishText,
        ...(attachments.length ? { attachments: copy(attachments), ...(attachments.every(isFileReference) ? {referenceFormat:'manifest-v1' as const} : {}) } : {}),
        state: 'sending',
        ...(draft.target.agent === 'claude' ? { transport: transport ?? 'channel' } : {}),
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

      try {
        const result = await deliveryConnection.send(delivery.id, delivery.englishText, delivery.attachments,
          delivery.transport ? { panelSessionId: state.id, transport: delivery.transport } : undefined);
        if (result.channelGeneration) delivery.channelGeneration = result.channelGeneration;
        if (result.nativeMessageId) delivery.nativeMessageId = result.nativeMessageId;
        if (result.nativeAfterRevision !== undefined) delivery.nativeAfterRevision = result.nativeAfterRevision;
        // Native acceptance can arrive before the transport finishes. Never downgrade it.
        if (delivery.state !== 'sent' && !(delivery.state === 'queued' && (result.state === 'sending' || result.state === 'unconfirmed'))) {
          delivery.state = result.state;
          if (result.reason !== undefined) delivery.reason = result.reason;
          if (delivery.state === 'sending' ||
              (delivery.state === 'sent' && deliveryConnection.capabilities.acknowledgement === 'none')) {
            delivery.state = 'unconfirmed';
            delivery.reason ??= 'The adapter cannot confirm delivery';
          }
        }
      } catch (error) {
        if (delivery.state !== 'sent' && delivery.state !== 'queued') {
          delivery.state = 'unconfirmed';
          delivery.reason = error instanceof Error ? error.message : 'Delivery outcome is unknown';
        }
      }
      if (delivery.state !== 'sent' && deliveryConnection.reconcileDelivery) {
        try { if (await deliveryConnection.reconcileDelivery(delivery)) { delivery.state = 'sent'; delete delivery.reason; } } catch { /* Preserve uncertainty. */ }
      }
      deps.store.updateDelivery(copy(delivery));
      clearSubmittedDraft(delivery);
      publish();
      return copy(delivery);
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
      languageTail = reset.then(() => undefined, () => undefined);
      await reset;
    },

    snapshot() { state.languageSettings = settings; return copy(state); },

    refreshLanguageSettings() {
      if (closed) return;
      const previous = settings; settings = readSettings();
      if (JSON.stringify(previous) === JSON.stringify(settings)) return;
      if (!needsReplyTranslation(settings)) dropPendingTranslations();
      if (needsReplyTranslation(settings) && (!needsReplyTranslation(previous) || previous.reply !== settings.reply)) {
        const recent = state.codingMessages.filter(m => m.role === 'assistant' && m.complete && m.translationStatus !== 'complete').slice(-20);
        for (const message of recent) translateIfNeeded(message);
      }
      publish();
    },

    async translateMessage(sourceId) {
      requireOpen();
      const message = state.codingMessages.find(m => m.sourceId === sourceId);
      if (!message || message.role !== 'assistant' || !message.complete) throw new Error('Message unavailable for translation');
      if (!needsReplyTranslation(settings)) throw new Error('Translation is off for this session');
      translateIfNeeded(message);
    },

    subscribe(listener) {
      requireOpen();
      listeners.add(listener);
      listener(copy(state));
      return () => { listeners.delete(listener); };
    },

    async close() {
      summaries.close();
      if (closed) return;
      closed = true;
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
