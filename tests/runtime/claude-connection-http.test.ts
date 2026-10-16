import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../../src/runtime/application.js';
import { startServer } from '../../src/runtime/http-server.js';
import type { PeerSetting } from '../../src/runtime/claude-peer-setting.js';
import type { RegistrationStatus } from '../../src/runtime/claude-registration.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';

const clean: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of clean.splice(0).reverse()) await close();
});
async function root() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'claude-connection-http-')));
  clean.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
const call = (url: string, method: string, body?: unknown, auth = true) =>
  fetch(url, {
    method,
    headers: {
      ...(auth ? { authorization: 'Bearer cap' } : {}),
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

it('reads registration with GET and changes it only through an explicit POST action', async () => {
  const folder = await root();
  let state: RegistrationStatus = { state: 'unregistered' };
  const status = vi.fn(async () => state);
  const register = vi.fn(
    async (): Promise<RegistrationStatus> => (state = { state: 'registered' }),
  );
  const remove = vi.fn(
    async (): Promise<RegistrationStatus> => (state = { state: 'unregistered' }),
  );
  const app = createApplication({
    store: new SqliteStore(':memory:'),
    agents: [],
    languageBackends: {},
    capability: 'cap',
    attachmentRoot: join(folder, 'uploads'),
    claudeRegistration: { status, register, remove },
  });
  clean.push(() => app.close());
  const server = await startServer(app);
  clean.push(() => server.close());
  const url = new URL('/api/claude/registration', server.url).href;
  expect((await call(url, 'GET', undefined, false)).status).toBe(401);
  expect(await (await call(url, 'GET')).json()).toEqual({ state: 'unregistered' });
  expect((await call(url, 'POST', { action: 'register', configDir: '/tmp/evil' })).status).toBe(
    400,
  );
  expect((await call(url, 'POST', {})).status).toBe(400);
  expect((await call(url, 'POST', ['register'])).status).toBe(400);
  expect(register).not.toHaveBeenCalled();
  expect(await (await call(url, 'POST', { action: 'register' })).json()).toEqual({
    state: 'registered',
  });
  expect(await (await call(url, 'POST', { action: 'remove' })).json()).toEqual({
    state: 'unregistered',
  });
  expect(register).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledTimes(1);
});

it('reads and allows the peer setting only for a known session and only with the exact action', async () => {
  const folder = await root();
  const project = join(folder, 'project');
  await mkdir(project);
  const read = vi.fn(async (): Promise<PeerSetting> => ({ user: 'unset' }));
  const allowAll = vi.fn(async (): Promise<PeerSetting> => ({ user: 'accept' }));
  const app = createApplication({
    store: new SqliteStore(':memory:'),
    agents: [],
    languageBackends: {},
    capability: 'cap',
    attachmentRoot: join(folder, 'uploads'),
    claudePeerSetting: { read, allowAll },
  });
  clean.push(() => app.close());
  await app.sessions?.register(
    { agent: 'claude', sessionRef: '11111111-1111-4111-8111-111111111111', projectId: project },
    'A',
  );
  const server = await startServer(app);
  clean.push(() => server.close());
  const url = (id: string) => new URL(`/api/sessions/${id}/claude-peer`, server.url).href;
  expect((await call(url('A'), 'GET', undefined, false)).status).toBe(401);
  expect((await call(url('missing'), 'GET')).status).toBe(404);
  expect(await (await call(url('A'), 'GET')).json()).toEqual({ user: 'unset' });
  expect(read).toHaveBeenCalledWith(project);
  expect((await call(url('A'), 'POST', {})).status).toBe(400);
  expect((await call(url('A'), 'POST', { action: 'hold' })).status).toBe(400);
  expect(allowAll).not.toHaveBeenCalled();
  expect(await (await call(url('A'), 'POST', { action: 'accept' })).json()).toEqual({
    user: 'accept',
  });
  expect(allowAll).toHaveBeenCalledExactlyOnceWith(project);
});
