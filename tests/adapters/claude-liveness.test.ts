import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_LIVENESS_TTL_MS,
  createClaudeLiveness,
  pidExists,
  type SocketRecord,
} from '../../src/agents/claude/liveness.js';
import { lsofRunner, type LsofBehavior } from './lsof-fixture.js';

const socket = (pid: number) => `/tmp/cc-socks/${pid}.sock`;
const record = (pid: number, path = socket(pid)): SocketRecord => ({
  pid,
  version: '2.1.301',
  messagingSocketPath: path,
});
const held = (...pids: number[]) =>
  Object.fromEntries(pids.map((pid) => [socket(pid), [{ pid, command: 'claude' }]]));

function setup(
  owners: ReturnType<typeof held>,
  behavior?: (paths: string[], call: number) => LsofBehavior | undefined,
) {
  let t = 0;
  const fake = lsofRunner(owners, behavior);
  const liveness = createClaudeLiveness({
    runner: fake.runner,
    processExists: () => true,
    now: () => t,
  });
  return { ...fake, liveness, at: (ms: number) => (t = ms) };
}

afterEach(() => vi.restoreAllMocks());

describe.runIf(process.platform === 'darwin')('Claude liveness prober', () => {
  it('uses a 3 second window', () => {
    expect(CLAUDE_LIVENESS_TTL_MS).toBe(3000);
  });

  it('groups checks in one tick into one lsof', async () => {
    const pids = Array.from({ length: 13 }, (_, i) => 100 + i);
    const { liveness, calls } = setup(held(...pids));
    const states = await Promise.all(pids.map((pid) => liveness.check(record(pid))));
    expect(calls).toHaveLength(1);
    expect(states).toEqual(pids.map(() => 'alive'));
  });

  it('checkMany keeps input order', async () => {
    const { liveness, calls } = setup({
      ...held(1),
      [socket(2)]: [{ pid: 99, command: 'claude' }],
    });
    await expect(liveness.checkMany([record(1), record(2), record(3)])).resolves.toEqual([
      'alive',
      'not-alive',
      'not-alive',
    ]);
    expect(calls).toHaveLength(1);
  });

  it('accepts only claude, claude.exe, or the record version', async () => {
    const { liveness } = setup({
      [socket(1)]: [{ pid: 1, command: 'claude.exe' }],
      [socket(2)]: [{ pid: 2, command: '2.1.301' }],
      [socket(3)]: [{ pid: 3, command: 'node' }],
      [socket(4)]: [{ pid: 4, command: '2.1.300' }],
    });
    await expect(
      liveness.checkMany([record(1), record(2), record(3), record(4)]),
    ).resolves.toEqual(['alive', 'alive', 'not-alive', 'not-alive']);
  });

  it('serves the cache within the window', async () => {
    const { liveness, calls, at } = setup(held(1));
    await liveness.check(record(1));
    at(1000);
    await liveness.check(record(1));
    at(2999);
    await liveness.check(record(1));
    expect(calls).toHaveLength(1);
    at(3001);
    await liveness.check(record(1));
    expect(calls).toHaveLength(2);
  });

  it('refreshes the working set together', async () => {
    const { liveness, calls, at } = setup(held(1, 2));
    await liveness.check(record(1));
    at(1500);
    await liveness.check(record(2));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.slice(4).sort()).toEqual([socket(1), socket(2)]);
    at(3001);
    await liveness.check(record(1));
    expect(calls).toHaveLength(2);
    at(4501);
    await liveness.check(record(1));
    expect(calls).toHaveLength(3);
    expect(calls[2]!.slice(4).sort()).toEqual([socket(1), socket(2)]);
    at(4600);
    await liveness.check(record(2));
    expect(calls).toHaveLength(3);
  });

  it('forgets records not requested for two windows', async () => {
    const { liveness, calls, at } = setup(held(1, 2));
    await liveness.checkMany([record(1), record(2)]);
    at(3001);
    await liveness.check(record(1));
    at(7000);
    await liveness.check(record(1));
    expect(calls.at(-1)!.slice(4)).toEqual([socket(1)]);
  });

  it('rechecks at once when the PID or socket changes', async () => {
    const { liveness, calls, at } = setup({
      ...held(1),
      '/tmp/cc-socks/other.sock': [{ pid: 1, command: 'claude' }],
    });
    await expect(liveness.check(record(1))).resolves.toBe('alive');
    at(100);
    await expect(liveness.check({ ...record(1), pid: 2 })).resolves.toBe('not-alive');
    expect(calls).toHaveLength(2);
    at(200);
    await expect(liveness.check(record(1, '/tmp/cc-socks/other.sock'))).resolves.toBe('alive');
    expect(calls).toHaveLength(3);
  });

  it('judges two records on the same path by their own PID', async () => {
    const { liveness, calls } = setup({ [socket(10)]: [{ pid: 10, command: 'claude' }] });
    await expect(
      liveness.checkMany([record(10), record(11, socket(10))]),
    ).resolves.toEqual(['alive', 'not-alive']);
    expect(calls).toHaveLength(1);
  });

  it('shares an in-flight check', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    const { liveness, calls } = setup(held(1), () => ({ wait }));
    const first = liveness.check(record(1));
    await new Promise((resolve) => setImmediate(resolve));
    const second = liveness.check(record(1));
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(['alive', 'alive']);
    expect(calls).toHaveLength(1);
  });

  it('fails closed, replaces an alive result, and caches the failure', async () => {
    const { liveness, calls, at } = setup(held(1), (_paths, call) =>
      call === 1 ? { exit: 2 } : undefined,
    );
    await expect(liveness.check(record(1))).resolves.toBe('alive');
    at(3001);
    await expect(liveness.check(record(1))).resolves.toBe('failed');
    at(4000);
    await expect(liveness.check(record(1))).resolves.toBe('failed');
    expect(calls).toHaveLength(2);
  });

  it('skips lsof when the process is gone', async () => {
    const fake = lsofRunner(held(1));
    const liveness = createClaudeLiveness({ runner: fake.runner, processExists: () => false });
    await expect(liveness.check(record(1))).resolves.toBe('not-alive');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('pidExists', () => {
  it('finds this process', () => {
    expect(pidExists(process.pid)).toBe(true);
  });
  it.each([
    ['EPERM', true],
    ['ESRCH', false],
    ['EINVAL', true],
  ])('maps %s to %s', (code, expected) => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });
    expect(pidExists(4242)).toBe(expected);
  });
});
