import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationSnapshot, Delivery } from '../../src/core/contracts.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';

const directories: string[] = [];
const databasePath = () => {
  const directory = mkdtempSync(join(tmpdir(), 'language-assistant-'));
  directories.push(directory);
  chmodSync(directory, 0o777);
  return join(directory, 'private-data', 'assistant.sqlite');
};

const target = { agent: 'codex' as const, sessionRef: 'session-1', projectId: 'project-1' };
const delivery: Delivery = {
  id: 'delivery-1', draftId: 'draft-1', revision: 2, target,
  englishText: 'Ship it', state: 'sending',
};
const snapshot = (): ConversationSnapshot => ({
  id: 'conversation-1', target, codingState: 'working',
  codingMessages: [
    { sourceId: 'm1', revision: 1, role: 'user', text: 'first', complete: true },
    { sourceId: 'm2', revision: 3, role: 'assistant', text: 'second', complete: true },
  ],
  discussion: [{ role: 'user', text: 'מה השתנה?' }, { role: 'assistant', text: 'הסבר' }],
  currentDraft: {
    id: 'draft-1', revision: 2, target, sourceRevision: 4, language: 'he',
    localizedText: 'שלח', englishText: 'Ship it',
  },
  deliveries: [], language: 'he', languageSessionId: 'language-1',
  languageModel: 'model-1', sourceRevision: 4,
  hostMetadata: { windowId: 99, socket: '/private/host.sock' },
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SqliteStore', () => {
  it('keeps stable legacy turn identities and interrupted completion across reloads', () => {
    const store=new SqliteStore(databasePath());const state=snapshot();store.save(state);
    const first=store.load(state.id)!;
    expect(first.discussion[1]).toMatchObject({id:expect.any(String),complete:true,text:'הסבר'});
    expect(store.load(state.id)!.discussion).toEqual(first.discussion);
    first.discussion[1]!.complete=false;store.save(first);
    expect(store.load(state.id)!.discussion[1]).toEqual(first.discussion[1]);store.close();
  });
  it('isolates cached summaries by session source content model and prompt', () => {
    const store=new SqliteStore(databasePath());const key={sessionId:'s',kind:'coding' as const,messageId:'m',contentHash:'h',language:'he' as const,model:'model',promptVersion:'v1'};
    store.putSummary(key,'תקציר');expect(store.getSummary(key)).toBe('תקציר');
    for(const changed of [{sessionId:'other'},{kind:'discussion' as const},{messageId:'m2'},{contentHash:'new'},{model:'new'},{promptVersion:'v2'}])expect(store.getSummary({...key,...changed})).toBeUndefined();
    store.close();
  });
  it('persists renamed session titles without retargeting or clearing workspaces', () => {
    const path = databasePath(); const store = new SqliteStore(path);
    store.registerSession({id:'named',target,canonicalRoot:'/project',projectName:'Project',enabled:true});
    const workspace = store.readWorkspace('named'); workspace.data.composer = 'Keep draft';
    store.writeWorkspace('named',workspace.revision,workspace.data);
    store.updateSessionTitle('named','Renamed'); store.close();
    const reopened = new SqliteStore(path);
    expect(reopened.listSessions()[0]).toMatchObject({target,sessionTitle:'Renamed'});
    expect(reopened.readWorkspace('named').data.composer).toBe('Keep draft'); reopened.close();
  });
  it('persists translation completion without a source revision change', () => {
    const path = databasePath(); const store = new SqliteStore(path); const state = snapshot();
    store.save(state);
    state.codingMessages[1]!.translationStatus = 'complete';
    state.codingMessages[1]!.translatedText = 'translated reply';
    state.codingMessages[1]!.timestamp = '2026-09-24T08:00:00Z';
    store.save(state); store.close();
    const reopened = new SqliteStore(path);
    expect(reopened.load(state.id)?.codingMessages[1]).toMatchObject({ revision: 3, translationStatus: 'complete', translatedText: 'translated reply', timestamp: '2026-09-24T08:00:00Z' });
    reopened.close();
  });

  it('reopens portable conversation data without host metadata', () => {
    const path = databasePath();
    const first = new SqliteStore(path);
    first.save(snapshot());
    expect(first.claimDelivery(delivery)).toBe(true);
    first.updateDelivery({ ...delivery, state: 'queued' });
    first.close();

    const second = new SqliteStore(path);
    expect(second.load('conversation-1')).toEqual({
      ...snapshot(), codingState: 'working', hostMetadata: undefined,
      discussion:snapshot().discussion.map((turn,index)=>({...turn,id:`conversation-1:legacy:${index}`,complete:true})),
      deliveries: [{ ...delivery, state: 'queued' }],
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
    second.close();
  });

  it('reopens at the current schema version and rejects a database from a newer version', () => {
    const currentPath = databasePath();
    new SqliteStore(currentPath).close();
    expect(() => new SqliteStore(currentPath).close()).not.toThrow();

    const futurePath = databasePath();
    new SqliteStore(futurePath).close();
    const future = new DatabaseSync(futurePath);
    future.exec('INSERT INTO schema_migrations VALUES (999)');
    future.close();
    expect(() => new SqliteStore(futurePath)).toThrow('newer schema version 999');
  });

  it('claims a draft revision atomically across two connections and explicit recovery marks it unconfirmed', () => {
    const path = databasePath();
    const first = new SqliteStore(path);
    const second = new SqliteStore(path);
    expect(first.claimDelivery(delivery)).toBe(true);
    expect(second.claimDelivery({ ...delivery, id: 'delivery-2' })).toBe(false);
    expect(second.recoverInFlightDeliveries()).toBe(1);
    expect(first.getDelivery('draft-1', 2)).toMatchObject({ id: 'delivery-1', state: 'unconfirmed' });
    first.close();
    second.close();
  });

  it('merges source revisions from partial repeated snapshots without duplicating or losing history', () => {
    const path = databasePath();
    const first = new SqliteStore(path);
    first.save(snapshot());
    first.close();
    const second = new SqliteStore(path);
    const repeated = snapshot();
    repeated.codingMessages = [
      { sourceId: 'm2', revision: 3, role: 'assistant', text: 'second', complete: true },
      { sourceId: 'm2', revision: 3, role: 'assistant', text: 'second', complete: true },
    ];
    second.save(repeated);
    expect(second.load('conversation-1')?.codingMessages).toEqual(snapshot().codingMessages);
    second.close();
  });

  it('clears prior source history and resets its revision when the target changes', () => {
    const path = databasePath();
    const store = new SqliteStore(path);
    store.save(snapshot());
    const { currentDraft: _currentDraft, ...withoutDraft } = snapshot();
    store.save({
      ...withoutDraft,
      target: { ...target, sessionRef: 'session-2' },
      codingMessages: [], sourceRevision: 0,
    });
    expect(store.load('conversation-1')).toMatchObject({ codingMessages: [], sourceRevision: 0 });
    store.close();
  });

  it('scopes translation cache entries by every key field and persists project context', () => {
    const path = databasePath();
    const first = new SqliteStore(path);
    const key = {
      sourceScope: 'project-1/session-1', sourceId: 'm1', sourceRevision: 1,
      contentHash: 'hash-a', language: 'he', model: 'model-1', promptVersion: 'v1',
    };
    first.putTranslation(key, 'תרגום');
    first.writeContext('project-1', 'Prefer small modules.');
    first.close();
    const second = new SqliteStore(path);
    expect(second.getTranslation(key)).toBe('תרגום');
    expect(second.getTranslation({ ...key, contentHash: 'hash-b' })).toBeUndefined();
    expect(second.readContext('project-1')).toBe('Prefer small modules.');
    second.deleteContext('project-1');
    expect(second.readContext('project-1')).toBeUndefined();
    second.close();
  });

  it('lists conversations by project and deletes their draft delivery records', () => {
    const path = databasePath();
    const store = new SqliteStore(path);
    store.save(snapshot());
    expect(store.claimDelivery(delivery)).toBe(true);
    store.save({
      ...snapshot(), id: 'conversation-2',
      target: { ...target, projectId: 'project-2' },
      currentDraft: { ...snapshot().currentDraft!, id: 'draft-2', target: { ...target, projectId: 'project-2' } },
    });
    expect(store.list('project-1').map(({ id }) => id)).toEqual(['conversation-1']);
    store.deleteConversation('conversation-1');
    expect(store.load('conversation-1')).toBeUndefined();
    expect(store.getDelivery('draft-1', 2)).toBeUndefined();
    store.close();
  });
});
it('persists composer delivery separately from the prepared review across reopen', () => {
  const path = databasePath(); const store = new SqliteStore(path);
  const state = snapshot();
  state.discussion[0] = {role:'user',text:'Image 1',attachments:[{id:'image-1',index:1,name:'Reference.png',mime:'image/png',size:68,path:'/tmp/reference.png'}]};
  state.currentDraft!.attachments=state.discussion[0].attachments!;
  state.composerDraft = { ...state.currentDraft!, id: 'composer-request', revision: 1, localizedText: 'Composer source', englishText: 'Composer English', attachments: [{ id: 'image-1', name: 'Reference.png', mime: 'image/png', size: 68, path: '/tmp/reference.png' }] };
  store.save(state);
  const receipt = { ...delivery, id: 'composer-receipt', draftId: state.composerDraft.id, revision: 1, state: 'queued' as const, nativeMessageId: 'native-receipt', attachments: state.composerDraft.attachments! };
  store.claimDelivery(receipt); store.close();
  const reopened = new SqliteStore(path); const restored = reopened.load(state.id)!;
  expect(restored.currentDraft).toEqual(state.currentDraft);
  expect(restored.discussion).toEqual(state.discussion.map((turn,index)=>({...turn,id:`conversation-1:legacy:${index}`,complete:true})));
  expect(restored.composerDraft).toEqual(state.composerDraft);
  expect(restored.deliveries).toContainEqual(receipt);
  reopened.close();
});

it('repairs inherited reply images without changing original images or prepared work',()=>{
 const path=databasePath();const store=new SqliteStore(path);const state=snapshot();
 const attachments=[{id:'one',index:1,name:'Reference.png',mime:'image/png',size:1,path:'/tmp/reference.png'}];
 state.discussion=[{role:'user',text:'Image request',attachments},{role:'assistant',text:'Image reply',attachments},{role:'user',text:'Unrelated request'},{role:'assistant',text:'Unrelated reply',attachments}];
 state.currentDraft!.attachments=attachments;store.save(state);store.close();
 const raw=new DatabaseSync(path);raw.exec('DELETE FROM schema_migrations WHERE version=13');raw.close();
 const reopened=new SqliteStore(path);const restored=reopened.load(state.id)!;
 expect(restored.discussion[0]?.attachments).toEqual(attachments);
 expect(restored.discussion[1]?.attachments).toEqual(attachments);
 expect(restored.discussion[3]?.attachments).toBeUndefined();
 expect(restored.currentDraft).toEqual(state.currentDraft);reopened.close();
});
