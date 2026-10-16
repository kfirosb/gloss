import { afterEach, expect, it, vi } from 'vitest';
import { createApplication } from '../../src/runtime/application.js';
import { startServer } from '../../src/runtime/http-server.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});
async function setup() {
  const store = new SqliteStore(':memory:');
  const app = createApplication({
    store,
    agents: [new FakeAgent()],
    conversationId: 'A',
    capability: 'cap',
    languageBackends: {
      codex: { open: vi.fn(async () => new FakeLanguageSession()), models: async () => [] },
    },
  });
  for (const id of ['A', 'B'])
    await app.sessions!.register({ agent: 'codex', sessionRef: id, projectId: process.cwd() }, id);
  const server = await startServer(app);
  const base = new URL('/api/', server.url);
  const request = (path: string, method = 'GET', body?: unknown, auth = true) =>
    fetch(new URL(path, base), {
      method,
      headers: {
        ...(auth ? { authorization: 'Bearer cap' } : {}),
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  cleanup.push(async () => {
    await server.close();
    await app.close();
  });
  return { request, store, app };
}
const en = { write: 'en', send: 'en', reply: 'en', assist: 'en' };

it('requires the capability', async () => {
  const { request } = await setup();
  expect((await request('settings/language', 'GET', undefined, false)).status).toBe(401);
  expect((await request('sessions/A/language', 'GET', undefined, false)).status).toBe(401);
});
it('reads and replaces defaults; rejects invalid codes without changing them', async () => {
  const { request } = await setup();
  expect(await (await request('settings/language')).json()).toEqual({
    write: 'he',
    send: 'en',
    reply: 'he',
    assist: 'he',
  });
  expect((await request('settings/language', 'PUT', en)).status).toBe(200);
  for (const bad of [
    { ...en, reply: 'fr' },
    { ...en, write: '' },
    { ...en, send: 123 },
  ])
    expect((await request('settings/language', 'PUT', bad)).status).toBe(400);
  expect(await (await request('settings/language')).json()).toEqual(en);
});
it('session override follows defaults for unset fields and resets', async () => {
  const { request } = await setup();
  expect((await request('sessions/A/language', 'PUT', { reply: 'he' })).status).toBe(200);
  await request('settings/language', 'PUT', en);
  expect((await (await request('sessions/A/language')).json()).effective).toEqual({
    ...en,
    reply: 'he',
  });
  expect((await (await request('sessions/B/language')).json()).effective).toEqual(en);
  expect((await request('sessions/A/language', 'DELETE')).status).toBe(200);
  expect((await (await request('sessions/A/language')).json()).override).toEqual({});
  expect((await request('sessions/missing/language')).status).toBe(404);
});
it('rejects non-object PUT bodies instead of resetting the override', async () => {
  const { request } = await setup();
  await request('sessions/A/language', 'PUT', { reply: 'en' });
  for (const bad of [null, [], 'he', 3])
    expect((await request('sessions/A/language', 'PUT', bad)).status).toBe(400);
  expect((await (await request('sessions/A/language')).json()).override).toEqual({ reply: 'en' });
});
it('snapshots of sessions without a live workflow carry the current effective settings', async () => {
  const { request } = await setup();
  const snap = async (id: string) =>
    (await (await request(`sessions/${id}/snapshot`)).json()).snapshot;
  expect((await snap('B')).languageSettings).toEqual({
    write: 'he',
    send: 'en',
    reply: 'he',
    assist: 'he',
  });
  expect((await request('sessions/B/language', 'PUT', { assist: 'en', reply: 'en' })).status).toBe(
    200,
  );
  expect((await snap('B')).languageSettings).toEqual({
    write: 'he',
    send: 'en',
    reply: 'en',
    assist: 'en',
  });
  expect((await snap('B')).language).toBe('en');
  await request('settings/language', 'PUT', en);
  expect((await snap('B')).languageSettings).toEqual(en);
});
it('publishes to listeners of a session without a workflow, and open sessions follow defaults changes', async () => {
  const { request, app } = await setup();
  const events: any[] = [];
  const unsubscribe = app.sessions!.subscribe('B', (e) => events.push(e));
  await request('sessions/B/language', 'PUT', { write: 'en' });
  expect(events.at(-1).snapshot.languageSettings.write).toBe('en');
  unsubscribe();
  await request('sessions/A/actions', 'POST', {
    type: 'connect',
    target: { agent: 'codex', sessionRef: 'A', projectId: process.cwd() },
  });
  const open: any[] = [];
  app.sessions!.subscribe('A', (e) => open.push(e));
  await request('settings/language', 'PUT', en);
  expect(open.at(-1).snapshot.languageSettings).toEqual(en);
  expect((await (await request('sessions/A/snapshot')).json()).snapshot.languageSettings).toEqual(
    en,
  );
});
