import { afterEach, describe, it, expect, vi } from 'vitest';
import { WorkspaceController } from '../../src/ui/use-workspace.js';
import { defaultWorkspace, WorkspaceConflict, type WorkspaceRecord } from '../../src/core/session-contracts.js';
import type { ConversationSnapshot } from '../../src/core/contracts.js';
import type { SessionEnvelope } from '../../src/ui/session-client.js';
const memory=()=>{const values=new Map<string,string>();return {getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);}};};
const record=(sessionId='A'):WorkspaceRecord=>({sessionId,revision:0,data:defaultWorkspace()});
const snapshot=(id='A')=>({id,codingState:'idle' as const,codingMessages:[],discussion:[],deliveries:[],language:'he',languageSessionId:'',languageModel:'default',sourceRevision:0});
function setup(storage=memory()) { let saved=record();const client={loadWorkspace:async()=>structuredClone(saved),saveWorkspace:vi.fn(async(expected:number,data:any)=>{if(expected!==saved.revision)throw new WorkspaceConflict(structuredClone(saved));saved={sessionId:'A',revision:expected+1,data:structuredClone(data)};return structuredClone(saved);})};return {storage,client,get saved(){return saved;}};}
afterEach(() => vi.useRealTimers());
describe('workspace persistence',()=>{
 it.each([false, true])('hydrates a released cached attempt while preserving actual unsaved=%s', async unsaved => {
  const f = setup();
  const target = { agent: 'claude' as const, sessionRef: 'native', projectId: '/project' };
  const old = { requestId: 'old', text: 'old text', attachmentIds: ['old-ref'] };
  await f.client.saveWorkspace(0, { ...defaultWorkspace(), composer: 'cached text', attachmentIds: ['local-ref'], composerAttempt: old });
  const cached = structuredClone(f.saved);
  f.storage.setItem('workspace:hydration:A', JSON.stringify({ record: cached, unsaved, migrated: true }));
  await f.client.saveWorkspace(1, { ...defaultWorkspace(), composer: 'new saved text', attachmentIds: ['remote-ref'] });
  f.client.saveWorkspace.mockClear();
  const a = new WorkspaceController('A', f.client, f.storage, 'hydration');
  await a.hydrate({ ...snapshot(), deliveries: [{ id: 'receipt', draftId: 'composer-old', revision: 1, target, state: 'unconfirmed', englishText: 'old text' }] }, 'A');
  expect(a.record.data.composerAttempt).toBeNull();
  expect(a.unsaved).toBe(unsaved);
  if (unsaved) {
   expect(a.record.data).toMatchObject({ composer: 'cached text', attachmentIds: ['local-ref'] });
   expect(a.conflict).toEqual(f.saved);
  } else {
   expect(a.record).toEqual(f.saved);
   expect(a.conflict).toBeNull();
  }
  await a.flush();
  expect(f.client.saveWorkspace).not.toHaveBeenCalled();
 });
 it('hydrates and saves to the server when browser storage writes fail', async () => {
  const f = setup();
  const storage = { getItem: f.storage.getItem, setItem: () => { throw new Error('Quota exceeded'); } };
  const a = new WorkspaceController('A', f.client, storage, 'full-storage');
  await a.hydrate(snapshot(), 'A');
  expect(a.ready).toBe(true);
  expect(a.error).toContain('Browser storage unavailable');
  a.update(data => { data.composer = 'save through server'; });
  await a.flush();
  expect(f.saved.data.composer).toBe('save through server');
  expect(a.unsaved).toBe(false);
  expect(a.error).toContain('Browser storage unavailable');
 });

 it('keeps unsaved recovery separate for two tabs sharing local storage',async()=>{const f=setup();const a=new WorkspaceController('A',f.client,f.storage,'first');const b=new WorkspaceController('A',f.client,f.storage,'second');await a.hydrate(snapshot(),'A');await b.hydrate(snapshot(),'A');a.update(d=>{d.composer='first unsaved';});b.update(d=>{d.composer='second unsaved';});const reloadedA=new WorkspaceController('A',f.client,f.storage,'first');const reloadedB=new WorkspaceController('A',f.client,f.storage,'second');await reloadedA.hydrate(snapshot(),'A');await reloadedB.hydrate(snapshot(),'A');expect(reloadedA.record.data.composer).toBe('first unsaved');expect(reloadedB.record.data.composer).toBe('second unsaved');await a.flush();await b.flush();expect(b.conflict?.data.composer).toBe('first unsaved');expect(b.record.data.composer).toBe('second unsaved');await reloadedA.flush();await reloadedB.flush();});

 it('debounces server saves for 300ms while local storage updates immediately',async()=>{vi.useFakeTimers();const f=setup();const a=new WorkspaceController('A',f.client,f.storage,'debounce');await a.hydrate(snapshot(),'A');a.update(d=>{d.composer='one';});await vi.advanceTimersByTimeAsync(200);a.update(d=>{d.composer='two';});expect(JSON.parse(f.storage.getItem('workspace:debounce:A')!).record.data.composer).toBe('two');await vi.advanceTimersByTimeAsync(299);expect(f.client.saveWorkspace).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1);expect(f.saved.data.composer).toBe('two');expect(f.client.saveWorkspace).toHaveBeenCalledTimes(1);});
 it('loads clean server workspaces without browser data and rejects a different session',async()=>{const f=setup();await f.client.saveWorkspace(0,{...defaultWorkspace(),composer:'server',attachmentIds:['image']});const a=new WorkspaceController('A',f.client,memory());await a.hydrate(snapshot(),'A');expect(a.record.data).toMatchObject({composer:'server',attachmentIds:['image']});const b=new WorkspaceController('B',f.client,memory());await expect(b.hydrate(snapshot('B'),'A')).rejects.toThrow('another session');expect(b.record.data.composer).toBe('');});
 it('keeps independent session records when an A save finishes after B edits',async()=>{const storage=memory();const f=setup(storage);let release!:()=>void;const save=f.client.saveWorkspace.getMockImplementation()!;f.client.saveWorkspace.mockImplementationOnce(async(r,d)=>{await new Promise<void>(resolve=>{release=resolve;});return save(r,d);});const a=new WorkspaceController('A',f.client,storage);const b=new WorkspaceController('B',{loadWorkspace:async()=>record('B'),saveWorkspace:async(r,data)=>({sessionId:'B',revision:r+1,data})},storage);await a.hydrate(snapshot(),'A');await b.hydrate(snapshot('B'),'A');a.update(d=>{d.composer='A';});const pending=a.flush();b.update(d=>{d.composer='B';d.layout.mode='rows';});release();await pending;await b.flush();expect(a.record.data.composer).toBe('A');expect(b.record.data.composer).toBe('B');expect(b.record.data.layout.mode).toBe('rows');});
 it('persists immediately, reloads unsaved changes and accepts late updates without listeners',async()=>{const f=setup();const a=new WorkspaceController('A',f.client,f.storage);await a.hydrate(snapshot(),'A');const off=a.subscribe(()=>{});a.update(d=>{d.composer='local';});off();const reload=new WorkspaceController('A',f.client,f.storage);await reload.hydrate(snapshot(),'A');expect(reload.record.data.composer).toBe('local');await a.flush();a.update(d=>{d.composer='late cleanup';});await a.flush();expect(f.saved.data.composer).toBe('late cleanup');await reload.flush();expect(reload.conflict?.data.composer).toBe('late cleanup');});
 it('serializes writes and preserves edits made during an outstanding request',async()=>{const f=setup();let release!:()=>void;const save=f.client.saveWorkspace.getMockImplementation()!;f.client.saveWorkspace.mockImplementationOnce(async(r,d)=>{await new Promise<void>(resolve=>{release=resolve;});return save(r,d);});const a=new WorkspaceController('A',f.client,f.storage);await a.hydrate(snapshot(),'A');a.update(d=>{d.composer='first';});const flushing=a.flush();a.update(d=>{d.composer='second';});release();await flushing;expect(f.saved.data.composer).toBe('second');expect(f.client.saveWorkspace.mock.calls.map(c=>c[0])).toEqual([0,1]);expect(a.unsaved).toBe(false);});
 it('never blindly retries conflicts and supports both explicit resolutions',async()=>{const f=setup();const a=new WorkspaceController('A',f.client,memory());const b=new WorkspaceController('A',f.client,memory());await a.hydrate(snapshot(),'A');await b.hydrate(snapshot(),'A');a.update(d=>{d.composer='saved';});await a.flush();b.update(d=>{d.composer='local';});await b.flush();expect(b.record.data.composer).toBe('local');expect(b.conflict?.data.composer).toBe('saved');const calls=f.client.saveWorkspace.mock.calls.length;await b.flush();expect(f.client.saveWorkspace).toHaveBeenCalledTimes(calls);await b.resolveKeepLocal();expect(f.saved.data.composer).toBe('local');a.update(d=>{d.composer='discard';});await a.flush();a.resolveUseSaved();expect(a.record.data.composer).toBe('local');expect(a.unsaved).toBe(false);});
 it('migrates matching legacy keys once and global layout only for launch session',async()=>{const storage=memory();storage.setItem('composer:A',JSON.stringify('legacy A'));storage.setItem('composer:B',JSON.stringify('legacy B'));storage.setItem('panel-layout','rows');const f=setup(storage);const a=new WorkspaceController('A',f.client,storage);await a.hydrate(snapshot(),'A');expect(a.record.data.composer).toBe('legacy A');expect(a.record.data.layout.mode).toBe('rows');await a.flush();const b=new WorkspaceController('B',{loadWorkspace:async()=>record('B'),saveWorkspace:async(r,data)=>({sessionId:'B',revision:r+1,data})},storage);await b.hydrate(snapshot('B'),'A');expect(b.record.data.composer).toBe('legacy B');expect(b.record.data.layout.mode).toBe('split');await b.flush();a.update(d=>{d.composer='';});await a.flush();const reloaded=new WorkspaceController('A',f.client,storage);await reloaded.hydrate(snapshot(),'A');expect(reloaded.record.data.composer).toBe('');});
 it('does not resurrect removed reviews and preserves their edited text for recovery',async()=>{const f=setup();f.storage.setItem('answer-review:A',JSON.stringify({draft:{id:'removed',revision:1,localizedText:'original'},localizedText:'edited'}));const a=new WorkspaceController('A',f.client,f.storage);await a.hydrate(snapshot(),'A');expect(a.record.data.review).toBeNull();expect(a.recoveredReview).toBe('edited');await a.flush();});
 it('failed flush keeps local content and can be retried explicitly',async()=>{const f=setup();const a=new WorkspaceController('A',f.client,f.storage);await a.hydrate(snapshot(),'A');f.client.saveWorkspace.mockRejectedValueOnce(new Error('Offline'));a.update(d=>{d.composer='safe';});await a.flush();expect(a.unsaved).toBe(true);expect(a.error).toBe('Offline');expect(a.record.data.composer).toBe('safe');await a.flush();expect(f.saved.data.composer).toBe('safe');});
});

it('shares authoritative ordering across mounts and accepts a new runtime epoch without reviving a retired one',()=>{
 const f=setup();const cache=new WorkspaceController('A',f.client,f.storage,'ordering');
 const event=(epoch:string,sequence:number)=>({sessionId:'A',epoch,sequence,snapshot:snapshot()});
 expect(cache.acceptEnvelope(event('first',20),true)).toBe(true);
 expect(cache.acceptEnvelope(event('first',19))).toBe(false);
 expect(cache.envelope?.sequence).toBe(20);
 expect(cache.acceptEnvelope(event('second',0))).toBe(false);
 expect(cache.acceptEnvelope(event('second',0),true)).toBe(true);
 expect(cache.envelope?.epoch).toBe('second');
 expect(cache.acceptEnvelope(event('first',100),true)).toBe(false);
 expect(cache.acceptEnvelope(event('first',100))).toBe(false);
 expect(cache.acceptEnvelope({...event('second',1),sessionId:'B'},true)).toBe(false);
 expect(cache.acceptEnvelope(event('second',1))).toBe(true);
});

async function releasedInOtherTab() {
 const f = setup();
 const target = { agent: 'claude' as const, sessionRef: 'native', projectId: '/project' };
 const old = { requestId: 'old', text: 'original', attachmentIds: ['original-ref'] };
 const draft = { id: 'composer-old', revision: 1, target, sourceRevision: 0, language: 'he', localizedText: 'original', englishText: 'original' };
 let authoritative: ConversationSnapshot = { ...snapshot(), composerDraft: draft, deliveries: [{ id: 'receipt', draftId: draft.id, revision: 1, target, state: 'unconfirmed', englishText: 'original' }] };
 const client = { ...f.client, snapshot: vi.fn(async (): Promise<SessionEnvelope> => ({ sessionId: 'A', sequence: 2, snapshot: structuredClone(authoritative) })) };
 await client.saveWorkspace(0, { ...defaultWorkspace(), composer: 'original', attachmentIds: ['original-ref'], composerAttempt: old });
 const first = new WorkspaceController('A', client, f.storage, 'first-open');
 const second = new WorkspaceController('A', client, f.storage, 'second-open');
 await first.hydrate(authoritative, 'A'); await second.hydrate(authoritative, 'A');
 second.update(data => { data.composer = 'עריכה בכרטיסייה פתוחה'; data.attachmentIds = ['edited-ref']; data.selectedDiscussion = [1]; });
 await first.releaseComposer('old', async () => {
  await client.saveWorkspace(f.saved.revision, { ...f.saved.data, composerAttempt: null });
  delete authoritative.composerDraft;
 });
 // Keep the second tab open: hydration must not be involved in fixing this conflict.
 await second.flush();
 expect(second.conflict).not.toBeNull(); expect(second.record.data.composerAttempt?.requestId).toBe('old');
 return { ...f, client, first, second, old, get savedRecord() { return f.saved; }, setSnapshot: (next: ConversationSnapshot) => { authoritative = next; }, get authoritative() { return authoritative; } };
}

it('does not restore an attempt released by another open tab when keeping local edits', async () => {
 const f = await releasedInOtherTab();
 await f.second.resolveKeepLocal();
 expect(f.savedRecord.data.composerAttempt).toBeNull();
 expect(f.savedRecord.data).toMatchObject({ composer: 'עריכה בכרטיסייה פתוחה', attachmentIds: ['edited-ref'], selectedDiscussion: [1] });
 expect(f.second.conflict).toBeNull(); expect(f.second.unsaved).toBe(false);
});

it.each(['offline', 'foreign', 'stale', 'unavailable'])('keeps the conflict and saves nothing when authoritative snapshot is %s', async mode => {
 const f = await releasedInOtherTab(); const conflict = f.second.conflict; const revision = f.savedRecord.revision;
 if (mode === 'offline') f.client.snapshot.mockRejectedValueOnce(new Error('Snapshot offline'));
 if (mode === 'foreign') f.client.snapshot.mockResolvedValueOnce({ sessionId: 'B', sequence: 2, snapshot: { ...f.authoritative, id: 'B' } });
 if (mode === 'stale') f.second.acceptEnvelope({ sessionId: 'A', sequence: 3, snapshot: f.authoritative }, true);
 if (mode === 'unavailable') Object.assign(f.client, { snapshot: undefined });
 await f.second.resolveKeepLocal();
 expect(f.savedRecord.revision).toBe(revision); expect(f.savedRecord.data.composerAttempt).toBeNull();
 expect(f.second.conflict).toBe(conflict); expect(f.second.record.data.composerAttempt).toEqual(f.old);
 expect(f.second.record.data.composer).toBe('עריכה בכרטיסייה פתוחה'); expect(f.second.error).toBeTruthy();
});

it('preserves a genuine new attempt with no historical receipt when resolving an unrelated conflict', async () => {
 const f = await releasedInOtherTab(); const fresh = { requestId: 'fresh', text: 'new send', attachmentIds: ['new-ref'] };
 f.second.update(data => { data.composerAttempt = fresh; });
 await f.second.resolveKeepLocal();
 expect(f.savedRecord.data.composerAttempt).toEqual(fresh);
});

it('preserves a new local attempt and edits created while release evidence is being fetched', async () => {
 const f = await releasedInOtherTab(); let finish!: (value: SessionEnvelope) => void;
 f.client.snapshot.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
 const pending = f.second.resolveKeepLocal();
 expect(finish).toBeTypeOf('function');
 const fresh = { requestId: 'fresh-in-flight', text: 'new send', attachmentIds: ['new-ref'] };
 f.second.update(data => { data.composer = 'new text'; data.composerAttempt = fresh; data.attachmentIds = ['new-ref']; });
 finish({ sessionId: 'A', sequence: 2, snapshot: f.authoritative }); await pending;
 expect(f.savedRecord.data).toMatchObject({ composer: 'new text', composerAttempt: fresh, attachmentIds: ['new-ref'] });
});

it('does not override a new remote active attempt while removing a historical local lock', async () => {
 const f = await releasedInOtherTab(); const fresh = { requestId: 'remote-new', text: 'remote send', attachmentIds: ['remote-ref'] };
 await f.client.saveWorkspace(f.savedRecord.revision, { ...f.savedRecord.data, composerAttempt: fresh });
 f.setSnapshot({ ...f.authoritative, composerDraft: { id: 'composer-remote-new', revision: 1, target: f.authoritative.deliveries[0]!.target, sourceRevision: 0, language: 'he', localizedText: 'remote send', englishText: 'remote send' } });
 f.second.conflict = structuredClone(f.savedRecord);
 await f.second.resolveKeepLocal();
 expect(f.savedRecord.data.composerAttempt).toEqual(fresh);
 expect(f.second.conflict).not.toBeNull(); expect(f.second.record.data.composer).toBe('עריכה בכרטיסייה פתוחה');
});

it('does not resolve a replacement conflict or undo Use saved while checking a released attempt', async () => {
 const f = await releasedInOtherTab(); let finish!: (value: SessionEnvelope) => void;
 f.client.snapshot.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
 const pending = f.second.resolveKeepLocal(); expect(finish).toBeTypeOf('function');
 f.second.resolveUseSaved(); const saved = structuredClone(f.second.record);
 finish({ sessionId: 'A', sequence: 2, snapshot: f.authoritative }); await pending;
 expect(f.second.record).toEqual(saved); expect(f.second.unsaved).toBe(false);
});

it('retains an intervening remote workspace conflict instead of silently adopting its latest revision', async () => {
 const f = await releasedInOtherTab(); let finish!: (value: SessionEnvelope) => void;
 f.client.snapshot.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
 const pending = f.second.resolveKeepLocal();
 await f.client.saveWorkspace(f.savedRecord.revision, { ...f.savedRecord.data, composer: 'new remote edit' });
 finish({ sessionId: 'A', sequence: 2, snapshot: f.authoritative }); await pending;
 expect(f.savedRecord.data.composer).toBe('new remote edit'); expect(f.savedRecord.data.composerAttempt).toBeNull();
 expect(f.second.conflict?.revision).toBe(f.savedRecord.revision);
 expect(f.second.record.data).toMatchObject({ composer: 'עריכה בכרטיסייה פתוחה', composerAttempt: null });
});
