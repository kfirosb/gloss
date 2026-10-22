import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AgentAdapter,
  AgentKind,
  ConversationSnapshot,
  ConversationStore,
  SourceMessage,
  Target,
} from '../core/contracts.js';
import type { SessionRecord, SessionStore, SessionEnvelope } from '../core/session-contracts.js';
export type { SessionEnvelope } from '../core/session-contracts.js';
import { MAX_ATTACHMENTS, ATTACHMENT_LIMIT_MESSAGE } from '../core/content-policy.js';
import { INITIAL_LANGUAGE_DEFAULTS, type LanguageSettings } from '../core/language-settings.js';
import type { Workflow } from '../core/workflow.js';
import type { FileReviewMode } from '../core/file-review-contracts.js';
import type { Action } from './protocol.js';
import type { FileRegistry } from '../core/file-references.js';
import { readProjectMetadata } from './project-metadata.js';
import { validateSummarySource } from '../core/response-summaries.js';
import type { ActivityEvent } from '../core/activity-contracts.js';
import type { SummarySource, ResponseSummary } from '../core/summary-contracts.js';
import { isSecretFileName } from '../core/file-edits.js';

export interface SessionManager {
  reviewFile(
    sessionId: string,
    path: string,
    mode: 'summary' | 'translation',
    version: string | undefined,
    signal: AbortSignal,
  ): Promise<{ path: string; mode: 'summary' | 'translation'; text: string }>;
  /** Reports which review modes already have a saved result for this exact file version. */
  fileReviewStatus(
    sessionId: string,
    path: string,
    version: string,
  ): Promise<Record<FileReviewMode, boolean>>;
  summarizeResponse(sessionId: string, source: SummarySource): Promise<ResponseSummary>;
  subagentActivity(
    sessionId: string,
    taskId: string,
    signal: AbortSignal,
  ): Promise<AsyncIterable<ActivityEvent>>;
  backgroundOutput(sessionId: string, taskId: string): Promise<string>;
  updateSessionTitle(id: string, title: string): void;
  list(): SessionRecord[];
  /** Deletes a closed session's saved history. Throws code 'session-open' while a workflow is connected or opening; a cached workflow that is disconnected, or whose session the catalog reports closed (catalogClosed), is closed and dropped. */
  remove(sessionId: string, options?: { catalogClosed?: boolean }): Promise<void>;
  refreshLanguageSettings(sessionId?: string): void;
  register(target: Target, conversationId?: string, signal?: AbortSignal): Promise<SessionRecord>;
  ensure(sessionId: string): Promise<Workflow>;
  snapshot(sessionId: string): SessionEnvelope;
  /** Whether a workflow is loaded for the session (connected or cached disconnected); without one its state is the saved copy. */
  hasWorkflow(sessionId: string): boolean;
  action(sessionId: string, action: Action): Promise<SessionEnvelope>;
  ingest(agent: AgentKind, message: SourceMessage): Promise<SessionEnvelope>;
  subscribe(sessionId: string, listener: (event: SessionEnvelope) => void): () => void;
  subscribeRegistrations(listener: (record: SessionRecord) => void): () => void;
  restore(preferredId?: string): Promise<void>;
  close(): Promise<void>;
}
export function createSessionManager(options: {
  store: ConversationStore & SessionStore;
  agents: AgentAdapter[];
  files?: FileRegistry;
  languageSettings?(sessionId: string): LanguageSettings;
  createWorkflowForSession(record: SessionRecord): Promise<Workflow>;
}): SessionManager {
  const { store } = options;
  // Recover before any workflow can load deliveries: the server may serve an action before restore runs, and a
  // workflow opened then would keep an interrupted send as still in progress. Restore repeats it harmlessly.
  store.recoverInFlightDeliveries();
  const epoch = randomUUID();
  const workflows = new Map<string, Workflow>();
  const opening = new Map<string, Promise<Workflow>>();
  const reconnecting = new Map<string, Promise<void>>();
  const sequences = new Map<string, number>();
  const listeners = new Map<string, Set<(event: SessionEnvelope) => void>>();
  const registrations = new Set<(record: SessionRecord) => void>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const requireOpen = () => {
    if (closed) throw Object.assign(new Error('Application is closed'), { code: 'closed' });
  };
  const recordFor = (id: string) => {
    const record = store.readSession(id);
    if (!record) throw Object.assign(new Error('Unknown session'), { code: 'unknown-session' });
    return record;
  };
  const publish = (id: string) => {
    sequences.set(id, (sequences.get(id) ?? 0) + 1);
    const event = manager.snapshot(id);
    for (const listener of listeners.get(id) ?? []) listener(event);
    return event;
  };
  const manager: SessionManager = {
    async reviewFile(id, path, mode, version, signal) {
      requireOpen();
      const record = recordFor(id);
      if (
        typeof path !== 'string' ||
        !path ||
        path.length > 4096 ||
        (mode !== 'summary' && mode !== 'translation') ||
        (version !== undefined && typeof version !== 'string')
      )
        throw new Error('Invalid file review request');
      if (isSecretFileName(path))
        throw new Error('Environment and key files are not sent for TL;DR or translation');
      if (!options.files) throw new Error('Files unavailable');
      const source = await options.files.reviewText(id, path, signal);
      if (version !== undefined && source.version !== version)
        throw new Error('File changed; reopen the preview');
      const text = await (
        await manager.ensure(id)
      ).reviewFileText(source.text, mode, signal, {
        scope: record.canonicalRoot,
        path,
        version: source.version,
      });
      const current = await options.files.reviewText(id, path, signal);
      if (current.version !== source.version || current.text !== source.text)
        throw new Error('File changed; reopen the preview');
      return { path, mode, text };
    },
    async subagentActivity(id, taskId, signal) {
      return (await manager.ensure(id)).subagentActivity(taskId, signal);
    },
    async backgroundOutput(id, taskId) {
      return (await manager.ensure(id)).backgroundOutput(taskId);
    },
    async fileReviewStatus(id, path, version) {
      requireOpen();
      const record = recordFor(id);
      if (
        typeof path !== 'string' ||
        !path ||
        path.length > 4096 ||
        typeof version !== 'string' ||
        !version
      )
        throw new Error('Invalid file review request');
      // Marks are a hint for a live workflow; previewing must not start one for a saved session.
      const workflow = workflows.get(id);
      if (!workflow) return { summary: false, translation: false };
      return workflow.fileReviewStatus({
        scope: record.canonicalRoot,
        path,
        version,
      });
    },
    async summarizeResponse(id, source) {
      validateSummarySource(source);
      return (await manager.ensure(id)).summarizeResponse(source);
    },
    refreshLanguageSettings(id) {
      requireOpen();
      for (const [key, workflow] of workflows)
        if (id === undefined || key === id) {
          try {
            workflow.refreshLanguageSettings();
          } catch (error) {
            console.warn('Language settings refresh failed', error);
          }
        }
      // Sessions without a live workflow still show saved state; tell their listeners the settings moved.
      for (const [key, group] of listeners)
        if (group.size && !workflows.has(key) && (id === undefined || key === id)) {
          try {
            publish(key);
          } catch {
            /* unknown session */
          }
        }
    },
    updateSessionTitle(id, title) {
      requireOpen();
      recordFor(id);
      store.updateSessionTitle(id, title);
    },
    list: () => store.listSessions(),
    async remove(id, removal) {
      requireOpen();
      recordFor(id);
      const cached = workflows.get(id);
      if (
        opening.has(id) ||
        reconnecting.has(id) ||
        (cached && !removal?.catalogClosed && cached.snapshot().codingState !== 'disconnected')
      )
        throw Object.assign(
          new Error('Session is open; close it before removing it from history'),
          { code: 'session-open' },
        );
      if (!store.deleteSession) throw new Error('Removing sessions is unavailable');
      if (cached) {
        workflows.delete(id);
        await cached.close().catch(() => {});
      }
      store.deleteSession(id);
      sequences.delete(id);
      // Drop stale listeners so nothing re-reads the deleted record.
      listeners.delete(id);
    },
    async register(target, conversationId, signal) {
      signal?.throwIfAborted();
      requireOpen();
      const existing = store
        .listSessions()
        .find((r) => r.target.agent === target.agent && r.target.sessionRef === target.sessionRef);
      const canonicalProject = (path: string) => realpath(path).catch(() => resolve(path));
      const requestedProject = await canonicalProject(target.projectId);
      const checkProject = async (registeredTarget: Target) => {
        if ((await canonicalProject(registeredTarget.projectId)) !== requestedProject)
          throw new Error('Session is already registered to a different project');
      };
      if (existing) {
        await checkProject(existing.target);
        if (existing.canonicalRoot) return existing;
        const {
          available,
          projectKey: _projectKey,
          ...metadata
        } = await readProjectMetadata(existing.target.projectId);
        requireOpen();
        signal?.throwIfAborted();
        if (!available) return existing;
        const recovered = store.registerSession({ ...existing, ...metadata });
        for (const listener of registrations) listener(recovered);
        return recovered;
      }
      const saved = store
        .list()
        .find((r) => r.target?.agent === target.agent && r.target.sessionRef === target.sessionRef);
      if (saved?.target) await checkProject(saved.target);
      // Availability and grouping are derived by the catalog, not persisted session fields.
      const {
        available: _available,
        projectKey: _projectKey,
        ...metadata
      } = await readProjectMetadata(target.projectId);
      requireOpen();
      signal?.throwIfAborted();
      const registered = store.registerSession({
        id: saved?.id ?? conversationId ?? randomUUID(),
        target,
        ...metadata,
        enabled: true,
      });
      // A concurrent registration may have won while project metadata was loading.
      await checkProject(registered.target);
      for (const listener of registrations) listener(registered);
      return registered;
    },
    async ensure(id) {
      requireOpen();
      const present = workflows.get(id);
      if (present) return present;
      const pending = opening.get(id);
      if (pending) return pending;
      const record = recordFor(id);
      const job = Promise.resolve()
        .then(() => options.createWorkflowForSession(record))
        .then(async (workflow) => {
          if (closed) {
            await workflow.close();
            throw Object.assign(new Error('Application is closed'), { code: 'closed' });
          }
          workflows.set(id, workflow);
          workflow.refreshLanguageSettings(); // pick up a change made while this workflow was connecting
          workflow.subscribe(() => publish(id));
          publish(id);
          return workflow;
        })
        .finally(() => opening.delete(id));
      opening.set(id, job);
      return job;
    },
    hasWorkflow(id) {
      return workflows.has(id);
    },
    snapshot(id) {
      const record = recordFor(id);
      const live = workflows.get(id)?.snapshot();
      // A live workflow holds the whole conversation; reading the saved copy is needed only without one.
      const saved = live ? undefined : store.load(id);
      const base: ConversationSnapshot =
        live ??
        (saved
          ? { ...saved, codingState: 'disconnected' }
          : {
              id,
              target: record.target,
              codingState: 'disconnected',
              codingMessages: [],
              discussion: [],
              deliveries: [],
              language: INITIAL_LANGUAGE_DEFAULTS.write,
              languageSessionId: '',
              languageModel: 'default',
              sourceRevision: 0,
            });
      let languageSettings: LanguageSettings | undefined;
      if (!live && options.languageSettings) {
        try {
          languageSettings = options.languageSettings(id);
        } catch {
          /* keep saved state */
        }
      }
      return {
        epoch,
        sessionId: id,
        sequence: sequences.get(id) ?? 0,
        snapshot: languageSettings
          ? { ...base, languageSettings, language: languageSettings.assist }
          : base,
      };
    },
    async action(id, action) {
      requireOpen();
      const record = recordFor(id);
      if (
        action.type === 'connect' &&
        (action.target.agent !== record.target.agent ||
          action.target.sessionRef !== record.target.sessionRef ||
          action.target.projectId !== record.target.projectId)
      )
        throw new Error('Cannot retarget a registered session');
      const wasOpen = workflows.has(id);
      const w = await manager.ensure(id);
      const attachments = async (ids: string[] = []) => {
        if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS)
          throw new Error(ATTACHMENT_LIMIT_MESSAGE);
        if (!ids.length) return [];
        if (!options.files) throw new Error('Session file registry unavailable');
        const files = await options.files.resolve(id, ids);
        return files;
      };
      switch (action.type) {
        case 'connect': {
          // New workflows already connect in the factory; explicit retries reconnect cached ones.
          if (wasOpen) {
            let pending = reconnecting.get(id);
            if (!pending && w.snapshot().codingState === 'disconnected') {
              pending = w.connect(record.target).finally(() => reconnecting.delete(id));
              reconnecting.set(id, pending);
            }
            await pending;
          }
          break;
        }
        case 'check-composer':
          await w.checkComposer(action.requestId);
          break;
        case 'release-composer':
          w.releaseComposer(action.requestId);
          break;
        case 'send-composer':
          await w.sendComposer(
            action.requestId,
            action.text,
            await attachments(action.attachmentIds),
            action.transport,
          );
          break;
        case 'translate-composer': {
          const translation = await w.translateComposer(action.text);
          return { ...publish(id), translation };
        }
        case 'discuss':
          await w.discuss(action.text, await attachments(action.attachmentIds));
          break;
        case 'prepare': {
          const review = await w.prepareDirect(action.indices, action.expected);
          return { ...publish(id), review };
        }
        case 'send-review':
          await w.sendReview(
            action.draftId,
            action.revision,
            action.localizedText,
            action.transport,
          );
          break;
        case 'approve':
          await w.approveReview(action.reviewId, action.localizedText, action.expected);
          break;
        case 'edit-approved':
          w.editApproved(action.draftId, action.revision, action.englishText);
          break;
        case 'revise':
          await w.reviseDraft(action.draftId, action.text);
          break;
        case 'reset-instruction':
          w.resetInstruction(action.draftId, action.revision);
          break;
        case 'discard':
          w.discardDraft(action.draftId);
          break;
        case 'send':
          await w.send(action.draftId, action.revision, action.transport);
          break;
        case 'translate-message':
          await w.translateMessage(action.sourceId);
          break;
        case 'conversation-view':
          w.setConversationView(action.view);
          break;
        case 'older-history':
          await w.loadOlderHistory();
          break;
      }
      return publish(id);
    },
    async ingest(agent, message) {
      requireOpen();
      const matching = store
        .listSessions()
        .filter((r) => r.target.agent === agent && r.target.sessionRef === message.sourceSessionId);
      if (matching.length !== 1) throw new Error('Unknown or ambiguous source session');
      const id = matching[0]!.id;
      (await manager.ensure(id)).ingestSourceMessage(message);
      return publish(id);
    },
    subscribe(id, listener) {
      requireOpen();
      const group = listeners.get(id) ?? new Set();
      listeners.set(id, group);
      group.add(listener);
      return () => {
        group.delete(listener);
      };
    },
    subscribeRegistrations(listener) {
      requireOpen();
      registrations.add(listener);
      return () => {
        registrations.delete(listener);
      };
    },
    async restore(preferredId) {
      requireOpen();
      store.recoverInFlightDeliveries();
      await Promise.allSettled(
        store
          .list()
          .filter((r) => r.target)
          .map((r) => manager.register(r.target!, r.id)),
      );
      const records = preferredId
        ? store.listSessions().filter((r) => r.enabled && r.id === preferredId)
        : store.listSessions().filter((r) => r.enabled);
      await Promise.allSettled(records.map((r) => manager.ensure(r.id)));
    },
    close() {
      closing ??= (async () => {
        closed = true;
        await Promise.allSettled(opening.values());
        await Promise.allSettled([...workflows.values()].map((w) => w.close()));
        workflows.clear();
        listeners.clear();
        registrations.clear();
      })();
      return closing;
    },
  };
  return manager;
}
