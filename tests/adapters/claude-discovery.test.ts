import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverOpenClaude } from '../../src/agents/claude/index.js';
import type { ProcessRunner } from '../../src/runtime/process-runner.js';
import { createClaudeLiveness } from '../../src/agents/claude/liveness.js';
import { lsofPaths, lsofRunner, ownerLines, type LsofOwner } from './lsof-fixture.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const exit = {
  type: 'exit' as const,
  outcome: { code: 0, signal: null, reason: 'exited' as const, diagnostics: '' },
};
const s102 = { '/tmp/s102.sock': [{ pid: 102, command: 'claude' }] };
const ids = {
  worker: '00000000-0000-4000-8000-000000000001',
  current: '00000000-0000-4000-8000-000000000002',
  older: '00000000-0000-4000-8000-000000000003',
  socketless: '00000000-0000-4000-8000-000000000004',
  closed: '00000000-0000-4000-8000-000000000005',
  npm: '00000000-0000-4000-8000-000000000006',
};

it.runIf(process.platform === 'darwin').each([
  { label: 'missing', metadata: {}, accepted: true },
  { label: 'CLI', metadata: { entrypoint: 'cli' }, accepted: true },
  { label: 'SDK', metadata: { entrypoint: 'sdk-cli' }, accepted: false },
  { label: 'null', metadata: { entrypoint: null }, accepted: false },
  { label: 'number', metadata: { entrypoint: 42 }, accepted: false },
  { label: 'boolean', metadata: { entrypoint: false }, accepted: false },
  { label: 'object', metadata: { entrypoint: { kind: 'cli' } }, accepted: false },
  { label: 'array', metadata: { entrypoint: ['cli'] }, accepted: false },
])('filters $label entrypoint metadata', async ({ metadata, accepted }) => {
  const config = await realpath(await mkdtemp(join(tmpdir(), 'claude-entrypoint-')));
  roots.push(config);
  await mkdir(join(config, 'sessions'));
  await writeFile(
    join(config, 'sessions', '102.json'),
    JSON.stringify({
      pid: 102,
      sessionId: ids.current,
      cwd: config,
      version: '2.1.284',
      messagingSocketPath: '/tmp/s102.sock',
      ...metadata,
    }),
  );
  const runner: ProcessRunner = async function* (executable, args) {
    if (executable === '/usr/sbin/lsof')
      for (const line of ownerLines(s102, lsofPaths(args))) yield { type: 'line', line };
    yield exit;
  };
  const scan = await discoverOpenClaude(
    { configDir: config, runner },
    new AbortController().signal,
  );
  expect(scan.complete).toBe(true);
  expect(scan.candidates.map(({ target }) => target.sessionRef)).toEqual(
    accepted ? [ids.current] : [],
  );
});

it.runIf(process.platform === 'darwin').each([
  { label: 'missing', metadata: {}, accepted: true },
  { label: 'empty', metadata: { messagingSocketPath: '' }, accepted: true },
  { label: 'owned socket', metadata: { messagingSocketPath: '/tmp/s102.sock' }, accepted: true },
  {
    label: 'unowned socket',
    metadata: { messagingSocketPath: '/tmp/unowned.sock' },
    accepted: false,
  },
  { label: 'null', metadata: { messagingSocketPath: null }, accepted: false },
  { label: 'number', metadata: { messagingSocketPath: 42 }, accepted: false },
  { label: 'boolean', metadata: { messagingSocketPath: false }, accepted: false },
  {
    label: 'object',
    metadata: { messagingSocketPath: { path: '/tmp/s102.sock' } },
    accepted: false,
  },
  { label: 'array', metadata: { messagingSocketPath: ['/tmp/s102.sock'] }, accepted: false },
])(
  'filters $label socket metadata even with a live Claude process',
  async ({ metadata, accepted }) => {
    const config = await realpath(await mkdtemp(join(tmpdir(), 'claude-socket-')));
    roots.push(config);
    await mkdir(join(config, 'sessions'));
    await writeFile(
      join(config, 'sessions', '102.json'),
      JSON.stringify({
        pid: 102,
        sessionId: ids.current,
        cwd: config,
        version: '2.1.284',
        entrypoint: 'cli',
        ...metadata,
      }),
    );
    const runner: ProcessRunner = async function* (executable, args) {
      if (executable === '/usr/sbin/lsof')
        for (const line of ownerLines(s102, lsofPaths(args))) yield { type: 'line', line };
      // A malformed path must be rejected even when the legacy process check would pass.
      if (executable === '/bin/ps' && args.at(-1) === '102')
        yield { type: 'line', line: '/usr/local/bin/claude' };
      yield exit;
    };
    const scan = await discoverOpenClaude(
      { configDir: config, runner },
      new AbortController().signal,
    );
    expect(scan.complete).toBe(true);
    expect(scan.candidates.map(({ target }) => target.sessionRef)).toEqual(
      accepted ? [ids.current] : [],
    );
  },
);

it.runIf(process.platform === 'darwin')(
  'lists every live interactive Claude terminal with its status and skips language workers',
  async () => {
    const config = await mkdtemp(join(tmpdir(), 'claude-discovery-'));
    roots.push(config);
    const project = await realpath(await mkdtemp(join(tmpdir(), 'claude-project-')));
    roots.push(project);
    await mkdir(join(config, 'sessions'));
    const record = (pid: number, sessionId: string, version: string, extra: object) =>
      writeFile(
        join(config, 'sessions', `${pid}.json`),
        JSON.stringify({
          pid,
          sessionId,
          cwd: project,
          version,
          kind: 'interactive',
          entrypoint: 'cli',
          peerProtocol: 1,
          ...extra,
        }),
      );
    await record(101, ids.worker, '2.1.284', {
      entrypoint: 'sdk-cli',
      messagingSocketPath: '/tmp/s101.sock',
      status: 'busy',
    });
    await record(102, ids.current, '2.1.284', {
      messagingSocketPath: '/tmp/s102.sock',
      status: 'busy',
      name: '  Video\u0000 editor  ',
    });
    await record(103, ids.older, '2.1.226', {
      messagingSocketPath: '/tmp/s103.sock',
      status: 'idle',
    });
    await record(104, ids.socketless, '2.1.224', { status: 'shell' });
    await record(105, ids.closed, '2.1.284', {
      messagingSocketPath: '/tmp/s105.sock',
      status: 'idle',
    });
    await record(106, ids.npm, '2.1.280', {
      messagingSocketPath: '/tmp/s106.sock',
      status: 'idle',
    });
    // A native Claude binary is named after its version; the npm package runs as `claude.exe`. The socket owner must also be the recorded pid.
    const owners: Record<string, LsofOwner[]> = {
      '/tmp/s101.sock': [{ pid: 101, command: '2.1.284' }],
      '/tmp/s102.sock': [{ pid: 102, command: '2.1.284' }],
      '/tmp/s103.sock': [{ pid: 103, command: '2.1.226' }],
      '/tmp/s105.sock': [],
      '/tmp/s106.sock': [{ pid: 106, command: 'claude.exe' }],
    };
    const runner: ProcessRunner = async function* (executable, args) {
      if (executable === '/usr/sbin/lsof')
        for (const line of ownerLines(owners, lsofPaths(args))) yield { type: 'line', line };
      if (executable === '/bin/ps' && args.at(-1) === '104')
        yield { type: 'line', line: '/Users/me/.local/share/claude/versions/2.1.224' };
      yield exit;
    };
    const scan = await discoverOpenClaude(
      { configDir: config, runner },
      new AbortController().signal,
    );
    expect(scan.complete).toBe(true);
    expect(scan.candidates[0]?.sessionTitle).toBe('Video editor');
    expect(scan.candidates[1]?.sessionTitle).toBeUndefined();
    expect(
      scan.candidates.map(({ target, support, activity }) => ({
        id: target.sessionRef,
        support,
        activity,
      })),
    ).toEqual([
      { id: ids.current, support: 'supported', activity: 'working' },
      { id: ids.older, support: 'supported', activity: 'idle' },
      { id: ids.socketless, support: 'supported', activity: 'working' },
      { id: ids.npm, support: 'supported', activity: 'idle' },
    ]);
  },
);

describe.runIf(process.platform === 'darwin')('batched Claude liveness', () => {
  const live = (pid: number) => ({ pid, command: 'claude' });
  async function sessions(count: number) {
    const config = await realpath(await mkdtemp(join(tmpdir(), 'claude-batch-')));
    roots.push(config);
    await mkdir(join(config, 'sessions'));
    const records = Array.from({ length: count }, (_, i) => ({
      pid: 200 + i,
      sessionId: `00000000-0000-4000-8000-0000000002${String(i).padStart(2, '0')}`,
      cwd: config,
      version: '2.1.301',
      entrypoint: 'cli',
      messagingSocketPath: `/tmp/batch-${200 + i}.sock`,
    }));
    for (const record of records)
      await writeFile(join(config, 'sessions', `${record.pid}.json`), JSON.stringify(record));
    const owners = Object.fromEntries(records.map((r) => [r.messagingSocketPath, [live(r.pid)]]));
    return { config, records, owners };
  }

  it('runs one lsof for many sessions', async () => {
    const { config, owners } = await sessions(5);
    const { runner, calls } = lsofRunner(owners);
    const scan = await discoverOpenClaude(
      { configDir: config, runner },
      new AbortController().signal,
    );
    expect(calls).toHaveLength(1);
    expect(lsofPaths(calls[0]!)).toHaveLength(5);
    expect(scan.complete).toBe(true);
    expect(scan.candidates).toHaveLength(5);
  });

  it('keeps the scan incomplete when the probe fails', async () => {
    const { config, owners } = await sessions(2);
    const { runner } = lsofRunner(owners, { exit: 2 });
    const scan = await discoverOpenClaude(
      { configDir: config, runner },
      new AbortController().signal,
    );
    expect(scan.complete).toBe(false);
    expect(scan.error).toBe('Claude liveness verification failed');
    expect(scan.candidates).toEqual([]);
  });

  it('keeps discovery incomplete on a cached failure', async () => {
    const { config, owners, records } = await sessions(1);
    const { runner, calls } = lsofRunner(owners, { exit: 2 });
    const liveness = createClaudeLiveness({ runner, processExists: () => true });
    const record = records[0]!;
    await expect(liveness.check(record)).resolves.toBe('failed');
    const scan = await discoverOpenClaude(
      { configDir: config, runner },
      new AbortController().signal,
      liveness,
    );
    expect(calls).toHaveLength(1);
    expect(scan.complete).toBe(false);
    expect(scan.candidates).toEqual([]);
  });

  it('treats a vanished process as a real absence', async () => {
    const { config, owners } = await sessions(2);
    const { runner, calls } = lsofRunner(owners);
    const scan = await discoverOpenClaude(
      { configDir: config, runner, processExists: () => false },
      new AbortController().signal,
    );
    expect(calls).toHaveLength(0);
    expect(scan.complete).toBe(true);
    expect(scan.candidates).toEqual([]);
  });
});
