import {
  CHECKING_TERMINAL_REASON,
  NOT_TYPED_AT_RESTART_REASON,
  type ConversationSnapshot,
  type ConversationStore,
  type Delivery,
  type TranslationKey,
} from '../../src/core/contracts.js';

const copy = <T>(value: T): T => structuredClone(value);
const translationKey = (key: TranslationKey) => JSON.stringify(key);

import { summaryCacheKey, type SummaryKey } from '../../src/core/summary-contracts.js';
export class MemoryConversationStore implements ConversationStore {
  private readonly summaries = new Map<string, string>();
  getSummary(key: SummaryKey) {
    return this.summaries.get(summaryCacheKey(key));
  }
  putSummary(key: SummaryKey, text: string) {
    this.summaries.set(summaryCacheKey(key), text);
  }
  readonly operationLog: string[] = [];
  private readonly snapshots = new Map<string, ConversationSnapshot>();
  private readonly deliveries = new Map<string, Delivery>();
  private readonly translations = new Map<string, string>();
  private readonly contexts = new Map<string, string>();

  load(id: string) {
    const value = this.snapshots.get(id);
    return value && copy(value);
  }
  save(snapshot: ConversationSnapshot) {
    this.operationLog.push('save');
    this.snapshots.set(snapshot.id, copy(snapshot));
  }
  releaseComposerAttempt(conversationId: string, requestId: string) {
    const snapshot = this.snapshots.get(conversationId);
    if (snapshot?.composerDraft?.id === `composer-${requestId}`) delete snapshot.composerDraft;
  }
  claimDelivery(delivery: Delivery) {
    this.operationLog.push(`claim:${delivery.draftId}:${delivery.revision}`);
    const key = `${delivery.draftId}:${delivery.revision}`;
    if (this.deliveries.has(key)) return false;
    this.deliveries.set(key, copy(delivery));
    return true;
  }
  updateDelivery(delivery: Delivery) {
    this.operationLog.push(`update:${delivery.state}`);
    this.deliveries.set(`${delivery.draftId}:${delivery.revision}`, copy(delivery));
  }
  getTranslation(key: TranslationKey) {
    return this.translations.get(translationKey(key));
  }
  putTranslation(key: TranslationKey, text: string) {
    this.translations.set(translationKey(key), text);
  }
  readContext(projectId: string) {
    return this.contexts.get(projectId);
  }
  writeContext(projectId: string, text: string) {
    this.contexts.set(projectId, text);
  }
  deleteContext(projectId: string) {
    this.contexts.delete(projectId);
  }
  deleteConversation(id: string) {
    this.snapshots.delete(id);
  }
  list(projectId?: string) {
    return [...this.snapshots.values()]
      .filter((snapshot) => projectId === undefined || snapshot.target?.projectId === projectId)
      .map(({ id, target, language, languageModel, sourceRevision }) => ({
        id,
        ...(target && { target: copy(target), projectId: target.projectId }),
        language,
        languageModel,
        sourceRevision,
      }));
  }
  recoverInFlightDeliveries() {
    let recovered = 0;
    for (const delivery of this.deliveries.values()) {
      if (
        delivery.state === 'sending' &&
        delivery.transport === 'tmux' &&
        delivery.reason === CHECKING_TERMINAL_REASON
      ) {
        delivery.state = 'failed';
        delivery.reason = NOT_TYPED_AT_RESTART_REASON;
        recovered += 1;
        continue;
      }
      if (delivery.state === 'sending') {
        delivery.state = 'unconfirmed';
        delivery.reason = 'Delivery was interrupted before confirmation';
        recovered += 1;
      }
    }
    return recovered;
  }
}
