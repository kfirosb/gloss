import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../../src/runtime/application.js';
import { startServer } from '../../src/runtime/http-server.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c(); });
async function setup() {
  // A fake agent home stands in for ~/.claude or ~/.codex; the endpoint must never touch it.
  const agentHome = mkdtempSync(join(tmpdir(), 'fake-agent-home-'));
  const transcript = join(agentHome, 'B.jsonl'); writeFileSync(transcript, '{"x":1}\n');
  cleanup.push(() => rmSync(agentHome, { recursive: true, force: true }));
  const store = new SqliteStore(':memory:');
  const app = createApplication({ store, agents: [new FakeAgent()], conversationId: 'A', capability: 'cap', languageBackends: { codex: { open: vi.fn(async () => new FakeLanguageSession()), models: async () => [] } } });
  for (const id of ['A', 'B']) await app.sessions!.register({ agent: 'codex', sessionRef: id, projectId: process.cwd() }, id);
  const server = await startServer(app); const base = new URL('/api/', server.url);
  const request = (path: string, method = 'GET', auth = true) => fetch(new URL(path, base), { method, headers: auth ? { authorization: 'Bearer cap' } : {} });
  cleanup.push(async () => { await server.close(); await app.close(); });
  return { request, store, app, transcript, agentHome };
}

it('requires the capability', async () => {
  const { request, store } = await setup();
  expect((await request('sessions/B', 'DELETE', false)).status).toBe(401);
  expect(store.listSessions()).toHaveLength(2);
});
it('404s for an unknown session', async () => {
  const { request } = await setup();
  expect((await request('sessions/nope', 'DELETE')).status).toBe(404);
});
it('deletes a closed session, its related rows and leaves agent transcripts alone', async () => {
  const { request, store, app, transcript } = await setup();
  store.save({ id: 'B', target: { agent: 'codex', sessionRef: 'B', projectId: process.cwd() }, codingState: 'disconnected', codingMessages: [], discussion: [], deliveries: [], language: 'he', languageSessionId: '', languageModel: 'm', sourceRevision: 0 });
  store.writeLanguageOverride('B', { reply: 'en' });
  store.putLaunch({ id: 'L1', agent: 'codex', folder: process.cwd(), panePid: 1, panelSessionId: 'B', state: 'ended', createdAt: 1 });
  const res = await request('sessions/B', 'DELETE');
  expect(res.status).toBe(200);
  expect(store.listSessions().map(r => r.id)).toEqual(['A']);
  expect(store.load('B')).toBeUndefined();
  expect(store.listLaunches()).toEqual([]);
  expect(app.catalog!.snapshot().entries.some(e => e.sessionId === 'B')).toBe(false);
  expect((await request('sessions/B/snapshot')).status).toBe(404);
  expect(existsSync(transcript)).toBe(true);
});
it('returns 409 for an open (live) session and keeps it', async () => {
  const { request, store, app } = await setup();
  await app.sessions!.ensure('A');
  const open = await request('sessions/A', 'DELETE');
  expect(open.status).toBe(409);
  expect((await open.json()).error).toMatch(/open/);
  expect(store.listSessions()).toHaveLength(2);
});
it('refuses a session whose launch is still running', async () => {
  const store = new SqliteStore(':memory:');
  const launcher = { list: () => [{ id: 'L1', agent: 'codex', folder: '/x', panePid: 1, panelSessionId: 'B', state: 'running', createdAt: 1 }], subscribe: () => () => {}, reconcile: async () => {}, close() {} } as any;
  const app = createApplication({ store, agents: [new FakeAgent()], conversationId: 'A', capability: 'cap', launcher, languageBackends: {} });
  await app.sessions!.register({ agent: 'codex', sessionRef: 'B', projectId: process.cwd() }, 'B');
  await expect(app.removeSession!('B')).rejects.toMatchObject({ code: 'session-open' });
  expect(store.listSessions()).toHaveLength(1);
  await app.close();
});
