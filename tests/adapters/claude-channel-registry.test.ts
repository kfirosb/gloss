import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type RequestListener } from 'node:http';
import {
  createChannelRegistry,
  type ChannelProcess,
  type ChannelRegistryOptions,
} from '../../src/agents/claude/channel-registry.js';
import type { ChannelRecord } from '../../src/agents/claude/channel-types.js';
import { enabledChannelServer } from '../../src/agents/claude/channel-activation.js';
import type { ProcessRunner } from '../../src/runtime/process-runner.js';

// Keep real filesystem behavior; allow only the selected syscall to be stalled.
vi.mock('node:fs/promises', async (importOriginal) => ({ ...(await importOriginal<typeof fs>()) }));

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const generation = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const otherGeneration = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const cleanups: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function endpoint(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing bound port');
  return address.port;
}

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'channel-registry-')));
  cleanups.push(dir);
  const configDir = join(dir, 'claude');
  const registryDir = join(dir, 'state', 'claude-channels');
  const project = join(dir, 'project');
  const projects = join(configDir, 'projects', 'project');
  for (const path of [project, projects, join(configDir, 'sessions'), registryDir])
    await mkdir(path, { recursive: true, mode: 0o700 });
  const uid = process.getuid!();
  const table = new Map<number, ChannelProcess>([
    [
      300,
      {
        pid: 300,
        ppid: 200,
        uid,
        startedAt: 'Wed Oct  7 10:00:01 2026',
        command: '/usr/local/bin/node',
      },
    ],
    [
      200,
      { pid: 200, ppid: 1, uid, startedAt: 'Wed Oct  7 10:00:00 2026', command: '/native/2.1.288' },
    ],
  ]);
  const native = {
    sessionId: id,
    cwd: project,
    pid: 200,
    procStart: 'Wed Oct  7 10:00:00 2026',
    pidDomain: 'darwin',
    version: '2.1.288',
    startedAt: 1791367200000,
    name: 'Duplicate title',
    entrypoint: 'cli',
  };
  const nativePath = join(configDir, 'sessions', '200.json');
  const transcript = join(projects, `${id}.jsonl`);
  await writeFile(nativePath, JSON.stringify(native), { mode: 0o600 });
  await writeFile(
    transcript,
    JSON.stringify({
      sessionId: id,
      cwd: project,
      type: 'user',
      uuid: 'first',
      message: { role: 'user', content: 'hello' },
    }) + '\n',
    { mode: 0o600 },
  );
  let time = 0;
  const sleeps: number[] = [];
  const options: ChannelRegistryOptions = {
    registryDir,
    configDir,
    port: 49152,
    pid: 300,
    uid,
    platform: 'darwin',
    probe: async (pid) => table.get(pid),
    healthProbe: async (record) => ({ generation: record.generation, ready: true }),
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
  };
  const target = { agent: 'claude' as const, sessionRef: id, projectId: project };
  const record: ChannelRecord = {
    schemaVersion: 1,
    target,
    transcriptPath: transcript,
    claudePid: 200,
    claudeStartedAt: native.procStart,
    channelPid: 300,
    channelStartedAt: table.get(300)!.startedAt,
    generation,
    port: 49152,
    token: 'ab'.repeat(32),
  };
  const path = join(registryDir, `${generation}.json`);
  const seed = async (value = record, destination = path) =>
    writeFile(destination, JSON.stringify(value), { mode: 0o600 });
  return {
    dir,
    configDir,
    registryDir,
    project,
    native,
    nativePath,
    transcript,
    table,
    options,
    target,
    record,
    path,
    seed,
    sleeps,
  };
}

describe('experimental native Claude channel registry', () => {
  it('requires authenticated ready health and checks it again on each resolution', async () => {
    const f = await fixture();
    delete f.options.healthProbe;
    let ready = true;
    const requests: {
      url: string | undefined;
      auth: string | undefined;
      host: string | undefined;
    }[] = [];
    f.record.port = await endpoint((req, res) => {
      requests.push({ url: req.url, auth: req.headers.authorization, host: req.headers.host });
      if (req.headers.authorization !== `Bearer ${f.record.token}`) {
        res.writeHead(401).end();
        return;
      }
      res.end(JSON.stringify({ generation, ready }));
    });
    await f.seed();
    const registry = createChannelRegistry(f.options);
    expect(await registry.resolveChannel(f.target)).toEqual(f.record);
    expect(requests).toEqual([
      { url: '/health', auth: `Bearer ${f.record.token}`, host: `127.0.0.1:${f.record.port}` },
    ]);
    ready = false;
    expect(await registry.resolveChannel(f.target)).toBeUndefined();
  });

  it.each([
    'not ready',
    'wrong generation',
    'truthy ready',
    'unauthorized',
    'malformed',
    'oversized',
    'redirect',
    'stalled headers',
    'stalled body',
  ])('rejects real HTTP health: %s', async (response) => {
    const f = await fixture();
    delete f.options.healthProbe;
    let redirected = 0;
    const otherPort = await endpoint((_req, res) => {
      redirected++;
      res.end(JSON.stringify({ generation, ready: true }));
    });
    f.record.port = await endpoint((_req, res) => {
      if (response === 'stalled headers') return;
      if (response === 'stalled body') {
        res.writeHead(200);
        res.write('{');
        return;
      }
      if (response === 'redirect') {
        res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/health` }).end();
        return;
      }
      if (response === 'unauthorized') {
        res.writeHead(401).end(JSON.stringify({ generation, ready: true }));
        return;
      }
      if (response === 'malformed') {
        res.end('{');
        return;
      }
      if (response === 'oversized') {
        res.end(JSON.stringify({ generation, ready: true, padding: 'x'.repeat(4096) }));
        return;
      }
      res.end(
        JSON.stringify({
          generation: response === 'wrong generation' ? otherGeneration : generation,
          ready: response === 'truthy ready' ? 'true' : false,
        }),
      );
    });
    await f.seed();
    const start = performance.now();
    expect(await createChannelRegistry(f.options).resolveChannel(f.target)).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(2000);
    expect(redirected).toBe(0);
  });

  it('does not health-resolve registration before the endpoint can activate it', async () => {
    const f = await fixture();
    f.options.healthProbe = async () => {
      throw new Error('Not ready until registration returns');
    };
    const registry = createChannelRegistry(f.options);
    const record = await registry.registerChannel();
    expect(record.target).toEqual(f.target);
    expect(await registry.resolveChannel(f.target)).toBeUndefined();
  });

  it.each(['failed', 'delayed'])(
    'excludes a late rename with %s unlink and resolves a later activated registration',
    async (cleanup) => {
      const f = await fixture();
      delete f.options.healthProbe;
      const activated = new Map<string, string>();
      f.options.port = await endpoint((req, res) => {
        const active = activated.get(req.headers.authorization ?? '');
        res.end(JSON.stringify({ generation: active ?? '', ready: !!active }));
      });
      let clock = 0;
      f.options.now = () => clock;
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let cleanupEntered!: () => void;
      const cleaning = new Promise<void>((resolve) => {
        cleanupEntered = resolve;
      });
      let releaseCleanup!: () => void;
      const cleanupGate = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      let destination = '';
      const originalRename = fs.rename;
      const originalUnlink = fs.unlink;
      vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
        destination = String(to);
        entered();
        await gate;
        await originalRename(from, to);
      });
      vi.spyOn(fs, 'unlink').mockImplementation(async (path) => {
        if (String(path) === destination) {
          cleanupEntered();
          if (cleanup === 'failed')
            throw Object.assign(new Error('Fixture denied cleanup'), { code: 'EACCES' });
          await cleanupGate;
        }
        await originalUnlink(path);
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const registry = createChannelRegistry(f.options);
      const result = registry.registerChannel().then(
        () => 'registered',
        () => 'disconnected',
      );
      try {
        await reached;
        clock = 10_000;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await result).toBe('disconnected');
        vi.useRealTimers();
        release();
        await cleaning;
        expect(JSON.parse(await readFile(destination, 'utf8')).schemaVersion).toBe(1);
        expect(await registry.resolveChannel(f.target)).toBeUndefined();
        const later = await registry.registerChannel();
        activated.set(`Bearer ${later.token}`, later.generation); // Task3 activation order.
        expect(await registry.resolveChannel(f.target)).toEqual(later);
        expect(await createChannelRegistry(f.options).resolveChannel(f.target)).toEqual(later);
        expect(JSON.parse(await readFile(destination, 'utf8')).generation).not.toBe(
          later.generation,
        );
      } finally {
        vi.useRealTimers();
        release();
        releaseCleanup();
        await result;
        if (cleanup === 'delayed')
          await expect
            .poll(async () =>
              (await readdir(f.registryDir)).includes(destination.split('/').at(-1)!),
            )
            .toBe(false);
        vi.restoreAllMocks();
      }
    },
  );

  it('registers the OS ancestor, persists private credentials, and resolves from another factory', async () => {
    const f = await fixture();
    const registry = createChannelRegistry(f.options);
    const record = await registry.registerChannel();
    expect(record).toMatchObject({
      schemaVersion: 1,
      target: f.target,
      transcriptPath: f.transcript,
      claudePid: 200,
      claudeStartedAt: f.native.procStart,
      channelPid: 300,
      channelStartedAt: 'Wed Oct  7 10:00:01 2026',
      port: 49152,
    });
    expect(record.generation).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
    expect(record.token).toMatch(/^[a-f0-9]{64}$/);
    const path = join(f.registryDir, `${record.generation}.json`);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(record);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(f.registryDir)).mode & 0o777).toBe(0o700);
    expect(await readdir(f.registryDir)).toEqual([`${record.generation}.json`]);
    expect(await createChannelRegistry(f.options).resolveChannel(f.target)).toEqual(record);
  });

  // npm and Homebrew installs run as `claude.exe`; it binds exactly like `claude` or the versioned binary.
  it.each([
    {
      command: '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
      binds: true,
    },
    { command: '/usr/local/bin/claude', binds: true },
    { command: '/usr/local/bin/node', binds: false },
  ])('binds the Claude ancestor running as $command: $binds', async ({ command, binds }) => {
    const f = await fixture();
    f.table.get(200)!.command = command;
    const registration = createChannelRegistry(f.options).registerChannel();
    if (binds) expect((await registration).claudePid).toBe(200);
    else await expect(registration).rejects.toThrow();
  });

  it('creates the private state root and distinct credentials for each registration', async () => {
    const f = await fixture();
    await rm(join(f.dir, 'state'), { recursive: true });
    const a = await createChannelRegistry(f.options).registerChannel(54321);
    await createChannelRegistry(f.options).removeChannel(a.generation); // A different owner cannot remove it.
    expect(await stat(join(f.registryDir, `${a.generation}.json`))).toBeDefined();
    const b = await createChannelRegistry(f.options).registerChannel();
    expect(a.port).toBe(54321);
    expect(a.token).not.toBe(b.token);
    expect(a.generation).not.toBe(b.generation);
    expect((await stat(join(f.dir, 'state'))).mode & 0o777).toBe(0o700);
    expect(await createChannelRegistry(f.options).resolveChannel(f.target)).toBeUndefined();
  });

  it('resolves exact UUID/project despite duplicate display names and newer unrelated metadata', async () => {
    const f = await fixture();
    await f.seed();
    await writeFile(
      join(f.configDir, 'sessions', 'other.json'),
      JSON.stringify({
        ...f.native,
        sessionId: otherGeneration,
        pid: 201,
        updatedAt: 9999999999999,
      }),
    );
    const registry = createChannelRegistry(f.options);
    expect(await registry.resolveChannel(f.target)).toEqual(f.record);
    expect(
      await registry.resolveChannel({ ...f.target, sessionRef: otherGeneration }),
    ).toBeUndefined();
    expect(await registry.resolveChannel({ ...f.target, projectId: f.dir })).toBeUndefined();
  });

  const corruptions = [
    'stale Claude start',
    'stale channel start',
    'dead parent',
    'wrong process UID',
    'wrong file UID',
    'record symlink',
    'directory symlink',
    'transcript symlink',
    'native symlink',
    'broad file permissions',
    'broad directory permissions',
    'oversized record',
    'malformed record',
    'replaced generation',
    'wrong transcript UUID',
    'wrong transcript project',
    'missing metadata',
    'wrong native procStart',
    'missing procStart',
    'wrong pid domain',
    'wrong native project',
    'non-Claude owner',
  ] as const;
  it.each(corruptions)('returns no binding for %s', async (reason) => {
    const f = await fixture();
    await f.seed();
    const registry = createChannelRegistry(f.options);
    expect(await registry.resolveChannel(f.target)).toEqual(f.record);
    switch (reason) {
      case 'stale Claude start':
        f.table.get(200)!.startedAt = 'reused PID';
        break;
      case 'stale channel start':
        f.table.get(300)!.startedAt = 'reused PID';
        break;
      case 'dead parent':
        f.table.delete(200);
        break;
      case 'wrong process UID':
        f.table.get(200)!.uid++;
        break;
      case 'wrong file UID':
        f.options.uid!++;
        break;
      case 'record symlink':
        await rename(f.path, f.path + '.real');
        await symlink(f.path + '.real', f.path);
        break;
      case 'directory symlink':
        await rename(f.registryDir, f.registryDir + '.real');
        await symlink(f.registryDir + '.real', f.registryDir);
        break;
      case 'transcript symlink':
        await rename(f.transcript, f.transcript + '.real');
        await symlink(f.transcript + '.real', f.transcript);
        break;
      case 'native symlink':
        await rename(f.nativePath, f.nativePath + '.real');
        await symlink(f.nativePath + '.real', f.nativePath);
        break;
      case 'broad file permissions':
        await chmod(f.path, 0o644);
        break;
      case 'broad directory permissions':
        await chmod(f.registryDir, 0o755);
        break;
      case 'oversized record':
        await writeFile(f.path, JSON.stringify({ ...f.record, padding: 'x'.repeat(65536) }));
        break;
      case 'malformed record':
        await writeFile(f.path, '{');
        break;
      case 'replaced generation':
        await f.seed({ ...f.record, generation: otherGeneration });
        break;
      case 'wrong transcript UUID':
        await writeFile(
          f.transcript,
          JSON.stringify({ sessionId: otherGeneration, cwd: f.project }) + '\n',
        );
        break;
      case 'wrong transcript project':
        await writeFile(f.transcript, JSON.stringify({ sessionId: id, cwd: f.dir }) + '\n');
        break;
      case 'missing metadata':
        await rm(f.nativePath);
        break;
      case 'wrong native procStart':
        await writeFile(
          f.nativePath,
          JSON.stringify({ ...f.native, procStart: String(f.native.startedAt) }),
        );
        break;
      case 'missing procStart':
        await writeFile(f.nativePath, JSON.stringify({ ...f.native, procStart: undefined }));
        break;
      case 'wrong pid domain':
        await writeFile(f.nativePath, JSON.stringify({ ...f.native, pidDomain: 'linux' }));
        break;
      case 'wrong native project':
        await writeFile(f.nativePath, JSON.stringify({ ...f.native, cwd: f.dir }));
        break;
      case 'non-Claude owner':
        f.table.get(200)!.command = '/usr/bin/node';
        break;
    }
    expect(await createChannelRegistry(f.options).resolveChannel(f.target)).toBeUndefined();
    expect(await registry.resolveChannel(f.target)).toBeUndefined();
  });

  it('keeps resolving a registration after Claude moved the session into a worktree under its project', async () => {
    const f = await fixture();
    await f.seed();
    const registry = createChannelRegistry(f.options);
    expect(await registry.resolveChannel(f.target)).toEqual(f.record);
    // Claude's worktree isolation changes the session's cwd and moves its transcript to the
    // worktree's own project directory; the first record still names the original project.
    const worktree = join(f.project, '.claude', 'worktrees', 'fix');
    const movedDir = join(f.configDir, 'projects', 'project--claude-worktrees-fix');
    await mkdir(worktree, { recursive: true });
    await mkdir(movedDir, { recursive: true, mode: 0o700 });
    await rename(f.transcript, join(movedDir, `${id}.jsonl`));
    await writeFile(f.nativePath, JSON.stringify({ ...f.native, cwd: worktree }));
    expect(await registry.resolveChannel(f.target)).toEqual(f.record);
    expect(await createChannelRegistry(f.options).resolveChannel(f.target)).toEqual(f.record);
    expect(await registry.resolveChannel({ ...f.target, projectId: worktree })).toBeUndefined();
  });

  it('rejects two live native owners of the exact session', async () => {
    const f = await fixture();
    await f.seed();
    f.table.set(201, { ...f.table.get(200)!, pid: 201 });
    await writeFile(
      join(f.configDir, 'sessions', '201.json'),
      JSON.stringify({ ...f.native, pid: 201 }),
    );
    expect(await createChannelRegistry(f.options).resolveChannel(f.target)).toBeUndefined();
    await expect(createChannelRegistry(f.options).registerChannel()).rejects.toThrow();
  });

  it('does not follow a changed parent chain even when both saved PIDs are live', async () => {
    const f = await fixture();
    await f.seed();
    f.table.get(300)!.ppid = 1;
    expect(await createChannelRegistry(f.options).resolveChannel(f.target)).toBeUndefined();
  });

  it('accepts a verified Claude owner below a system-owned terminal ancestor', async () => {
    const f = await fixture();
    await f.seed();
    f.table.get(200)!.ppid = 100;
    f.table.set(100, {
      pid: 100,
      ppid: 1,
      uid: f.options.uid! + 1,
      startedAt: 'system login start',
      command: '/usr/bin/login',
    });
    expect(await createChannelRegistry(f.options).resolveChannel(f.target)).toEqual(f.record);
  });

  it('accepts native directories at 0755 while retaining private channel state', async () => {
    const f = await fixture();
    await f.seed();
    await chmod(f.configDir, 0o755);
    await chmod(join(f.configDir, 'projects'), 0o755);
    expect(await createChannelRegistry(f.options).resolveChannel(f.target)).toEqual(f.record);
  });

  it('rejects replacement of a registration during live verification', async () => {
    const f = await fixture();
    await f.seed();
    const probe = f.options.probe!;
    f.options.probe = async (pid, signal) => {
      await f.seed({ ...f.record, generation: otherGeneration });
      return probe(pid, signal);
    };
    expect(await createChannelRegistry(f.options).resolveChannel(f.target)).toBeUndefined();
  });

  it('rejects a PID recycled during verification rather than publishing a stale registration', async () => {
    const f = await fixture();
    const original = f.options.probe!;
    f.options.probe = async (pid, signal) => {
      const value = await original(pid, signal);
      // Native metadata verification occurs after the child was observed in ancestry.
      if (pid === 200) f.table.get(300)!.startedAt = 'recycled during verification';
      return value ? { ...value } : undefined;
    };
    await expect(createChannelRegistry(f.options).registerChannel()).rejects.toThrow();
    expect(await readdir(f.registryDir)).toEqual([]);
  });

  it('ignores a stale channel but rejects two live channels for one target', async () => {
    const f = await fixture();
    await f.seed();
    const second = { ...f.record, channelPid: 301, generation: otherGeneration };
    await f.seed(second, join(f.registryDir, `${otherGeneration}.json`));
    expect(await createChannelRegistry(f.options).resolveChannel(f.target)).toEqual(f.record);
    f.table.set(301, { ...f.table.get(300)!, pid: 301 });
    expect(await createChannelRegistry(f.options).resolveChannel(f.target)).toBeUndefined();
  });

  it('resolves the legacy bridge when an inert gloss bridge runs in the same session', async () => {
    const f = await fixture();
    f.table.set(301, { ...f.table.get(300)!, pid: 301 });
    // A Gloss-launched session: the per-session legacy file plus the user-scope gloss entry.
    const parent = async () =>
      `/native/2.1.288 --session-id ${id} --mcp-config /x.json --dangerously-load-development-channels server:language-assistant`;
    const bridges = [
      { pid: 300, env: {} },
      { pid: 301, env: { GLOSS_CHANNEL_SERVER: 'gloss' } },
    ];
    const registered: ChannelRecord[] = [];
    for (const bridge of bridges)
      if (await enabledChannelServer(bridge.env, parent))
        registered.push(
          await createChannelRegistry({ ...f.options, pid: bridge.pid }).registerChannel(),
        );
    expect(registered.map((record) => record.channelPid)).toEqual([300]);
    expect(await createChannelRegistry(f.options).resolveChannel(f.target)).toEqual(registered[0]);
    // Without the gate both bridges register, and the session has no channel at all.
    await createChannelRegistry({ ...f.options, pid: 301 }).registerChannel();
    expect(await createChannelRegistry(f.options).resolveChannel(f.target)).toBeUndefined();
  });

  it('rejects an ambiguous transcript path and never selects the newest file', async () => {
    const f = await fixture();
    await f.seed();
    const second = join(f.configDir, 'projects', 'second');
    await mkdir(second, { mode: 0o700 });
    await writeFile(join(second, `${id}.jsonl`), await readFile(f.transcript), { mode: 0o600 });
    expect(await createChannelRegistry(f.options).resolveChannel(f.target)).toBeUndefined();
    await expect(createChannelRegistry(f.options).registerChannel()).rejects.toThrow();
  });

  it.each(['state symlink', 'broad state permissions', 'broad registry permissions'])(
    'never writes through %s',
    async (reason) => {
      const f = await fixture();
      const state = join(f.dir, 'state');
      if (reason === 'state symlink') {
        await rename(state, state + '.real');
        await symlink(state + '.real', state);
      } else await chmod(reason === 'broad state permissions' ? state : f.registryDir, 0o755);
      await expect(createChannelRegistry(f.options).registerChannel()).rejects.toThrow();
      expect(await readdir(f.registryDir)).toEqual([]);
    },
  );

  it('bounds ancestry to 16 parent hops and rejects cycles', async () => {
    const f = await fixture();
    for (let pid = 301; pid <= 316; pid++)
      f.table.set(pid, { ...f.table.get(300)!, pid, ppid: pid === 316 ? 200 : pid + 1 });
    f.table.get(300)!.ppid = 301;
    await expect(createChannelRegistry(f.options).registerChannel()).rejects.toThrow();
    f.table.get(315)!.ppid = 200;
    expect((await createChannelRegistry(f.options).registerChannel()).claudePid).toBe(200);
    f.table.get(300)!.ppid = 300;
    await expect(createChannelRegistry(f.options).registerChannel()).rejects.toThrow();
  });

  it('retries missing startup metadata every 250ms and stops by ten seconds', async () => {
    const f = await fixture();
    await rm(f.nativePath);
    await expect(createChannelRegistry(f.options).registerChannel()).rejects.toThrow();
    expect(f.sleeps).toEqual(Array(40).fill(250));
    expect(await readdir(f.registryDir)).toEqual([]);
  });

  it('registers when native metadata appears during startup', async () => {
    const f = await fixture();
    await rm(f.nativePath);
    const sleep = f.options.sleep!;
    f.options.sleep = async (ms) => {
      await sleep(ms);
      await writeFile(f.nativePath, JSON.stringify(f.native));
    };
    expect((await createChannelRegistry(f.options).registerChannel()).target).toEqual(f.target);
    expect(f.sleeps).toEqual([250]);
  });

  it.each(['transcript enumeration', 'fsync', 'rename'])(
    'times out stalled %s and leaves no late registration',
    async (stage) => {
      const f = await fixture();
      let clock = 0;
      f.options.now = () => clock;
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pause = async () => {
        entered();
        await gate;
      };
      if (stage === 'transcript enumeration') {
        const original = fs.readdir;
        vi.spyOn(fs, 'readdir').mockImplementation((...args) => {
          const result = original(...args);
          return String(args[0]) === join(f.configDir, 'projects')
            ? result.then(async (value) => {
                await pause();
                return value;
              })
            : result;
        });
      } else if (stage === 'fsync') {
        const original = fs.open;
        vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
          const file = await original(...args);
          if (String(args[0]).endsWith('.tmp')) {
            const sync = file.sync.bind(file);
            vi.spyOn(file, 'sync').mockImplementation(async () => {
              await pause();
              await sync();
            });
          }
          return file;
        });
      } else {
        const original = fs.rename;
        vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
          await pause();
          await original(...args);
        });
      }
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let state = 'pending';
      const result = createChannelRegistry(f.options)
        .registerChannel()
        .then(
          () => {
            state = 'registered';
          },
          () => {
            state = 'disconnected';
          },
        );
      try {
        await reached;
        clock = 10_000;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(state).toBe('disconnected'); // Must settle while the filesystem is still stalled.
      } finally {
        release();
        vi.useRealTimers();
        await result;
        // Allow the previously stalled syscall and its cleanup to finish.
        await new Promise((resolve) => setTimeout(resolve, 30));
        vi.restoreAllMocks();
      }
      expect(state).toBe('disconnected');
      expect(await readdir(f.registryDir)).toEqual([]);
      expect(await createChannelRegistry(f.options).resolveChannel(f.target)).toBeUndefined();
    },
  );

  it('removes only the generation this factory registered', async () => {
    const f = await fixture();
    const registry = createChannelRegistry(f.options);
    const own = await registry.registerChannel();
    await f.seed();
    await registry.removeChannel(generation);
    expect(await readFile(f.path, 'utf8')).toContain(generation);
    await registry.removeChannel(own.generation);
    expect(await readdir(f.registryDir)).toEqual([`${generation}.json`]);
  });

  it('does not remove a replacement placed in its registration path', async () => {
    const f = await fixture();
    const registry = createChannelRegistry(f.options);
    const own = await registry.registerChannel();
    const path = join(f.registryDir, `${own.generation}.json`);
    await f.seed({ ...own, generation: otherGeneration }, path);
    await registry.removeChannel(own.generation);
    expect(JSON.parse(await readFile(path, 'utf8')).generation).toBe(otherGeneration);
  });

  it('uses bounded UTC/C shell-free ps identities rather than native startedAt milliseconds', async () => {
    const f = await fixture();
    const runner: ProcessRunner = async function* (executable, args, input, signal, options) {
      expect(executable).toBe('/bin/ps');
      expect(args).toEqual([
        '-p',
        expect.stringMatching(/^\d+$/),
        '-o',
        'pid=,ppid=,uid=,lstart=,comm=',
      ]);
      expect(input).toBe('');
      expect(signal.aborted).toBe(false);
      expect(options?.env).toMatchObject({ TZ: 'UTC', LC_ALL: 'C' });
      expect(options!.timeoutMs).toBeLessThanOrEqual(1000);
      expect(options!.maxOutputBytes).toBeLessThanOrEqual(4096);
      const p = f.table.get(Number(args[1]));
      if (p)
        yield { type: 'line', line: `${p.pid} ${p.ppid} ${p.uid} ${p.startedAt} ${p.command}` };
      yield {
        type: 'exit',
        outcome: { code: p ? 0 : 1, reason: 'exited', signal: null, diagnostics: '' },
      };
    };
    const { probe: _, ...options } = f.options;
    expect(
      (await createChannelRegistry({ ...options, runner }).registerChannel()).claudeStartedAt,
    ).toBe('Wed Oct  7 10:00:00 2026');
  });

  it.each([0, -1, 65536, 1.5])('rejects an invalid bound port %s without writing', async (port) => {
    const f = await fixture();
    await expect(createChannelRegistry(f.options).registerChannel(port)).rejects.toThrow();
    expect(await readdir(f.registryDir)).toEqual([]);
  });

  it('registers and resolves on Linux', async () => {
    const f = await fixture();
    const registry = createChannelRegistry({ ...f.options, platform: 'linux' });
    const record = await registry.registerChannel();
    expect(record.claudePid).toBe(200);
    expect(await createChannelRegistry(f.options).resolveChannel(f.target)).toEqual(record);
  });

  describe('legacy registry directory (helpers started before the data folder moved)', () => {
    const legacy = async (f: Awaited<ReturnType<typeof fixture>>) => {
      const legacyRegistryDir = join(f.dir, 'legacy', 'claude-channels');
      await mkdir(legacyRegistryDir, { recursive: true, mode: 0o700 });
      return legacyRegistryDir;
    };

    it('finds a registration a legacy helper wrote into the recreated old folder', async () => {
      const f = await fixture();
      const legacyRegistryDir = await legacy(f);
      await f.seed(f.record, join(legacyRegistryDir, `${generation}.json`));
      const registry = createChannelRegistry({ ...f.options, legacyRegistryDir });
      expect(await registry.resolveChannel(f.target)).toEqual(f.record);
      expect(await readdir(f.registryDir)).toEqual([]);
    });

    it('still finds the current registration when the old folder is absent', async () => {
      const f = await fixture();
      await f.seed();
      const legacyRegistryDir = join(f.dir, 'legacy', 'claude-channels');
      const registry = createChannelRegistry({ ...f.options, legacyRegistryDir });
      expect(await registry.resolveChannel(f.target)).toEqual(f.record);
    });

    it('ignores a symlinked legacy registry directory', async () => {
      const f = await fixture();
      const real = join(f.dir, 'elsewhere');
      await mkdir(real, { mode: 0o700 });
      await f.seed(f.record, join(real, `${generation}.json`));
      await mkdir(join(f.dir, 'legacy'), { mode: 0o700 });
      const legacyRegistryDir = join(f.dir, 'legacy', 'claude-channels');
      await symlink(real, legacyRegistryDir);
      const registry = createChannelRegistry({ ...f.options, legacyRegistryDir });
      expect(await registry.resolveChannel(f.target)).toBeUndefined();
      // The unsafe legacy directory never hides a registration in the current one.
      const current = { ...f.record, generation: otherGeneration };
      await f.seed(current, join(f.registryDir, `${otherGeneration}.json`));
      expect(await registry.resolveChannel(f.target)).toEqual(current);
    });

    it('reads but never writes the legacy directory', async () => {
      const f = await fixture();
      const legacyRegistryDir = await legacy(f);
      const record = await createChannelRegistry({
        ...f.options,
        legacyRegistryDir,
      }).registerChannel();
      expect(await readdir(f.registryDir)).toEqual([`${record.generation}.json`]);
      expect(await readdir(legacyRegistryDir)).toEqual([]);
    });

    it('fails the whole lookup when the current registry directory is unsafe', async () => {
      const f = await fixture();
      const legacyRegistryDir = await legacy(f);
      await f.seed(f.record, join(legacyRegistryDir, `${generation}.json`));
      await rename(f.registryDir, f.registryDir + '.real');
      await symlink(f.registryDir + '.real', f.registryDir);
      const registry = createChannelRegistry({ ...f.options, legacyRegistryDir });
      expect(await registry.resolveChannel(f.target)).toBeUndefined();
    });

    it('records the ledger path the helper opened', async () => {
      const f = await fixture();
      const ledgerPath = join(f.dir, 'legacy', 'claude-channel-ledger.db');
      const record = await createChannelRegistry({ ...f.options, ledgerPath }).registerChannel();
      expect(record.ledgerPath).toBe(ledgerPath);
      expect(await createChannelRegistry(f.options).resolveChannel(f.target)).toEqual(record);
    });

    it('says which ledger path live helpers still use', async () => {
      const f = await fixture();
      const legacyRegistryDir = await legacy(f);
      const link = join(f.dir, 'legacy', 'claude-channel-ledger.db');
      const current = join(f.dir, 'state', 'claude-channel-ledger.db');
      let alive = true;
      const registry = createChannelRegistry({
        ...f.options,
        legacyRegistryDir,
        alive: (pid) => pid === 300 && alive,
      });
      expect(await registry.ledgerInUse(link)).toBe(false);
      // Written before 0.22: no ledgerPath, so it uses the old folder's ledger.
      await f.seed(f.record, join(legacyRegistryDir, `${generation}.json`));
      expect(await registry.ledgerInUse(link)).toBe(true);
      alive = false;
      expect(await registry.ledgerInUse(link)).toBe(false);
      alive = true;
      await rm(join(legacyRegistryDir, `${generation}.json`));
      await f.seed({ ...f.record, ledgerPath: current });
      expect(await registry.ledgerInUse(link)).toBe(false);
      await f.seed({ ...f.record, ledgerPath: link });
      expect(await registry.ledgerInUse(link)).toBe(true);
    });

    it('does not count one registration twice when both names are the same folder', async () => {
      const f = await fixture();
      await f.seed();
      const registry = createChannelRegistry({ ...f.options, legacyRegistryDir: f.registryDir });
      expect(await registry.resolveChannel(f.target)).toEqual(f.record);
    });
  });

  it('stays unsupported on a platform without verified probes', async () => {
    const f = await fixture();
    await f.seed();
    const registry = createChannelRegistry({ ...f.options, platform: 'win32' });
    expect(await registry.resolveChannel(f.target)).toBeUndefined();
    await expect(registry.registerChannel()).rejects.toThrow();
  });
});
