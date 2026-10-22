import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  descendsFrom,
  cachedTmux,
  claimedCodexRefs,
  claudeLaunchFor,
  launchedCodexLiveness,
  createLaunchApplyLanguage,
  createLaunchServices,
  knownFolder,
  matchCodexByFolderTime,
  parseVersion,
} from '../../src/runtime/launch-services.js';
import type { LaunchRecord } from '../../src/runtime/session-launcher.js';
import type { OpenSessionCandidate } from '../../src/core/session-catalog.js';
import type { ProcessRunner } from '../../src/runtime/process-runner.js';

const ps = (parents: Record<number, number>, calls: string[][] = []): ProcessRunner =>
  async function* (exe, args) {
    calls.push([exe, ...args]);
    const pid = Number(args.at(-1));
    const parent = parents[pid];
    if (parent !== undefined) yield { type: 'line', line: ' ' + parent };
    yield {
      type: 'exit',
      outcome: {
        code: parent === undefined ? 1 : 0,
        signal: null,
        reason: 'exited',
        diagnostics: '',
      },
    };
  };
it('walks ps ancestry shell-free and bounds depth', async () => {
  const calls: string[][] = [];
  expect(
    await descendsFrom(40, 10, ps({ 40: 30, 30: 20, 20: 10 }, calls), new AbortController().signal),
  ).toBe(true);
  expect(calls[0]).toEqual(['/bin/ps', '-o', 'ppid=', '-p', '40']);
  expect(
    await descendsFrom(40, 99, ps({ 40: 30, 30: 1, 1: 0 }), new AbortController().signal),
  ).toBe(false);
  expect(await descendsFrom(40, 99, ps({ 40: 40 }), new AbortController().signal)).toBe(false);
  const chain = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i + 100, i + 101]));
  const deep: string[][] = [];
  expect(await descendsFrom(100, 139, ps(chain, deep), new AbortController().signal)).toBe(false);
  expect(deep.length).toBeLessThanOrEqual(16);
  expect(await descendsFrom(100, 100, ps({}), new AbortController().signal)).toBe(true);
});
it('caches tmux and retries after a failure', async () => {
  const create = vi
    .fn()
    .mockRejectedValueOnce(new Error('no tmux'))
    .mockResolvedValue({ id: 'tmux' });
  const get = cachedTmux(create as any);
  await expect(get()).rejects.toThrow('no tmux');
  expect(await get()).toEqual({ id: 'tmux' });
  expect(await get()).toEqual({ id: 'tmux' });
  expect(create).toHaveBeenCalledTimes(2);
});
it('applies a launch language override through the store, then refreshes', async () => {
  const order: string[] = [];
  const apply = createLaunchApplyLanguage(
    {
      writeLanguageOverride: (id: string, o: unknown) =>
        order.push('write ' + id + JSON.stringify(o)),
    },
    { refreshLanguageSettings: (id?: string) => order.push('sessions ' + id) },
    { refresh: () => order.push('catalog') },
  );
  await apply('P1', { reply: 'en' });
  expect(order).toEqual(['write P1{"reply":"en"}', 'sessions P1', 'catalog']);
});
it('extracts the first semantic version', () => {
  expect(parseVersion('2.1.4 (Claude Code)')).toBe('2.1.4');
  expect(parseVersion('codex-cli 0.154.0\n')).toBe('0.154.0');
  expect(parseVersion('nope')).toBeUndefined();
});
it('accepts folders of registered or discovered sessions, compared by real path', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gloss-known-')));
  try {
    const real = join(root, 'project');
    await mkdir(real);
    const link = join(root, 'link');
    await symlink(real, link);
    expect(await knownFolder(real, [undefined, link])).toBe(true);
    expect(await knownFolder(real, [real])).toBe(true);
    expect(await knownFolder(real, [join(root, 'missing'), 'relative'])).toBe(false);
    // Wired through the launcher: a folder known only from the session catalog launches.
    const live = new Map<string, number>();
    const tmux = {
      executable: '/t',
      socket: '/s',
      async newSession(name: string) {
        live.set(name, 77);
        return { panePid: 77 };
      },
      async listSessions() {
        return [...live].map(([name, panePid]) => ({ name, panePid }));
      },
      async hasSession() {
        return false;
      },
      async capturePane() {
        return '';
      },
      async sendKeys() {},
      async resizeWindow() {},
      async killSession() {},
      attachArgv: () => [],
    };
    const launches: any[] = [];
    let entries: any[] = [];
    const services = createLaunchServices({
      store: {
        listSessions: () => [],
        listLaunches: () => launches,
        putLaunch: (r: any) => {
          const i = launches.findIndex((l) => l.id === r.id);
          if (i >= 0) launches[i] = r;
          else launches.push(r);
        },
        readLaunchSettings: () => ({
          extraArgs: { claude: [], codex: [] },
          popup: 'auto',
          terminalView: 'popup',
        }),
        writeLaunchSettings() {},
        deleteLaunch() {},
      } as any,
      codex: { discoverOpen: async () => ({ candidates: [], complete: true }) } as any,
      application: () => ({ catalog: { refresh() {}, snapshot: () => ({ entries }) } }),
      tmux: async () => tmux as any,
    });
    await expect(services.launcher.launch({ agent: 'codex', folder: real })).rejects.toThrow(
      'Choose a project folder',
    );
    entries = [
      { target: { agent: 'codex', sessionRef: 'x', projectId: '/elsewhere' }, worktreePath: link },
    ];
    // Past folder validation (the result then depends only on whether codex is installed here).
    expect(
      await services.launcher.launch({ agent: 'codex', folder: real }).then(
        (r) => r.folder,
        (e: Error) => e.message,
      ),
    ).toMatch(new RegExp(`^(?:${real}|codex executable unavailable)$`));
    services.launcher.close();
    services.attention.close();
    services.terminals.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const launchAt = (
  id: string,
  createdAt: number,
  extra: Partial<LaunchRecord> = {},
): LaunchRecord => ({
  id,
  agent: 'codex',
  folder: '/p',
  panePid: 10,
  state: 'starting',
  createdAt,
  ...extra,
});
const thread = (
  ref: string,
  createdAt: number | undefined,
  extra: Partial<OpenSessionCandidate> = {},
): OpenSessionCandidate => ({
  target: { agent: 'codex', sessionRef: ref, projectId: '/p' },
  support: 'supported',
  nativePid: 4352,
  ...(createdAt === undefined ? {} : { createdAt }),
  ...extra,
});
it('matches a launch to the earliest open thread created in its folder at or after it', () => {
  const l = launchAt('L', 10_000);
  expect(
    matchCodexByFolderTime(l, [thread('late', 30_000), thread('first', 12_000)], [l], new Set())
      ?.sessionRef,
  ).toBe('first');
  // Small clock skew is tolerated; an older thread is not the launch's.
  expect(matchCodexByFolderTime(l, [thread('skew', 8_500)], [l], new Set())?.sessionRef).toBe(
    'skew',
  );
  expect(matchCodexByFolderTime(l, [thread('before', 7_000)], [l], new Set())).toBeUndefined();
  // Other folders, unknown creation times, unsupported or already owned threads never match.
  expect(
    matchCodexByFolderTime(
      l,
      [
        thread('other', 12_000, {
          target: { agent: 'codex', sessionRef: 'other', projectId: '/q' },
        }),
        thread('unknown', undefined),
        thread('old', 12_000, { support: 'unsupported' }),
        thread('owned', 12_000),
      ],
      [l],
      new Set(['owned']),
    ),
  ).toBeUndefined();
});
it('assigns threads to launches waiting in the same folder in launch order', () => {
  const first = launchAt('B-first', 10_000);
  const second = launchAt('A-second', 11_000);
  const threads = [thread('t2', 13_000), thread('t1', 12_000)];
  const launches = [second, first];
  expect(matchCodexByFolderTime(first, threads, launches, new Set())?.sessionRef).toBe('t1');
  expect(matchCodexByFolderTime(second, threads, launches, new Set())?.sessionRef).toBe('t2');
  // Only one thread so far: it goes to the earlier launch, the later one keeps waiting.
  expect(
    matchCodexByFolderTime(second, [thread('t1', 12_000)], launches, new Set()),
  ).toBeUndefined();
  // A launch that already has its session, or ended, or is elsewhere, does not take a turn.
  expect(
    matchCodexByFolderTime(
      second,
      [thread('t1', 12_000)],
      [second, { ...first, sessionRef: 'x' }],
      new Set(),
    )?.sessionRef,
  ).toBe('t1');
  expect(
    matchCodexByFolderTime(
      second,
      [thread('t1', 12_000)],
      [second, { ...first, state: 'ended' }],
      new Set(),
    )?.sessionRef,
  ).toBe('t1');
  expect(
    matchCodexByFolderTime(
      second,
      [thread('t1', 12_000)],
      [second, { ...first, folder: '/q' }],
      new Set(),
    )?.sessionRef,
  ).toBe('t1');
});
it('treats threads held by other launches or their panels as owned', () => {
  const me = launchAt('me', 0);
  const claimed = claimedCodexRefs(
    me,
    [
      me,
      launchAt('a', 0, { sessionRef: 'ref-a' }),
      launchAt('b', 0, { panelSessionId: 'P' }),
      launchAt('c', 0, { agent: 'claude', sessionRef: 'claude-ref' }),
    ],
    [
      { id: 'P', target: { agent: 'codex', sessionRef: 'ref-b', projectId: '/p' } },
      { id: 'Q', target: { agent: 'codex', sessionRef: 'unowned', projectId: '/p' } },
    ],
  );
  expect([...claimed].sort()).toEqual(['ref-a', 'ref-b']);
});
describe('identifies a Codex launch whose writer is the shared app-server daemon', () => {
  async function services(
    candidates: OpenSessionCandidate[],
    launches: LaunchRecord[],
    sessions: any[] = [],
  ) {
    const tmux = {
      executable: '/t',
      socket: '/s',
      async listSessions() {
        return launches.map((l) => ({ name: 'gloss-' + l.id, panePid: l.panePid }));
      },
      async hasSession() {
        return true;
      },
      async capturePane() {
        return '';
      },
      async sendKeys() {},
      async resizeWindow() {},
      async killSession() {},
      async newSession() {
        throw new Error('never launches');
      },
      attachArgv: () => [],
    };
    const register = vi.fn(async (target: any) => ({ id: 'panel-' + target.sessionRef, target }));
    const calls: string[][] = [];
    const discoverOpen = vi.fn(async () => ({ candidates, complete: true }));
    const result = createLaunchServices({
      store: {
        listSessions: () => sessions,
        listLaunches: () => structuredClone(launches),
        putLaunch: (r: any) => {
          const i = launches.findIndex((l) => l.id === r.id);
          if (i >= 0) launches[i] = r;
          else launches.push(r);
        },
        readLaunchSettings: () => ({
          extraArgs: { claude: [], codex: [] },
          popup: 'auto',
          terminalView: 'popup',
        }),
        writeLaunchSettings() {},
        deleteLaunch() {},
      } as any,
      codex: { discoverOpen } as any,
      application: () => ({ sessions: { register } as any }),
      tmux: async () => tmux as any,
      // The daemon (4352) is a child of launchd, never of a launch pane.
      runner: ps({ 4352: 1, 78: 77 }, calls),
    });
    return {
      ...result,
      register,
      calls,
      discoverOpen,
      close() {
        result.launcher.close();
        result.attention.close();
        result.terminals.close();
      },
    };
  }
  it('falls back to folder and time when ancestry does not match', async () => {
    const launches = [
      launchAt('L', 10_000, { state: 'unidentified', reason: 'Started, not connected' }),
    ];
    const s = await services([thread('older', 5_000), thread('mine', 11_000)], launches);
    try {
      await s.launcher.identify('L');
      expect(launches[0]).toMatchObject({
        state: 'running',
        sessionRef: 'mine',
        panelSessionId: 'panel-mine',
      });
      expect(s.register).toHaveBeenCalledWith(
        { agent: 'codex', sessionRef: 'mine', projectId: '/p' },
        undefined,
        expect.anything(),
      );
      // Ancestry was tried first, but not for the thread created before the launch.
      expect(s.calls.length).toBeGreaterThan(0);
    } finally {
      s.close();
    }
  });
  it('identifies a launch from a fresh discovery, not a cached one', async () => {
    const launches = [launchAt('L', 10_000)];
    const s = await services([thread('mine', 11_000)], launches);
    try {
      await s.launcher.identify('L');
      expect(s.discoverOpen).toHaveBeenCalledWith(expect.anything(), { fresh: true });
    } finally {
      s.close();
    }
  });
  it('does not claim a thread created before the launch', async () => {
    const launches = [launchAt('L', 10_000)];
    const s = await services([thread('older', 5_000)], launches);
    try {
      // The first attempt finds nothing; the launch then waits on its backoff with no session.
      void s.launcher.identify('L');
      await vi.waitFor(() => expect(s.discoverOpen).toHaveBeenCalled());
      expect(s.calls).toEqual([]);
      await new Promise((r) => setTimeout(r, 20));
      expect(launches[0]!.sessionRef).toBeUndefined();
      expect(launches[0]!.panelSessionId).toBeUndefined();
      expect(s.register).not.toHaveBeenCalled();
    } finally {
      s.close();
    }
  });
  it("skips a thread already owned by another launch's panel", async () => {
    const launches = [
      launchAt('other', 9_000, { state: 'running', panelSessionId: 'P' }),
      launchAt('L', 10_000),
    ];
    const s = await services([thread('taken', 11_000), thread('free', 12_000)], launches, [
      { id: 'P', target: { agent: 'codex', sessionRef: 'taken', projectId: '/p' } },
    ]);
    try {
      await s.launcher.identify('L');
      expect(launches[1]).toMatchObject({ state: 'running', sessionRef: 'free' });
    } finally {
      s.close();
    }
  });
  it('prefers an exact ancestry match over folder and time', async () => {
    const launches = [launchAt('L', 10_000, { panePid: 77 })];
    const s = await services(
      [thread('daemon', 11_000), thread('own', 20_000, { nativePid: 78 })],
      launches,
    );
    try {
      await s.launcher.identify('L');
      expect(launches[0]).toMatchObject({ state: 'running', sessionRef: 'own' });
    } finally {
      s.close();
    }
  });
});

describe('liveness of Codex threads Gloss launched', () => {
  const launch = (over: Partial<LaunchRecord>): LaunchRecord => ({
    id: 'L',
    agent: 'codex',
    folder: '/p',
    panePid: 7,
    state: 'running',
    createdAt: 1,
    ...over,
  });
  it('is open while the launch runs, closed once it ended, and unknown for threads it never launched', () => {
    expect(launchedCodexLiveness('t1', [launch({ sessionRef: 't1' })], [])).toBe(true);
    expect(launchedCodexLiveness('t1', [launch({ sessionRef: 't1', state: 'ended' })], [])).toBe(
      false,
    );
    expect(
      launchedCodexLiveness(
        't1',
        [launch({ panelSessionId: 'P', state: 'ended' })],
        [{ id: 'P', target: { agent: 'codex', sessionRef: 't1', projectId: '/p' } }],
      ),
    ).toBe(false);
    expect(launchedCodexLiveness('other', [launch({ sessionRef: 't1' })], [])).toBeUndefined();
  });
  it('closes a launched thread once its tmux session is gone', async () => {
    const launches = [launch({ sessionRef: 't1', panelSessionId: 'P' })];
    let alive = true;
    const tmux = {
      executable: '/t',
      socket: '/s',
      async listSessions() {
        return alive ? [{ name: 'gloss-L', panePid: 7 }] : [];
      },
      async hasSession() {
        return alive;
      },
      async capturePane() {
        return '';
      },
      async sendKeys() {},
      async resizeWindow() {},
      async killSession() {},
      async newSession() {
        throw new Error('never launches');
      },
      attachArgv: () => [],
    };
    const services = createLaunchServices({
      store: {
        listSessions: () => [
          { id: 'P', target: { agent: 'codex', sessionRef: 't1', projectId: '/p' } },
        ],
        listLaunches: () => structuredClone(launches),
        putLaunch: (r: LaunchRecord) => {
          launches[0] = r;
        },
        readLaunchSettings: () => ({
          extraArgs: { claude: [], codex: [] },
          popup: 'auto',
          terminalView: 'popup',
        }),
        writeLaunchSettings() {},
        deleteLaunch() {},
      } as any,
      codex: { discoverOpen: async () => ({ candidates: [], complete: true }) } as any,
      application: () => ({}),
      tmux: async () => tmux as any,
      runner: ps({}),
    });
    try {
      await services.launcher.reconcile();
      expect(services.launchedCodexLive('t1')).toBe(true);
      alive = false;
      await services.launcher.reconcile();
      expect(launches[0]!.state).toBe('ended');
      expect(services.launchedCodexLive('t1')).toBe(false);
    } finally {
      services.launcher.close();
      services.attention.close();
      services.terminals.close();
    }
  });
});

it('ends only the live launches in a folder', async () => {
  const launches: LaunchRecord[] = [
    { id: 'A', agent: 'codex', folder: '/w', panePid: 1, state: 'running', createdAt: 1 },
    { id: 'B', agent: 'claude', folder: '/w', panePid: 2, state: 'ended', createdAt: 2 },
    { id: 'C', agent: 'codex', folder: '/x', panePid: 3, state: 'running', createdAt: 3 },
    { id: 'D', agent: 'claude', folder: '/w/sub', panePid: 4, state: 'running', createdAt: 4 },
    { id: 'E', agent: 'codex', folder: '/wx', panePid: 5, state: 'running', createdAt: 5 },
  ];
  const sent: string[] = [];
  const alive = new Set(['gloss-A', 'gloss-C', 'gloss-D', 'gloss-E']);
  const tmux = {
    executable: '/t',
    socket: '/s',
    async listSessions() {
      return [...alive].map((name) => ({ name, panePid: 1 }));
    },
    async hasSession(name: string) {
      return alive.has(name);
    },
    async capturePane() {
      return '';
    },
    async sendKeys(name: string) {
      sent.push(name);
      alive.delete(name);
    },
    async resizeWindow() {},
    async killSession(name: string) {
      alive.delete(name);
    },
    async newSession() {
      throw new Error('never launches');
    },
    attachArgv: () => [],
  };
  const services = createLaunchServices({
    store: {
      listSessions: () => [],
      listLaunches: () => structuredClone(launches),
      putLaunch: (r: LaunchRecord) => {
        launches[launches.findIndex((l) => l.id === r.id)] = r;
      },
      readLaunchSettings: () => ({
        extraArgs: { claude: [], codex: [] },
        popup: 'auto',
        terminalView: 'popup',
      }),
      writeLaunchSettings() {},
      deleteLaunch() {},
    } as any,
    codex: { discoverOpen: async () => ({ candidates: [], complete: true }) } as any,
    application: () => ({}),
    tmux: async () => tmux as any,
    runner: ps({}),
  });
  try {
    await services.endLaunchesInFolder('/w');
    expect(launches.map((l) => [l.id, l.state])).toEqual([
      ['A', 'ended'],
      ['B', 'ended'],
      ['C', 'running'],
      ['D', 'ended'],
      ['E', 'running'],
    ]);
    expect(alive).toEqual(new Set(['gloss-C', 'gloss-E']));
  } finally {
    services.launcher.close();
    services.attention.close();
    services.terminals.close();
  }
});

it('finds the one live Claude launch of a session, directly or through its panel', () => {
  const launch = (id: string, extra: Partial<LaunchRecord>): LaunchRecord => ({
    id,
    agent: 'claude',
    folder: '/f',
    panePid: 10,
    state: 'running',
    createdAt: 1,
    ...extra,
  });
  const sessions = [
    { id: 'panel-b', target: { agent: 'claude' as const, sessionRef: 'ref-b', projectId: '/f' } },
  ];
  expect(claudeLaunchFor('ref-a', [launch('a', { sessionRef: 'ref-a' })], [])?.id).toBe('a');
  expect(claudeLaunchFor('ref-b', [launch('b', { panelSessionId: 'panel-b' })], sessions)?.id).toBe(
    'b',
  );
  expect(
    claudeLaunchFor('ref-a', [launch('a', { sessionRef: 'ref-a', state: 'ended' })], []),
  ).toBeUndefined();
  expect(
    claudeLaunchFor(
      'ref-a',
      [launch('a', { sessionRef: 'ref-a' }), launch('c', { sessionRef: 'ref-a' })],
      [],
    ),
  ).toBeUndefined();
  expect(
    claudeLaunchFor('ref-a', [launch('a', { sessionRef: 'ref-a', agent: 'codex' })], []),
  ).toBeUndefined();
});

it('reaches a launch that still runs under its pre-rename tmux name', async () => {
  const REF_E = '0b6a8f6e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
  const launches: LaunchRecord[] = [
    {
      id: 'A',
      agent: 'claude',
      folder: '/f',
      panePid: 1,
      state: 'running',
      createdAt: 1,
      sessionRef: 'ref-a',
    },
    {
      id: 'E',
      agent: 'claude',
      folder: '/f',
      panePid: 2,
      state: 'ended',
      createdAt: 2,
      sessionRef: REF_E,
    },
  ];
  const alive = new Set(['la-A', 'la-E']);
  const has: string[] = [];
  const styled: string[] = [];
  const tmux = {
    executable: '/t',
    socket: '/s',
    async listSessions() {
      return [...alive].map((name) => ({ name, panePid: 1 }));
    },
    async hasSession(name: string) {
      has.push(name);
      return alive.has(name);
    },
    async capturePane() {
      return '';
    },
    async capturePaneStyled(name: string) {
      styled.push(name);
      return '';
    },
    async sendKeys() {},
    async resizeWindow() {},
    async killSession() {},
    async newSession() {
      throw new Error('never launches');
    },
    attachArgv: () => [],
  };
  const services = createLaunchServices({
    store: {
      listSessions: () => [],
      listLaunches: () => structuredClone(launches),
      putLaunch() {},
      readLaunchSettings: () => ({
        extraArgs: { claude: [], codex: [] },
        popup: 'auto',
        terminalView: 'popup',
      }),
      writeLaunchSettings() {},
      deleteLaunch() {},
    } as any,
    codex: { discoverOpen: async () => ({ candidates: [], complete: true }) } as any,
    application: () => ({}),
    tmux: async () => tmux as any,
    runner: ps({}),
  });
  try {
    const terminal = await services.glossTerminal('ref-a');
    expect(has).toEqual(['gloss-A', 'la-A']);
    await terminal!.capture();
    expect(styled).toEqual(['la-A']);
    alive.delete('la-A');
    has.length = 0;
    expect(await services.glossTerminal('ref-a')).toBeUndefined();
    expect(has).toEqual(['gloss-A', 'la-A']);
    // The ended launch's pane still runs as la-E, so the session is in Gloss (paneAlive).
    has.length = 0;
    expect(
      await services.claudeMove.status({ agent: 'claude', sessionRef: REF_E, projectId: '/f' }),
    ).toEqual({ state: 'in-gloss' });
    expect(has).toEqual(['gloss-E', 'la-E']);
  } finally {
    services.launcher.close();
    services.attention.close();
    services.terminals.close();
    services.claudeMove.close();
  }
});
