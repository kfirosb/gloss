import { describe, expect, it } from 'vitest';
import { observedOwners } from '../../src/agents/shared.js';
import { lsofRunner } from './lsof-fixture.js';

const a = '/tmp/cc-socks/1.sock';
const b = '/tmp/cc-socks/2.sock';
const c = '/tmp/cc-socks/3.sock';
const claude = (pid: number) => ({ pid, command: 'claude' });

describe.runIf(process.platform === 'darwin')('observedOwners', () => {
  it('runs one lsof for many paths', async () => {
    const { runner, calls } = lsofRunner({ [a]: [claude(1)], [b]: [claude(2)], [c]: [claude(3)] });
    const result = await observedOwners([a, b, c], runner);
    expect(calls).toEqual([['-Fpcfn', '+c', '0', '--', a, b, c]]);
    expect(result.get(a)).toEqual({ ok: true, owners: [claude(1)] });
    expect(result.get(b)).toEqual({ ok: true, owners: [claude(2)] });
    expect(result.get(c)).toEqual({ ok: true, owners: [claude(3)] });
  });

  it('attributes mixed output', async () => {
    const { runner } = lsofRunner({ [a]: [claude(1)], [b]: [claude(1)], [c]: [claude(2)] });
    const result = await observedOwners([a, b, c], runner);
    expect(result.get(a)).toEqual({ ok: true, owners: [claude(1)] });
    expect(result.get(b)).toEqual({ ok: true, owners: [claude(1)] });
    expect(result.get(c)).toEqual({ ok: true, owners: [claude(2)] });
  });

  it('treats exit 1 with an unheld path as success', async () => {
    const { runner } = lsofRunner({ [a]: [claude(1)] });
    const result = await observedOwners([a, b], runner);
    expect(result.get(a)).toEqual({ ok: true, owners: [claude(1)] });
    expect(result.get(b)).toEqual({ ok: true, owners: [] });
  });

  it('accepts missing path diagnostics', async () => {
    const { runner } = lsofRunner(
      { [a]: [claude(1)] },
      { diagnostics: 'lsof: status error on /private/tmp/x.sock: No such file or directory\n' },
    );
    const result = await observedOwners([a, '/tmp/x.sock'], runner);
    expect(result.get(a)).toEqual({ ok: true, owners: [claude(1)] });
    expect(result.get('/tmp/x.sock')).toEqual({ ok: true, owners: [] });
  });

  it.each([
    ['exit 2', { exit: 2 }],
    ['timeout', { reason: 'timeout' as const, exit: 0 }],
    ['other stderr', { diagnostics: 'lsof: WARNING: something\n' }],
    ['unknown field', { extraLines: ['xjunk'] }],
    ['unrequested name', { extraLines: ['p9', 'cclaude', 'f1', 'n/not/requested'] }],
    ['file before command', { extraLines: ['p9', 'f3'] }],
    ['pid zero', { extraLines: ['p0', 'cclaude', 'f1', `n${a}`] }],
    ['process without file', { extraLines: ['p9', 'cclaude'] }],
  ])('fails closed on %s', async (_label, behavior) => {
    const { runner } = lsofRunner({ [a]: [claude(1)], [b]: [claude(2)] }, behavior);
    const result = await observedOwners([a, b], runner);
    expect(result.get(a)).toEqual({ ok: false });
    expect(result.get(b)).toEqual({ ok: false });
  });

  it('splits batches and isolates a failed batch', async () => {
    const paths = Array.from({ length: 130 }, (_, i) => `/tmp/cc-socks/${i}.sock`);
    const owners = Object.fromEntries(paths.map((path, i) => [path, [claude(i + 1)]]));
    const { runner, calls } = lsofRunner(owners, (_paths, call) =>
      call === 1 ? { exit: 2 } : undefined,
    );
    const result = await observedOwners(paths, runner);
    expect(calls.map((args) => args.length - 4)).toEqual([128, 2]);
    expect(result.get(paths[0]!)).toEqual({ ok: true, owners: [claude(1)] });
    expect(result.get(paths[127]!)).toEqual({ ok: true, owners: [claude(128)] });
    expect(result.get(paths[128]!)).toEqual({ ok: false });
    expect(result.get(paths[129]!)).toEqual({ ok: false });
  });

  it('dedupes paths', async () => {
    const { runner, calls } = lsofRunner({ [a]: [claude(1)] });
    await observedOwners([a, a], runner);
    expect(calls).toEqual([['-Fpcfn', '+c', '0', '--', a]]);
  });

  it('scales the output limit with the batch', async () => {
    const { runner, options } = lsofRunner({});
    await observedOwners([a, b], runner);
    expect(options[0]).toEqual({ timeoutMs: 3000, maxOutputBytes: 2 * 32_768 });
    const many = Array.from({ length: 100 }, (_, i) => `/tmp/cc-socks/${i}.sock`);
    const big = lsofRunner({});
    await observedOwners(many, big.runner);
    expect(big.options[0]).toEqual({ timeoutMs: 3000, maxOutputBytes: 1_048_576 });
  });
});

it('reports no owners and runs nothing off macOS', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    const { runner, calls } = lsofRunner({ [a]: [claude(1)] });
    const result = await observedOwners([a], runner);
    expect(calls).toEqual([]);
    expect(result.get(a)).toEqual({ ok: true, owners: [] });
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});
