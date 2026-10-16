import { expect, it } from 'vitest';
import {
  classifyCodexCommand,
  decideLiveness,
  parseElapsed,
  type CodexProcess,
} from '../../src/agents/codex/liveness.js';

const ID = '01a12f4f-c2c5-7be1-a9f0-d83d3e5610ce';
it('parses ps elapsed time', () => {
  expect(parseElapsed('05')).toBeUndefined();
  expect(parseElapsed('01:02')).toBe(62_000);
  expect(parseElapsed('1:00:00')).toBe(3_600_000);
  expect(parseElapsed('2-00:00:01')).toBe(172_801_000);
});
it('classifies daemon, clients and non-client subcommands from the command line', () => {
  expect(
    classifyCodexCommand('/r/0.162.1/bin/codex app-server --listen unix:// --managed-daemon').role,
  ).toBe('daemon');
  expect(
    classifyCodexCommand(
      '/opt/codex/bin/codex --enable hooks --dangerously-bypass-approvals-and-sandbox',
    ),
  ).toEqual({ role: 'client' });
  expect(
    classifyCodexCommand('/opt/codex/bin/codex Reply with READY only. Do not run commands. -m gpt'),
  ).toEqual({ role: 'client' });
  expect(classifyCodexCommand(`/opt/codex/bin/codex -C sub --model exec resume ${ID}`)).toEqual({
    role: 'client',
    resume: ID,
    cd: 'sub',
  });
  expect(classifyCodexCommand('/opt/codex/bin/codex queue --thread x').role).toBe('other');
  expect(classifyCodexCommand('/opt/codex/bin/codex-code-mode-host').role).toBe('other');
  expect(classifyCodexCommand('/Users/u/Application Support/bin/codex --cd=/w').cd).toBe('/w');
});
it('lets a client claim at most one daemon thread', () => {
  const processes = new Map<number, CodexProcess>([
    [1, { pid: 1, startedAt: 0, role: 'daemon' }],
    [2, { pid: 2, startedAt: 1000, role: 'client' }],
  ]);
  const threads = [
    { id: 'a', ownerPid: 1, cwd: '/w', createdAt: 2000 },
    { id: 'b', ownerPid: 1, cwd: '/w', createdAt: 3000 },
    { id: 'c', ownerPid: 1, cwd: '/w' },
  ];
  const result = decideLiveness(threads, processes, new Map([[2, '/w']]));
  expect([...result].map(([id, l]) => [id, l.open])).toEqual([
    ['a', false],
    ['b', true],
    ['c', false],
  ]);
});
