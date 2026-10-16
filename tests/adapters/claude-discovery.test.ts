import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverOpenClaude } from '../../src/agents/claude/index.js';
import type { ProcessRunner } from '../../src/runtime/process-runner.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const exit = {
  type: 'exit' as const,
  outcome: { code: 0, signal: null, reason: 'exited' as const, diagnostics: '' },
};
const ids = {
  worker: '00000000-0000-4000-8000-000000000001',
  current: '00000000-0000-4000-8000-000000000002',
  older: '00000000-0000-4000-8000-000000000003',
  socketless: '00000000-0000-4000-8000-000000000004',
  closed: '00000000-0000-4000-8000-000000000005',
  npm: '00000000-0000-4000-8000-000000000006',
};

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
    const owners: Record<string, string[]> = {
      '/tmp/s101.sock': ['p101', 'c2.1.284'],
      '/tmp/s102.sock': ['p102', 'c2.1.284'],
      '/tmp/s103.sock': ['p103', 'c2.1.226'],
      '/tmp/s105.sock': [],
      '/tmp/s106.sock': ['p106', 'cclaude.exe'],
    };
    const runner: ProcessRunner = async function* (executable, args) {
      if (executable === '/usr/sbin/lsof')
        for (const line of owners[args.at(-1)!] ?? []) yield { type: 'line', line };
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
