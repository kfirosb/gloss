import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../../src/runtime/application.js';
import { startServer } from '../../src/runtime/http-server.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});
async function setup(extra: Partial<Parameters<typeof createApplication>[0]> = {}) {
  const store = new SqliteStore(':memory:');
  const app = createApplication({
    store,
    agents: [new FakeAgent()],
    conversationId: 'A',
    capability: 'cap',
    languageBackends: {
      codex: { open: vi.fn(async () => new FakeLanguageSession()), models: async () => [] },
    },
    ...extra,
  });
  const server = await startServer(app);
  const base = new URL('/api/', server.url);
  const request = (p: string, method = 'GET', body?: unknown, auth = true) =>
    fetch(new URL(p, base), {
      method,
      headers: {
        ...(auth ? { authorization: 'Bearer cap' } : {}),
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'la-folders-')));
  cleanup.push(async () => {
    await server.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { request, dir, store, app };
}
const git = promisify(execFile);
async function gitRepo(dir: string) {
  await git('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  await git('git', ['-C', dir, 'config', 'user.email', 't@t']);
  await git('git', ['-C', dir, 'config', 'user.name', 't']);
  await writeFile(join(dir, 'README'), 'hi');
  await git('git', ['-C', dir, 'add', '.']);
  await git('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
}
it('about reports version without machine details', async () => {
  const { request } = await setup();
  expect((await request('about', 'GET', undefined, false)).status).toBe(401);
  const about = await (await request('about')).json();
  expect(about).toEqual({
    name: 'gloss',
    version: expect.stringMatching(/^\d+\.\d+\.\d+/),
    platform: process.platform,
    arch: process.arch,
  });
});
it('connects, lists and forgets a plain folder; rejects bad paths', async () => {
  const { request, dir } = await setup();
  await writeFile(join(dir, 'a.txt'), 'x');
  expect((await request('folders', 'POST', { path: 'relative' })).status).toBe(400);
  expect((await request('folders', 'POST', { path: join(dir, 'a.txt') })).status).toBe(400);
  const connected = await (await request('folders', 'POST', { path: dir })).json();
  expect(connected).toMatchObject({ path: dir, kind: 'plain', projectKey: dir, missing: false });
  expect((await (await request('folders')).json()).map((f: any) => f.path)).toEqual([dir]);
  expect((await request('folders?path=' + encodeURIComponent(dir), 'DELETE')).status).toBe(200);
  expect(await (await request('folders')).json()).toEqual([]);
});
it('sidebar settings round-trip and validation', async () => {
  const { request } = await setup();
  expect((await request('settings/sidebar', 'PUT', { order: 'no' })).status).toBe(400);
  expect(
    (
      await request('settings/sidebar', 'PUT', {
        order: ['/x/.git'],
        hidden: [],
        collapsed: ['/x/.git'],
        worktreeLocation: {},
      })
    ).status,
  ).toBe(200);
  expect((await (await request('settings/sidebar')).json()).collapsed).toEqual(['/x/.git']);
});
it('about version matches package.json', async () => {
  const { request } = await setup();
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  expect((await (await request('about')).json()).version).toBe(pkg.version);
});
it('folder search needs the capability, rejects an empty query and returns injected hits', async () => {
  const hit = { path: '/Users/x/Projects/app', name: 'app', git: true };
  const folderSearch = vi.fn(async () => ({ hits: [hit], timedOut: false, unavailable: false }));
  const stubbed = await setup({ folderSearch });
  expect((await stubbed.request('folders/search?q=app', 'GET', undefined, false)).status).toBe(401);
  const found = await stubbed.request('folders/search?q=app');
  expect(found.status).toBe(200);
  expect(await found.json()).toEqual({ hits: [hit], timedOut: false, unavailable: false });
  expect(folderSearch).toHaveBeenCalledWith('app');
  const real = await setup();
  expect((await real.request('folders/search?q=')).status).toBe(400);
  expect((await real.request('folders/search')).status).toBe(400);
});

it('lists, creates, inspects, summarizes and deletes worktrees of a connected repository', async () => {
  const endLaunchesInFolder = vi.fn(async () => {});
  const { request, dir, store } = await setup({ endLaunchesInFolder });
  await gitRepo(dir);
  const { projectKey } = await (await request('folders', 'POST', { path: dir })).json();
  expect(projectKey).toBe(join(dir, '.git'));
  const base = 'projects/' + encodeURIComponent(projectKey) + '/';
  for (const [path, method] of [
    ['worktrees', 'GET'],
    ['worktrees', 'POST'],
    ['worktrees/inspect?path=x', 'GET'],
    ['worktrees?path=x', 'DELETE'],
    ['git-init', 'POST'],
    ['worktrees/summary', 'POST'],
  ] as const)
    expect(
      (await request(base + path, method, method === 'POST' ? {} : undefined, false)).status,
    ).toBe(401);
  expect(
    (await request('projects/' + encodeURIComponent('/nowhere/.git') + '/worktrees')).status,
  ).toBe(404);
  const listed = await (await request(base + 'worktrees')).json();
  expect(listed).toMatchObject({
    hasCommits: true,
    worktrees: [{ path: dir, branch: 'main', main: true }],
  });
  expect((await request(base + 'worktrees', 'POST', { name: 'bad name' })).status).toBe(400);
  const created = await request(base + 'worktrees', 'POST', { name: 'f1' });
  expect(created.status).toBe(200);
  const f1 = join(dir, '.worktrees', 'f1');
  expect(await created.json()).toMatchObject({
    path: f1,
    branch: 'f1',
    ignore: { added: true, line: '/.worktrees/' },
  });
  expect((await (await request('folders')).json()).find((f: any) => f.path === f1)).toMatchObject({
    kind: 'worktree',
    projectKey,
    createdByApp: true,
  });
  expect(
    (await (await request(base + 'worktrees')).json()).worktrees.map((w: any) => w.path),
  ).toEqual([dir, f1]);
  await writeFile(join(f1, 'new.txt'), 'n');
  const inspected = await request(base + 'worktrees/inspect?path=' + encodeURIComponent(f1));
  expect(await inspected.json()).toMatchObject({
    path: f1,
    branch: 'f1',
    modified: 0,
    untracked: 1,
    unmergedCommits: 0,
  });
  expect(await (await request(base + 'worktrees/summary', 'POST', { path: f1 })).json()).toEqual({
    text: 'תקציר',
  });
  const mainDelete = await request(base + 'worktrees?path=' + encodeURIComponent(dir), 'DELETE');
  expect(mainDelete.status).toBe(409);
  expect((await mainDelete.json()).code).toBe('worktree-conflict');
  expect(
    (await request(base + 'worktrees?path=' + encodeURIComponent('/tmp'), 'DELETE')).status,
  ).toBe(409);
  store.registerSession({
    id: 'S',
    target: { agent: 'codex', sessionRef: 'S', projectId: f1 },
    canonicalRoot: f1,
    worktreePath: f1,
    projectName: 'p',
    enabled: true,
  });
  expect(
    (await request(base + 'worktrees?path=' + encodeURIComponent(f1) + '&current=S', 'DELETE'))
      .status,
  ).toBe(409);
  expect(existsSync(f1)).toBe(true);
  const removed = await request(
    base + 'worktrees?path=' + encodeURIComponent(f1) + '&removeConversations=true',
    'DELETE',
  );
  expect(removed.status).toBe(200);
  expect(await removed.json()).toMatchObject({
    removed: true,
    conversationsRemoved: 1,
    skipped: 0,
  });
  expect(existsSync(f1)).toBe(false);
  expect(endLaunchesInFolder).toHaveBeenCalledWith(f1);
  expect(store.listSessions().map((r) => r.id)).not.toContain('S');
  expect((await (await request('folders')).json()).map((f: any) => f.path)).toEqual([dir]);
});
it('initializes Git in a connected plain folder', async () => {
  const { request, dir } = await setup();
  await writeFile(join(dir, 'a.txt'), 'a');
  const { projectKey } = await (await request('folders', 'POST', { path: dir })).json();
  const base = 'projects/' + encodeURIComponent(projectKey) + '/';
  expect(await (await request(base + 'worktrees')).json()).toEqual({
    hasCommits: false,
    worktrees: [],
  });
  const init = await request(base + 'git-init', 'POST', {});
  expect(init.status).toBe(200);
  expect(await init.json()).toEqual({ projectKey: join(dir, '.git') });
  expect((await git('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'])).stdout.trim()).toBe(
    'true',
  );
  expect((await (await request('folders')).json())[0]).toMatchObject({
    path: dir,
    kind: 'main',
    projectKey: join(dir, '.git'),
  });
  const again = await request(
    'projects/' + encodeURIComponent(join(dir, '.git')) + '/git-init',
    'POST',
    {},
  );
  expect(again.status).toBe(400);
  expect((await again.json()).error).toMatch(/already uses Git/);
});

it('treats sessions in a subfolder of a worktree as inside it', async () => {
  const endLaunchesInFolder = vi.fn(async () => {});
  const { request, dir, store } = await setup({ endLaunchesInFolder });
  await gitRepo(dir);
  const { projectKey } = await (await request('folders', 'POST', { path: dir })).json();
  const base = 'projects/' + encodeURIComponent(projectKey) + '/';
  const { path: f2 } = await (await request(base + 'worktrees', 'POST', { name: 'f2' })).json();
  const sub = join(f2, 'sub');
  await mkdir(sub);
  store.registerSession({
    id: 'Sub',
    target: { agent: 'codex', sessionRef: 'Sub', projectId: sub },
    canonicalRoot: sub,
    projectName: 'p',
    enabled: true,
  });
  store.registerSession({
    id: 'Elsewhere',
    target: { agent: 'codex', sessionRef: 'E', projectId: dir },
    canonicalRoot: dir,
    projectName: 'p',
    enabled: true,
  });
  const conflict = await request(
    base + 'worktrees?path=' + encodeURIComponent(f2) + '&current=Sub',
    'DELETE',
  );
  expect(conflict.status).toBe(409);
  expect(existsSync(f2)).toBe(true);
  expect(endLaunchesInFolder).not.toHaveBeenCalled();
  const removed = await request(
    base +
      'worktrees?path=' +
      encodeURIComponent(f2) +
      '&removeConversations=true&current=Elsewhere',
    'DELETE',
  );
  expect(await removed.json()).toMatchObject({
    removed: true,
    conversationsRemoved: 1,
    skipped: 0,
  });
  expect(store.listSessions().map((r) => r.id)).toEqual(['Elsewhere']);
});

it('remembers a ~/ worktree location canonically, server-side, and forgets it for the default', async () => {
  const { request, dir } = await setup();
  await gitRepo(dir);
  const home = await mkdtemp(join(tmpdir(), 'la-home-'));
  const previous = process.env.HOME;
  process.env.HOME = home;
  cleanup.push(async () => {
    process.env.HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  const { projectKey } = await (await request('folders', 'POST', { path: dir })).json();
  const base = 'projects/' + encodeURIComponent(projectKey) + '/';
  const locations = async () => (await (await request('settings/sidebar')).json()).worktreeLocation;
  const canonical = join(await realpath(home), 'trees');
  expect(
    await (
      await request(base + 'worktrees', 'POST', { name: 'tilde', location: '~/trees' })
    ).json(),
  ).toMatchObject({ path: join(canonical, 'tilde'), location: canonical });
  expect(await locations()).toEqual({ [projectKey]: canonical });
  // A client's (possibly stale) copy cannot overwrite what the server remembered.
  expect(
    (
      await request('settings/sidebar', 'PUT', {
        order: [],
        hidden: [],
        collapsed: [],
        worktreeLocation: {},
      })
    ).status,
  ).toBe(200);
  expect(await locations()).toEqual({ [projectKey]: canonical });
  expect((await (await request(base + 'worktrees', 'POST', { name: 'again' })).json()).path).toBe(
    join(canonical, 'again'),
  );
  expect(
    (
      await (
        await request(base + 'worktrees', 'POST', {
          name: 'back',
          location: join(dir, '.worktrees'),
        })
      ).json()
    ).path,
  ).toBe(join(dir, '.worktrees', 'back'));
  expect(await locations()).toEqual({});
});

it('inspect counts launched and other open sessions; kept conversations keep the folder as a missing folder', async () => {
  let launches: any[] = [];
  let open: any[] = [];
  const launcher = {
    list: () => launches,
    subscribe: () => () => {},
    launch: vi.fn(),
    reconcile: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
    close: vi.fn(),
  } as any;
  const agent = new FakeAgent();
  (agent as any).discoverOpen = async () => ({ candidates: open, complete: true });
  const { request, dir, store, app } = await setup({ launcher, agents: [agent] });
  await gitRepo(dir);
  const { projectKey } = await (await request('folders', 'POST', { path: dir })).json();
  const base = 'projects/' + encodeURIComponent(projectKey) + '/';
  const { path: f1 } = await (await request(base + 'worktrees', 'POST', { name: 'f1' })).json();
  const sub = join(f1, 'sub');
  await mkdir(sub);
  const launch = (id: string, folder: string, state: string) => ({
    id,
    agent: 'codex',
    folder,
    panePid: 1,
    state,
    createdAt: 1,
  });
  launches = [
    launch('L1', sub, 'running'),
    launch('L2', f1, 'starting'),
    launch('L3', f1, 'ended'),
    launch('L4', dir, 'running'),
  ];
  open = [
    { target: { agent: 'codex', sessionRef: 'native-1', projectId: f1 }, support: 'unsupported' },
    { target: { agent: 'codex', sessionRef: 'native-2', projectId: dir }, support: 'unsupported' },
  ];
  app.catalog!.start();
  await vi.waitFor(() =>
    expect(app.catalog!.snapshot().entries.filter((e) => e.open).length).toBe(3),
  );
  expect(
    await (await request(base + 'worktrees/inspect?path=' + encodeURIComponent(f1))).json(),
  ).toMatchObject({ launchedSessions: 2, otherOpenSessions: 1 });
  launches = [];
  open = [];
  // Keeping conversations keeps the connected row; it lists as missing so its sessions stay reachable.
  store.registerSession({
    id: 'Kept',
    target: { agent: 'codex', sessionRef: 'K', projectId: f1 },
    canonicalRoot: f1,
    worktreePath: f1,
    projectName: 'p',
    enabled: true,
  });
  expect((await request(base + 'worktrees?path=' + encodeURIComponent(f1), 'DELETE')).status).toBe(
    200,
  );
  expect((await (await request('folders')).json()).find((f: any) => f.path === f1)).toMatchObject({
    missing: true,
    projectKey,
  });
  expect(store.listSessions().map((r) => r.id)).toContain('Kept');
  // A worktree made outside the app gets a row only when it has saved conversations to reach.
  const outside = join(dir, '.worktrees', 'outside');
  const empty = join(dir, '.worktrees', 'empty');
  for (const [name, path] of [
    ['outside', outside],
    ['empty', empty],
  ] as const)
    await git('git', ['-C', dir, 'worktree', 'add', '-q', '-b', name, path, 'HEAD']);
  store.registerSession({
    id: 'Out',
    target: { agent: 'codex', sessionRef: 'O', projectId: outside },
    canonicalRoot: outside,
    worktreePath: outside,
    projectName: 'p',
    enabled: true,
  });
  for (const path of [outside, empty])
    expect(
      (await request(base + 'worktrees?path=' + encodeURIComponent(path), 'DELETE')).status,
    ).toBe(200);
  const paths = (await (await request('folders')).json()).map((f: any) => f.path);
  expect(paths).toContain(outside);
  expect(paths).not.toContain(empty);
});

it('names a connected worktree folder after the main checkout', async () => {
  const { request, dir, store } = await setup();
  await gitRepo(dir);
  const { projectKey } = await (await request('folders', 'POST', { path: dir })).json();
  const { path: wt } = await (
    await request('projects/' + encodeURIComponent(projectKey) + '/worktrees', 'POST', {
      name: 'wt',
    })
  ).json();
  const connected = await (await request('folders', 'POST', { path: wt })).json();
  const name = dir.split('/').filter(Boolean).at(-1);
  expect(connected).toMatchObject({ kind: 'worktree', projectName: name });
  const listed = await (await request('folders')).json();
  expect(listed.find((f: any) => f.path === wt)).toMatchObject({ projectName: name });
  // A row whose folder is gone (deleted outside the app) is still named after the main checkout through its stored projectKey.
  const gone = join(dir, '.worktrees', 'gone');
  store.putConnectedFolder({
    path: gone,
    projectKey,
    kind: 'worktree',
    createdByApp: true,
    connectedAt: 1,
  });
  const missing = (await (await request('folders')).json()).find((f: any) => f.path === gone);
  expect(missing).toMatchObject({ projectName: name, missing: true });
});
