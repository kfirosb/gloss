import { useEffect, useSyncExternalStore } from 'react';
import type { ConversationSnapshot } from '../core/contracts.js';
import { defaultWorkspace, WorkspaceConflict, type WorkspaceData, type WorkspaceRecord } from '../core/session-contracts.js';
import { SessionClient, type SessionEnvelope } from './session-client.js';
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
// Resolve browser storage inside the existing guarded reads/writes, not during construction.
const browserStorage: Storage = {
 getItem: key => globalThis.localStorage.getItem(key),
 setItem: (key,value) => globalThis.localStorage.setItem(key,value),
};
export interface WorkspaceTransport {
 loadWorkspace(): Promise<WorkspaceRecord>;
 saveWorkspace(expectedRevision: number, data: WorkspaceData): Promise<WorkspaceRecord>;
 /** Required to verify a displaced composer attempt before keeping local changes. */
 snapshot?(): Promise<SessionEnvelope>;
}
let recoveryOwner: Promise<string> | undefined;
function browserRecoveryOwner(): Promise<string> {
 if (recoveryOwner) return recoveryOwner;
 recoveryOwner = (async () => {
  let candidate: string;
  try { candidate = sessionStorage.getItem('workspace-owner') ?? crypto.randomUUID(); }
  catch { candidate = crypto.randomUUID(); }
  const remember = (owner: string) => {
   try { sessionStorage.setItem('workspace-owner', owner); } catch { /* Server persistence remains available. */ }
   return owner;
  };
  if (typeof navigator === 'undefined' || !navigator.locks) return remember(candidate);
  // sessionStorage can be cloned into an opener tab. Only the live lock holder
  // may restore that owner's recovery records. A refresh releases and reacquires it.
  const claim = (owner: string): Promise<string> => new Promise((resolve, reject) => {
   void navigator.locks.request(`workspace-owner:${owner}`, { ifAvailable: true }, async lock => {
    if (!lock) { resolve(await claim(crypto.randomUUID())); return; }
    const released = new Promise<void>(release => {
     window.addEventListener('pagehide', () => release(), { once: true });
    });
    resolve(remember(owner));
    await released;
   }).catch(reject);
  });
  return claim(candidate);
 })();
 return recoveryOwner;
}
interface LocalWorkspace { record: WorkspaceRecord; unsaved: boolean; recoveredReview: string | null; migrated: boolean }
/** Lives outside React: completion callbacks keep writing their originating session after unmount. */
export class WorkspaceController {
 record: WorkspaceRecord;
 /** Authoritative source ordering outlives every keyed React mount. */
 envelope: SessionEnvelope | null = null;
 private retiredEpochs = new Set<string | undefined>();
 acceptEnvelope(value: SessionEnvelope, authoritativeConnection = false): boolean {
  if (value.sessionId !== this.sessionId || value.snapshot.id !== this.sessionId) return false;
  const previous = this.envelope;
  if (previous && value.epoch !== previous.epoch) {
   // Only a fresh snapshot/SSE connection can establish a runtime restart.
   // A delayed action must never switch the cache back to an older process.
   if (!authoritativeConnection || this.retiredEpochs.has(value.epoch)) return false;
   this.retiredEpochs.add(previous.epoch);
  } else if (previous && value.sequence < previous.sequence) return false;
  this.envelope = value;
  this.version++; for (const listener of this.listeners) listener();
  return true;
 }
 conflict: WorkspaceRecord | null = null;
 unsaved = false;
 error: string | null = null;
 recoveredReview: string | null = null;
 ready = false;
 private migrated = false;
 private version = 0;
 private listeners = new Set<() => void>();
 private timer: ReturnType<typeof setTimeout> | undefined;
 private writing: Promise<void> | undefined;
 private releasing = false;
 private hydration: Promise<void> | undefined;
 private edit = 0;
 private key = '';
 private ownerReady: Promise<void>;
 private storageWarning: string | null = null;
 constructor(readonly sessionId: string, private client: WorkspaceTransport = new SessionClient(sessionId), private storage: Storage = browserStorage, recoveryOwner?: string) {
  this.record = { sessionId, revision: 0, data: defaultWorkspace() };
  const restore = (owner: string) => {
   this.key = `workspace:${owner}:${sessionId}`;
   const saved = this.read<LocalWorkspace>(this.key);
   if (saved?.record?.sessionId === sessionId && this.edit === 0) {
    this.record = saved.record;
    this.unsaved = saved.unsaved;
    this.recoveredReview = saved.recoveredReview;
   }
   this.migrated = saved?.migrated ?? this.read<boolean>(`workspace-migrated:${sessionId}`) ?? false;
  };
  if (recoveryOwner) {
   restore(recoveryOwner);
   this.ownerReady = Promise.resolve();
  } else {
   this.ownerReady = browserRecoveryOwner().then(restore);
  }
 }
 subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
 getVersion = () => this.version;
 private read<T>(key: string): T | null { try { return JSON.parse(this.storage.getItem(key) ?? 'null') as T | null; } catch { return null; } }
 private publish() {
  try { if (this.key) this.storage.setItem(this.key, JSON.stringify({ record: this.record, unsaved: this.unsaved, recoveredReview: this.recoveredReview, migrated: this.migrated } satisfies LocalWorkspace)); }
  catch { this.storageWarning = 'Browser storage unavailable; keep this tab open until saved.'; }
  if (this.storageWarning) this.error = this.storageWarning;
  this.version++; for (const listener of this.listeners) listener();
 }
 private schedule() { clearTimeout(this.timer); if (this.ready && !this.conflict) this.timer = setTimeout(() => { void this.flush(); }, 300); }
 update = (mutator: (data: WorkspaceData) => void) => {
  const data = structuredClone(this.record.data); mutator(data);
  if (JSON.stringify(data) === JSON.stringify(this.record.data)) return;
  this.record = { ...this.record, data }; this.unsaved = true; this.edit++; this.publish(); this.schedule();
 };
 hydrate(snapshot: ConversationSnapshot, launchSessionId: string): Promise<void> {
  if (snapshot.id !== this.sessionId) return Promise.reject(new Error('Workspace snapshot belongs to another session'));
  if (this.ready) return Promise.resolve();
  if (this.hydration) return this.hydration;
  this.hydration = this.load(snapshot, launchSessionId).finally(() => { this.hydration = undefined; });
  return this.hydration;
 }
 private async load(snapshot: ConversationSnapshot, launchSessionId: string) {
  try {
   await this.ownerReady;
   const remote = await this.client.loadWorkspace();
   if (remote.sessionId !== this.sessionId) throw new Error('Workspace response belongs to another session');
   const attempt = this.record.data.composerAttempt;
   if (this.unsaved && attempt && remote.revision > this.record.revision && remote.data.composerAttempt?.requestId !== attempt.requestId && snapshot.composerDraft?.id !== `composer-${attempt.requestId}` && snapshot.deliveries.some(delivery => delivery.draftId === `composer-${attempt.requestId}`)) {
    // The server released/completed this attempt while this tab had unsaved edits.
    // Preserve those edits and any real conflict, but never recover its old lock.
    this.update(data => { data.composerAttempt = null; });
   }
   if (this.unsaved) { if (remote.revision !== this.record.revision) this.conflict = remote; }
   else this.record = remote;
   // Only an untouched server workspace can import legacy browser data.
   if (!this.migrated && remote.revision === 0 && !this.unsaved) this.migrate(snapshot, launchSessionId);
   this.migrated = true;
   try { this.storage.setItem(`workspace-migrated:${this.sessionId}`, 'true'); }
   catch { this.storageWarning = 'Browser storage unavailable; keep this tab open until saved.'; }
   this.reconcileReview(snapshot);
   this.ready = true; this.error = null; this.publish(); if (this.unsaved) this.schedule();
  } catch (error) { this.error = error instanceof Error ? error.message : 'Workspace unavailable'; this.publish(); throw error; }
 }
 private migrate(snapshot: ConversationSnapshot, launchSessionId: string) {
  const id = this.sessionId;
  const legacyValue = (key:string) => { try { return this.storage.getItem(key); } catch { return null; } };
  this.update(data => {
   const text = this.read<unknown>(`composer:${id}`); if (typeof text === 'string') data.composer = text;
   const images = this.read<{ id: string }[]>(`composer-images:${id}`); if (Array.isArray(images)) data.attachmentIds = images.filter(i => typeof i.id === 'string').map(i => i.id);
   const selection = this.read<number[]>(`answer-selection:${id}`); if (Array.isArray(selection)) data.selectedDiscussion = [...new Set(selection.filter(i => Number.isSafeInteger(i) && i >= 0))];
   const attempt = this.read<WorkspaceData['composerAttempt']>(`composer-attempt:${id}`); if (attempt?.requestId && typeof attempt.text === 'string') data.composerAttempt = { ...attempt, attachmentIds: attempt.attachmentIds ?? [] };
   const review = this.read<{ draft: { id: string; revision: number; localizedText: string }; localizedText: string }>(`answer-review:${id}`);
   if (review?.draft) {
    if (snapshot.currentDraft?.id === review.draft.id && snapshot.currentDraft.revision === review.draft.revision) data.review = { draftId: review.draft.id, revision: review.draft.revision, localizedText: review.localizedText ?? review.draft.localizedText };
    else if (review.localizedText && review.localizedText !== review.draft.localizedText) this.recoveredReview = review.localizedText;
   }
   if (id === launchSessionId) {
    const mode = legacyValue('panel-layout'); if (mode && ['split','columns','rows','bottom'].includes(mode)) data.layout.mode = mode as WorkspaceData['layout']['mode'];
    const order = this.read<WorkspaceData['layout']['order']>('panel-order'); if (Array.isArray(order) && order.length === 3 && new Set(order).size === 3 && order.every(p => ['live','assistant','composer'].includes(p))) data.layout.order = order;
    for (const [key, field] of [['panel-live-size','liveSize'],['panel-discussion-size','discussionSize']] as const) { const raw = legacyValue(key); const value = Number(raw); if (raw !== null && Number.isFinite(value)) data.layout[field] = Math.min(90, Math.max(10, value)); }
   }
  });
 }
 /** Never resurrect a review absent from the authoritative snapshot; retain text separately. */
 reconcileReview(snapshot: ConversationSnapshot) {
  if (snapshot.id !== this.sessionId) throw new Error('Workspace snapshot belongs to another session');
  const review = this.record.data.review; const current = snapshot.currentDraft;
  if (review && (!current || current.id !== review.draftId || current.revision !== review.revision)) {
   this.recoveredReview = review.localizedText;
   this.update(data => { data.review = null; });
  }
 }
 flush = (): Promise<void> => {
  clearTimeout(this.timer);
  if (this.writing) return this.writing;
  if (!this.ready || !this.unsaved || this.conflict || this.releasing) return Promise.resolve();
  this.writing = this.write().finally(() => { this.writing = undefined; }); return this.writing;
 };
 /** Serialize the server's atomic release with workspace writes, preserving edits in flight. */
 async releaseComposer(requestId: string, release: () => Promise<void>) {
  if (this.releasing) return;
  await this.flush();
  if (this.releasing) return;
  if (this.unsaved || this.conflict) throw new Error('Save or resolve workspace changes before releasing the composer.');
  this.releasing = true;
  const before = structuredClone(this.record);
  try {
   await release();
   this.update(data => { if (data.composerAttempt?.requestId === requestId) data.composerAttempt = null; });
   const remote = await this.client.loadWorkspace();
   if (remote.sessionId !== this.sessionId) throw new Error('Workspace response belongs to another session');
   const released = structuredClone(before.data);
   if (released.composerAttempt?.requestId === requestId) released.composerAttempt = null;
   if (remote.revision < before.revision || remote.revision > before.revision + 1 || JSON.stringify(remote.data) !== JSON.stringify(released)) {
    // Legacy hosts may not update workspaces; do not falsely report a conflict then.
    if (remote.revision !== before.revision || JSON.stringify(remote.data) !== JSON.stringify(before.data)) {
     this.conflict = remote; this.publish(); return;
    }
   }
   this.record = { ...this.record, revision: remote.revision };
   this.conflict = null; this.error = null; this.publish();
  } finally { this.releasing = false; this.schedule(); }
 }
 private async write() {
  while (this.unsaved && !this.conflict) {
   const submitted = structuredClone(this.record); const edit = this.edit;
   try {
    const saved = await this.client.saveWorkspace(submitted.revision, submitted.data);
    if (saved.sessionId !== this.sessionId) throw new Error('Workspace response belongs to another session');
    this.record = { ...saved, data: edit === this.edit ? saved.data : this.record.data };
    this.unsaved = edit !== this.edit; this.error = null; this.publish();
   } catch (error) {
    if (error instanceof WorkspaceConflict && error.current.sessionId === this.sessionId) this.conflict = error.current;
    this.error = error instanceof Error ? error.message : 'Workspace save failed'; this.publish(); return;
   }
  }
 }
 resolveKeepLocal = async () => {
  const conflict = this.conflict;
  if (!conflict) return;
  const attempt = this.record.data.composerAttempt;
  if (attempt && conflict.revision > this.record.revision && conflict.data.composerAttempt?.requestId !== attempt.requestId) {
   try {
    if (!this.client.snapshot) throw new Error('Cannot verify composer attempt; keep the conflict until session status is available.');
    const value = await this.client.snapshot();
    // Another resolution or a newer conflict supersedes this user's choice.
    if (this.conflict !== conflict) return;
    if (!this.acceptEnvelope(value, true)) throw new Error('Session status is stale or belongs to another session; retry Keep local.');
    if (this.conflict !== conflict) return;
    // An attempt created while the snapshot was loading is not the historical one.
    if (this.record.data.composerAttempt?.requestId === attempt.requestId) {
     const remoteAttempt = conflict.data.composerAttempt;
     if (remoteAttempt && value.snapshot.composerDraft?.id === `composer-${remoteAttempt.requestId}`) throw new Error('Another tab has a new active composer attempt. Resolve that attempt before keeping local changes.');
     if (value.snapshot.composerDraft?.id !== `composer-${attempt.requestId}` && value.snapshot.deliveries.some(delivery => delivery.draftId === `composer-${attempt.requestId}`)) {
      this.update(data => { data.composerAttempt = null; });
     }
    }
   } catch (error) {
    if (this.conflict === conflict) { this.error = error instanceof Error ? error.message : 'Could not verify composer attempt'; this.publish(); }
    return;
   }
  }
  // Use only the reviewed conflict revision; intervening remote edits must conflict again.
  this.record = { ...this.record, revision: conflict.revision }; this.conflict = null; this.error = null; this.unsaved = true; this.publish(); await this.flush();
 };
 resolveUseSaved = () => {
  if (!this.conflict) return;
  this.record = this.conflict; this.conflict = null; this.unsaved = false; this.error = null; this.edit++; this.publish();
 };
}
const controllers = new Map<string, WorkspaceController>();
export function workspaceFor(sessionId: string) {
 let controller = controllers.get(sessionId); if (!controller) { controller = new WorkspaceController(sessionId); controllers.set(sessionId, controller); } return controller;
}
export function useWorkspace(sessionId: string) {
 const controller = workspaceFor(sessionId);
 useSyncExternalStore(controller.subscribe, controller.getVersion);
 useEffect(() => () => { void controller.flush(); }, [controller]);
 return controller;
}
