import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../../src/runtime/application.js';
import { startServer } from '../../src/runtime/http-server.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'edit-http-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'edit-http-outside-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  cleanup.push(() => rm(outside, { recursive: true, force: true }));
  const app = createApplication({
    store: new SqliteStore(':memory:'),
    agents: [new FakeAgent()],
    conversationId: 'A',
    capability: 'cap',
    languageBackends: {
      codex: { open: vi.fn(async () => new FakeLanguageSession()), models: async () => [] },
    },
  });
  await app.sessions!.register({ agent: 'codex', sessionRef: 'A', projectId: root }, 'A');
  const server = await startServer(app);
  cleanup.push(async () => {
    await server.close();
    await app.close();
  });
  const base = new URL('/api/sessions/A/', server.url);
  const call = (path: string, method = 'GET', body?: unknown, auth = true) =>
    fetch(new URL(path, base), {
      method,
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: 'Bearer cap' } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { root, outside, call, base };
}

it('requires the capability for reading, saving and creating', async () => {
  const { root, call } = await setup();
  await writeFile(join(root, '.env'), 'KEY=1\n');
  expect((await call('files/editable?path=.env', 'GET', undefined, false)).status).toBe(401);
  const save = { path: '.env', text: 'KEY=2\n', baseVersion: 'x' };
  expect((await call('files/edit', 'PUT', save, false)).status).toBe(401);
  expect((await call('files/create', 'POST', { path: 'n.txt', text: '' }, false)).status).toBe(401);
  expect(await readFile(join(root, '.env'), 'utf8')).toBe('KEY=1\n');
  expect(await readdir(root)).toEqual(['.env']);
});

it('rejects a cross-origin request before touching the file', async () => {
  const { root, base } = await setup();
  await writeFile(join(root, 'a.txt'), 'a');
  const response = await fetch(new URL('files/create', base), {
    method: 'POST',
    headers: { authorization: 'Bearer cap', origin: 'https://evil.example' },
    body: JSON.stringify({ path: 'b.txt', text: 'x' }),
  });
  expect(response.status).toBe(403);
  expect(await readdir(root)).toEqual(['a.txt']);
});

it('opens, saves, refuses a stale version with 409 and creates without replacing', async () => {
  const { root, call } = await setup();
  await writeFile(join(root, 'notes.md'), 'one\n');
  const opened = await (await call('files/editable?path=notes.md')).json();
  expect(opened).toMatchObject({ relativePath: 'notes.md', text: 'one\n' });
  const saved = await call('files/edit', 'PUT', {
    path: 'notes.md',
    text: 'two\n',
    baseVersion: opened.version,
  });
  expect(saved.status).toBe(200);
  expect(saved.headers.get('cache-control')).toBe('no-store');
  expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe('two\n');
  const stale = await call('files/edit', 'PUT', {
    path: 'notes.md',
    text: 'three\n',
    baseVersion: opened.version,
  });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: 'file-changed' });
  expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe('two\n');
  const created = await call('files/create', 'POST', { path: 'src/new.ts', text: 'x\n' });
  expect(created.status).toBe(200);
  expect(await readFile(join(root, 'src/new.ts'), 'utf8')).toBe('x\n');
  const taken = await call('files/create', 'POST', { path: 'notes.md', text: 'replaced' });
  expect(taken.status).toBe(409);
  expect(await taken.json()).toMatchObject({ code: 'file-exists' });
  expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe('two\n');
});

it('refuses writes outside the folder, through links, into .git and with encoded traversal', async () => {
  const { root, outside, call } = await setup();
  await writeFile(join(outside, 'secret.txt'), 'private');
  await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
  await symlink(outside, join(root, 'linked'));
  const refusals = [
    await call('files/create', 'POST', { path: '../escaped.txt', text: 'x' }),
    await call('files/create', 'POST', { path: join(outside, 'abs.txt'), text: 'x' }),
    await call('files/create', 'POST', { path: 'linked/new.txt', text: 'x' }),
    await call('files/create', 'POST', { path: '.git/config', text: 'x' }),
    await call('files/edit', 'PUT', { path: 'escape.txt', text: 'x', baseVersion: 'v' }),
    await call('files/edit', 'PUT', { path: 'linked/secret.txt', text: 'x', baseVersion: 'v' }),
    await call('files/editable?path=%2e%2e%2f' + encodeURIComponent('etc/hosts')),
    await call('files/editable?path=escape.txt'),
    await call('files/create', 'POST', { text: 'no path' }),
  ];
  for (const response of refusals) expect(response.status).toBe(400);
  expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('private');
  expect(await readdir(outside)).toEqual(['secret.txt']);
  expect((await readdir(root)).sort()).toEqual(['escape.txt', 'linked']);
});

it('never sends environment or key files for TL;DR or translation', async () => {
  const { root, call } = await setup();
  await writeFile(join(root, '.env.local'), 'TOKEN=secret\n');
  const response = await call('files/review', 'POST', { path: '.env.local', mode: 'summary' });
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.error).toMatch(/not sent/);
  expect(JSON.stringify(body)).not.toContain('secret');
});
