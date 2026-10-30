import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPastSessionsService } from '../../src/runtime/past-sessions.js';
import { createApplication } from '../../src/runtime/application.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import type { SessionLauncher } from '../../src/runtime/session-launcher.js';
import type { AgentAdapter } from '../../src/core/contracts.js';
import { FakeAgent } from '../helpers/fake-agent.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function folder() {
  const f = await realpath(await mkdtemp(join(tmpdir(), 'gloss-past-')));
  dirs.push(f);
  return f;
}
const adapter = (kind: 'claude' | 'codex', past: object[], open: string[] = []): AgentAdapter => ({
  kind,
  discover: async () => [],
  attach: async () => {
    throw new Error('unused');
  },
  listPast: async () => past as never,
  discoverOpen: async () => ({
    complete: true,
    candidates: open.map((sessionRef) => ({
      target: { agent: kind, sessionRef, projectId: '/x' },
      support: 'supported',
    })) as never,
  }),
});

it('merges Gloss rows with adapter listings, marks states, hides removed ones and caps at 10', async () => {
  const f = await folder();
  const store = {
    listSessions: () => [
      {
        id: 'P1',
        target: { agent: 'claude', sessionRef: 'c1', projectId: f },
        canonicalRoot: f,
        projectName: 'p',
        enabled: true,
        sessionTitle: 'Gloss title',
      },
    ],
    listHiddenSessions: () => [{ agent: 'codex', sessionRef: 'hidden' }],
  };
  const past = Array.from({ length: 12 }, (_, i) => ({
    agent: 'codex',
    sessionRef: `t${i}`,
    lastActiveAt: 100 + i,
    title: `T${i}`,
  }));
  const service = createPastSessionsService({
    store: store as never,
    agents: [
      adapter('claude', [{ agent: 'claude', sessionRef: 'c1', lastActiveAt: 500 }], ['outside']),
      adapter(
        'codex',
        [
          ...past,
          { agent: 'codex', sessionRef: 'hidden', lastActiveAt: 999 },
          { agent: 'codex', sessionRef: 'outside', lastActiveAt: 998 },
        ],
        ['outside'],
      ),
    ],
    launcher: {
      list: () => [
        {
          id: 'L',
          agent: 'codex',
          sessionRef: 't11',
          state: 'running',
          folder: f,
          panePid: 1,
          createdAt: 0,
        },
      ],
    },
    knownFolder: async () => true,
  });
  const { entries } = await service.list(f);
  expect(entries).toHaveLength(10);
  expect(entries.map((e) => e.sessionRef)).not.toContain('hidden');
  expect(entries.find((e) => e.sessionRef === 'c1')).toMatchObject({
    panelSessionId: 'P1',
    title: 'Gloss title',
    state: 'closed',
  });
  expect(entries.find((e) => e.sessionRef === 't11')?.state).toBe('open-in-gloss');
  expect(entries.find((e) => e.sessionRef === 'outside')?.state).toBe('open-outside');
  service.close();
});
it('refuses an unknown folder and a non-string', async () => {
  const service = createPastSessionsService({
    store: { listSessions: () => [] } as never,
    agents: [],
    knownFolder: async () => false,
  });
  await expect(service.list(await folder())).rejects.toThrow('Choose a project folder');
  await expect(service.list(42)).rejects.toThrow('Choose a project folder');
});
it('reuses a listing for five seconds', async () => {
  const f = await folder();
  const listPast = vi.fn(async () => []);
  let t = 0;
  const service = createPastSessionsService({
    store: { listSessions: () => [] } as never,
    agents: [{ ...adapter('claude', []), listPast }],
    knownFolder: async () => true,
    now: () => t,
  });
  await service.list(f);
  await service.list(f);
  expect(listPast).toHaveBeenCalledTimes(1);
  t = 5001;
  await service.list(f);
  expect(listPast).toHaveBeenCalledTimes(2);
});

it('keys the cache by the real folder and checks a relative path before touching anything', async () => {
  const f = await folder();
  const link = join(await folder(), 'link');
  await symlink(f, link);
  const listPast = vi.fn(async () => []);
  const knownFolder = vi.fn(async () => true);
  const listSessions = vi.fn(() => []);
  const service = createPastSessionsService({
    store: { listSessions } as never,
    agents: [{ ...adapter('claude', []), listPast }],
    knownFolder,
  });
  await expect(service.list('relative/path')).rejects.toThrow('Choose a project folder');
  expect(knownFolder).not.toHaveBeenCalled();
  expect(listSessions).not.toHaveBeenCalled();
  expect((await service.list(link)).folder).toBe(f);
  await service.list(f);
  expect(listPast).toHaveBeenCalledTimes(1);
  expect(listPast).toHaveBeenCalledWith(f);
  expect(knownFolder).toHaveBeenCalledWith(f);
});

it('lists the other sources when an adapter listing or open scan rejects', async () => {
  const f = await folder();
  const log = vi.fn();
  const service = createPastSessionsService({
    store: { listSessions: () => [] } as never,
    agents: [
      { ...adapter('claude', []), listPast: async () => Promise.reject(new Error('disk')) },
      {
        ...adapter('codex', [{ agent: 'codex', sessionRef: 't', lastActiveAt: 1 }]),
        discoverOpen: async () => Promise.reject(new Error('scan')),
      },
    ],
    knownFolder: async () => true,
    log,
  });
  const { entries } = await service.list(f);
  expect(entries).toMatchObject([{ agent: 'codex', sessionRef: 't', state: 'closed' }]);
  expect(log).toHaveBeenCalledTimes(2);
});

it('counts an ended launch only while its pane lives, and a Gloss row takes the agent time', async () => {
  const f = await folder();
  const store = {
    listSessions: () => [
      {
        id: 'P',
        target: { agent: 'claude', sessionRef: 'c', projectId: '/elsewhere' },
        worktreePath: f,
        canonicalRoot: f,
        projectName: 'p',
        enabled: true,
      },
      {
        id: 'Q',
        target: { agent: 'claude', sessionRef: 'other-folder', projectId: '/elsewhere' },
        canonicalRoot: '/elsewhere',
        projectName: 'p',
        enabled: true,
      },
    ],
  };
  const launches = [
    {
      id: 'L1',
      agent: 'claude',
      panelSessionId: 'P',
      state: 'ended',
      folder: f,
      panePid: 1,
      createdAt: 0,
    },
    {
      id: 'L2',
      agent: 'claude',
      sessionRef: 'd',
      state: 'ended',
      folder: f,
      panePid: 1,
      createdAt: 0,
    },
  ];
  const service = createPastSessionsService({
    store: store as never,
    agents: [
      adapter('claude', [
        { agent: 'claude', sessionRef: 'c', lastActiveAt: 2000 },
        { agent: 'claude', sessionRef: 'd', lastActiveAt: 1000 },
      ]),
    ],
    launcher: { list: () => launches as never },
    knownFolder: async () => true,
    paneAlive: async (id) => id === 'L1',
  });
  const { entries } = await service.list(f);
  expect(entries).toMatchObject([
    {
      sessionRef: 'c',
      panelSessionId: 'P',
      state: 'open-in-gloss',
      lastActiveAt: new Date(2000).toISOString(),
    },
    { sessionRef: 'd', state: 'closed' },
  ]);
});

it('lists a Gloss row with no agent counterpart without a time, after dated entries', async () => {
  const f = await folder();
  const store = {
    listSessions: () => [
      {
        id: 'P',
        target: { agent: 'claude', sessionRef: 'gone', projectId: f },
        canonicalRoot: f,
        projectName: 'p',
        enabled: true,
      },
    ],
  };
  const service = createPastSessionsService({
    store: store as never,
    agents: [adapter('codex', [{ agent: 'codex', sessionRef: 't', lastActiveAt: 1 }])],
    knownFolder: async () => true,
  });
  const { entries } = await service.list(f);
  expect(entries.map((e) => e.sessionRef)).toEqual(['t', 'gone']);
  expect(entries[1]).toMatchObject({ panelSessionId: 'P', title: 'Claude Code' });
  expect(entries[1]).not.toHaveProperty('lastActiveAt');
});

function application(launcher?: Partial<SessionLauncher>) {
  const store = new SqliteStore(':memory:');
  const app = createApplication({
    store,
    agents: [new FakeAgent()],
    conversationId: 'A',
    languageBackends: {},
    ...(launcher ? { launcher: launcher as SessionLauncher } : {}),
  });
  return { store, app };
}

it('reopens with only the agent, session and folder', async () => {
  const prepared = { token: 1 };
  const prepareResume = vi.fn(async () => prepared as never);
  const resume = vi.fn(async () => ({ id: 'L' }) as never);
  const { app } = application({ prepareResume, resume, list: () => [], close() {} });
  await expect(
    app.reopenSession!({ agent: 'codex', sessionRef: 't', folder: '/f', extra: 'x' }),
  ).resolves.toEqual({ id: 'L' });
  expect(prepareResume).toHaveBeenCalledWith({ agent: 'codex', sessionRef: 't', folder: '/f' });
  expect(resume).toHaveBeenCalledWith(prepared);
  await expect(
    app.reopenSession!({ agent: 'shell', sessionRef: 't', folder: '/f' }),
  ).rejects.toThrow('Invalid agent');
  await expect(
    app.reopenSession!({ agent: 'codex', sessionRef: 1, folder: '/f' }),
  ).rejects.toThrow();
  await app.close();
  const bare = application();
  await expect(
    bare.app.reopenSession!({ agent: 'codex', sessionRef: 't', folder: '/f' }),
  ).rejects.toThrow('Session launching unavailable');
  await bare.app.close();
});

it('hides a conversation without a panel and refuses one that has a panel', async () => {
  const { app, store } = application();
  await app.sessions!.register({ agent: 'codex', sessionRef: 'P', projectId: process.cwd() }, 'P');
  expect(() => app.hidePastSession!({ agent: 'codex', sessionRef: 'P' })).toThrow(
    expect.objectContaining({ code: 'session-open' }),
  );
  expect(() => app.hidePastSession!({ agent: 'codex', sessionRef: '' })).toThrow('Invalid session');
  expect(() => app.hidePastSession!({ agent: 'shell', sessionRef: 'x' })).toThrow('Invalid agent');
  app.hidePastSession!({ agent: 'claude', sessionRef: 'P' });
  app.hidePastSession!({ agent: 'codex', sessionRef: 'gone' });
  expect(store.listHiddenSessions()).toEqual(
    expect.arrayContaining([
      { agent: 'claude', sessionRef: 'P' },
      { agent: 'codex', sessionRef: 'gone' },
    ]),
  );
  expect(store.listHiddenSessions()).toHaveLength(2);
  await app.close();
});

it('reports a conversation an agent has open outside Gloss from a fresh scan', async () => {
  const discoverOpen = vi.fn(async (_signal: AbortSignal, _options?: { fresh?: boolean }) => ({
    complete: true,
    candidates: [
      { target: { agent: 'codex', sessionRef: 'live', projectId: '/x' }, support: 'supported' },
    ] as never,
  }));
  const service = createPastSessionsService({
    store: { listSessions: () => [] } as never,
    agents: [adapter('claude', [], ['live']), { ...adapter('codex', []), discoverOpen }],
    knownFolder: async () => true,
  });
  await expect(service.openOutside('codex', 'live')).resolves.toBe(true);
  expect(discoverOpen).toHaveBeenCalledWith(expect.any(AbortSignal), { fresh: true });
  await expect(service.openOutside('codex', 'other')).resolves.toBe(false);
  await expect(
    createPastSessionsService({
      store: { listSessions: () => [] } as never,
      agents: [
        { ...adapter('claude', []), discoverOpen: async () => Promise.reject(new Error('x')) },
      ],
      knownFolder: async () => true,
      log: () => {},
    }).openOutside('claude', 'live'),
  ).resolves.toBe(false);
  service.close();
});

it('refuses to reopen a conversation open outside Gloss, before anything starts', async () => {
  const prepareResume = vi.fn(async () => ({}) as never);
  const resume = vi.fn(async () => ({ id: 'L' }) as never);
  const store = new SqliteStore(':memory:');
  const openOutside = vi.fn(async () => true);
  const app = createApplication({
    store,
    agents: [new FakeAgent()],
    conversationId: 'A',
    languageBackends: {},
    launcher: { prepareResume, resume, list: () => [], close() {} } as never,
    pastSessions: { list: vi.fn(), invalidate: vi.fn(), close: vi.fn(), openOutside } as never,
  });
  await expect(
    app.reopenSession!({ agent: 'claude', sessionRef: 'c', folder: '/f' }),
  ).rejects.toThrow(
    expect.objectContaining({
      code: 'session-open',
      message: 'Claude is running this session in another terminal; use Move to Gloss instead.',
    }),
  );
  await expect(
    app.reopenSession!({ agent: 'codex', sessionRef: 't', folder: '/f' }),
  ).rejects.toThrow('Codex is running this thread in another terminal; close it there first.');
  expect(openOutside).toHaveBeenCalledWith('codex', 't');
  expect(resume).not.toHaveBeenCalled();
  await app.close();
});
