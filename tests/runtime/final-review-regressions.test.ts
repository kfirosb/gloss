import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../../src/runtime/application.js';
import { startServer } from '../../src/runtime/http-server.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';
import type { AgentAdapter } from '../../src/core/contracts.js';
import { defaultWorkspace } from '../../src/core/session-contracts.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function setup(agent = new FakeAgent('claude'), store = new SqliteStore(':memory:')) {
  const languages: FakeLanguageSession[] = [];
  const app = createApplication({ store, agents: [agent], capability: 'fixture', languageBackends: {
    [agent.kind]: { open: async () => { const language = new FakeLanguageSession(); languages.push(language); return language; }, models: async () => [] },
  } });
  cleanups.push(() => app.close());
  return { app, store, agent, languages };
}
it('reconnects the same disconnected Claude target through the registration HTTP route and coalesces retries', async () => {
  const f = setup();
  const target = { agent: 'claude' as const, sessionRef: 'native', projectId: process.cwd() };
  vi.spyOn(f.agent as AgentAdapter, 'discover').mockResolvedValue([target]);
  const attach = vi.spyOn(f.agent, 'attach');
  const server = await startServer(f.app); cleanups.push(() => server.close());
  const register = () => fetch(new URL('/api/sessions', server.url), { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: JSON.stringify({ target }) });
  const first = await (await register()).json();
  expect((await (await register()).json()).snapshot.codingState).toBe('idle');
  f.agent.emit({ type: 'status', state: 'working' });
  await vi.waitFor(() => expect(f.app.sessions!.snapshot(first.sessionId).snapshot.codingState).toBe('working'));
  expect((await (await register()).json()).snapshot.codingState).toBe('working');
  expect(attach).toHaveBeenCalledTimes(1);
  expect(f.agent.detachedTargets).toEqual([]);
  const workspace = f.store.writeWorkspace(first.sessionId, 0, { ...defaultWorkspace(), composer: 'Keep unsent work', composerAttempt: { requestId: 'uncertain', text: 'Keep pending', attachmentIds: [] } });
  f.agent.emit({ type: 'status', state: 'disconnected' });
  await vi.waitFor(() => expect(f.app.sessions!.snapshot(first.sessionId).snapshot.codingState).toBe('disconnected'));
  let release!: () => void;
  f.agent.attachGates.set('native', new Promise<void>(resolve => { release = resolve; }));
  const responses = Promise.all([register(), register()]);
  try { await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(2)); }
  finally { release(); }
  for (const response of await responses) {
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sessionId: first.sessionId, snapshot: { target, codingState: 'idle' } });
  }
  expect(attach).toHaveBeenCalledTimes(2);
  expect(f.agent.detachedTargets).toEqual(['native']);
  expect(f.store.readWorkspace(first.sessionId)).toEqual(workspace);
  expect(f.agent.sent).toEqual([]);
  expect(f.languages).toHaveLength(1);
});
it('projects manually connected Claude lifecycle into open membership without automatic enumeration', async () => {
  const f = setup();
  const target = { agent: 'claude' as const, sessionRef: 'manual', projectId: process.cwd() };
  const discover = vi.spyOn(f.agent as AgentAdapter, 'discover').mockResolvedValue([target]);
  await f.app.restore!();
  const first = await f.app.createSession!(target);
  await vi.waitFor(() => expect(f.app.catalog!.snapshot().entries[0]).toMatchObject({ sessionId: first.sessionId, open: true, activity: 'idle' }));
  f.agent.emit({ type: 'status', state: 'working' });
  await vi.waitFor(() => expect(f.app.catalog!.snapshot().entries[0]).toMatchObject({ open: true, activity: 'working' }));
  f.agent.emit({ type: 'status', state: 'disconnected' });
  await vi.waitFor(() => expect(f.app.catalog!.snapshot().entries[0]).toMatchObject({ open: false, activity: 'disconnected' }));
  expect(discover).toHaveBeenCalledTimes(1);
});
it.each(['reconnect', 'restart'] as const)('recovers a missing migrated project on %s without altering identity or saved work', async recovery => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'recover-missing-project-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const target = { agent: 'claude' as const, sessionRef: 'legacy-native', projectId: project };
  let store = new SqliteStore(join(root, 'fixture.db'));
  const delivery = { id: 'uncertain-receipt', draftId: 'original-draft', revision: 1, target, state: 'unconfirmed' as const, englishText: 'Pending instruction' };
  const draft = { id: delivery.draftId, revision: 1, target, sourceRevision: 0, language: 'he', localizedText: 'Pending instruction', englishText: delivery.englishText };
  store.save({ id: 'legacy', currentDraft: draft, target, codingState: 'disconnected', codingMessages: [], discussion: [], deliveries: [delivery], language: 'he', languageSessionId: 'old-language', languageModel: 'test', sourceRevision: 0 });
  let f = setup(new FakeAgent('claude'), store);
  vi.spyOn(f.agent as AgentAdapter, 'discover').mockResolvedValue([target]);
  await f.app.restore!();
  expect(store.listSessions()[0]!.canonicalRoot).toBe('');
  await expect(f.app.sessions!.register({ ...target, projectId: root })).rejects.toThrow('different project');
  const workspace = store.writeWorkspace('legacy', 0, { ...defaultWorkspace(), composer: 'Unsent legacy', composerAttempt: { requestId: 'pending', text: 'Pending legacy', attachmentIds: [] } });
  await mkdir(project); await writeFile(join(project, 'example.txt'), 'Recovered file');
  if (recovery === 'reconnect') expect((await f.app.createSession!(target)).sessionId).toBe('legacy');
  else {
    await f.app.close();
    store = new SqliteStore(join(root, 'fixture.db'));
    f = setup(new FakeAgent('claude'), store);
    await f.app.restore!();
  }
  expect(await f.app.files!.search('legacy', 'example', new AbortController().signal)).toContainEqual({ name: 'example.txt', relativePath: 'example.txt' });
  const reference = await f.app.files!.reference('legacy', 'example.txt');
  expect(reference).toMatchObject({ sessionId: 'legacy', index: 1, source: 'worktree' });
  expect(store.listSessions()[0]).toMatchObject({ id: 'legacy', target, canonicalRoot: project });
  expect(store.readWorkspace('legacy')).toEqual(workspace);
  expect(f.app.sessions!.snapshot('legacy').snapshot.deliveries).toEqual([delivery]);
  expect(f.agent.sent).toEqual([]);
  await f.app.sessions!.register({ ...target, sessionRef: 'other' }, 'other');
  await expect(f.app.files!.resolve('other', [reference.id])).rejects.toThrow('belong');
  await f.app.close();
  const reopened = setup(new FakeAgent('claude'), new SqliteStore(join(root, 'fixture.db')));
  await reopened.app.restore!();
  expect(reopened.store.readWorkspace('legacy')).toEqual(workspace);
  expect(reopened.app.sessions!.snapshot('legacy').snapshot.deliveries).toEqual([delivery]);
  expect(reopened.agent.sent).toEqual([]);
  expect(await reopened.app.files!.resolve('legacy', [reference.id])).toEqual([reference]);
  expect(await reopened.app.files!.search('legacy', 'example', new AbortController().signal)).toHaveLength(1);
});
it('does not replace an established canonical root when the same project path points elsewhere', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'preserve-project-root-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const folder of ['original', 'replacement']) await mkdir(join(root, folder));
  const project = join(root, 'alias'); await symlink(join(root, 'original'), project);
  const f = setup(); const target = { agent: 'claude' as const, sessionRef: 'native', projectId: project };
  const record = await f.app.sessions!.register(target);
  await unlink(project); await symlink(join(root, 'replacement'), project);
  await f.app.sessions!.register(target);
  expect(f.store.listSessions()[0]!.canonicalRoot).toBe(record.canonicalRoot);
});
it('application close during catalog attachment releases resources and never publishes a late connection', async () => {
  const f = setup(new FakeAgent());
  const target = { agent: 'codex' as const, sessionRef: 'closing-native', projectId: process.cwd() };
  Object.assign(f.agent, { discoverOpen: async () => ({ complete: true, candidates: [{ target, support: 'supported' }] }) });
  let release!: () => void;
  f.agent.attachGates.set(target.sessionRef, new Promise<void>(resolve => { release = resolve; }));
  const attach = vi.spyOn(f.agent, 'attach');
  const storeClose = vi.spyOn(f.store, 'close');
  await f.app.restore!();
  await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
  expect(f.app.sessions!.list()).toHaveLength(1);
  const languageClose = vi.spyOn(f.languages[0]!, 'close');
  const listener = vi.fn(); f.app.catalog!.subscribe(listener);
  const snapshot = f.app.catalog!.snapshot();
  const closing = f.app.close(); release(); await closing;
  expect(f.app.catalog!.snapshot()).toEqual(snapshot);
  expect(listener).not.toHaveBeenCalled();
  expect(languageClose).toHaveBeenCalledTimes(1);
  expect(f.agent.detachedTargets).toEqual([target.sessionRef]);
  expect(storeClose).toHaveBeenCalledTimes(1);
  expect(f.agent.sent).toEqual([]);
});
