import { afterEach, expect, it, vi } from 'vitest';
import { connect } from 'node:net';
import { createApplication } from '../../src/runtime/application.js';
import { startServer } from '../../src/runtime/http-server.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});
const fakeLauncher = (over: Record<string, unknown> = {}) => ({
  launch: vi.fn(async (input: any) => ({
    id: 'L1',
    ...input,
    panePid: 2,
    state: 'starting',
    createdAt: 0,
  })),
  run: vi.fn(async (input: any) => ({
    launch: {
      id: 'T1',
      agent: 'shell',
      folder: input.folder,
      title: 'Terminal',
      state: 'running',
      panePid: 3,
      createdAt: 0,
      busy: true,
    },
    reused: false,
    typed: true,
  })),
  list: () => [
    { id: 'L1', agent: 'claude' },
    { id: 'T1', agent: 'shell', folder: '/p' },
  ],
  reconcile: vi.fn(async () => {}),
  end: vi.fn(async () => {}),
  identify: vi.fn(async (id: string) => {
    if (id !== 'L1') throw Object.assign(new Error('Unknown launch'), { code: 'unknown-session' });
  }),
  watch: vi.fn(),
  subscribe: () => () => {},
  close: vi.fn(),
  ...over,
});
async function setup(
  launcher: any,
  terminals: any = {
    issueTicket: () => ({ ticket: 't', expiresAt: 1 }),
    handleUpgrade: () => {},
    close: () => {},
  },
  extra: Record<string, unknown> = {},
) {
  const store = new SqliteStore(':memory:');
  const app = createApplication({
    store,
    agents: [new FakeAgent()],
    conversationId: 'A',
    capability: 'cap',
    languageBackends: {
      codex: { open: vi.fn(async () => new FakeLanguageSession()), models: async () => [] },
    },
    launcher,
    terminals,
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
  cleanup.push(async () => {
    await server.close();
    await app.close();
  });
  return { request, app, store, port: Number(new URL(server.url).port) };
}
function rawUpgrade(port: number, path: string, host: string) {
  return new Promise<string>((resolve) => {
    const socket = connect(port, '127.0.0.1');
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('close', () => resolve(data));
    socket.on('error', () => resolve(data));
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    setTimeout(() => socket.destroy(), 1000);
  });
}
it('launch routes require the capability and pass only agent, folder and a validated language override', async () => {
  const launcher = fakeLauncher();
  const { request } = await setup(launcher);
  expect((await request('launches', 'POST', { agent: 'claude', folder: '/p' }, false)).status).toBe(
    401,
  );
  expect(
    (
      await request('launches', 'POST', {
        agent: 'claude',
        folder: '/p',
        argv: ['rm'],
        executable: '/bin/sh',
      })
    ).status,
  ).toBe(200);
  expect(launcher.launch).toHaveBeenLastCalledWith({ agent: 'claude', folder: '/p' });
  expect(
    (
      await request('launches', 'POST', {
        agent: 'codex',
        folder: '/p',
        languageOverride: { reply: 'en' },
        argv: ['x'],
      })
    ).status,
  ).toBe(200);
  expect(launcher.launch).toHaveBeenLastCalledWith({
    agent: 'codex',
    folder: '/p',
    languageOverride: { reply: 'en' },
  });
  expect(await (await request('launches/L1/terminal-ticket', 'POST', {})).json()).toEqual({
    ticket: 't',
    expiresAt: 1,
  });
  expect(await (await request('launches')).json()).toEqual([
    { id: 'L1', agent: 'claude' },
    { id: 'T1', agent: 'shell', folder: '/p' },
  ]);
  expect((await request('launches/L1/end', 'POST', {})).status).toBe(200);
  expect(launcher.end).toHaveBeenCalledWith('L1');
});
it('retries identification of a launch behind the capability, with 404 for unknown or ended launches', async () => {
  const launcher = fakeLauncher();
  const { request } = await setup(launcher);
  expect((await request('launches/L1/identify', 'POST', {}, false)).status).toBe(401);
  expect(launcher.identify).not.toHaveBeenCalled();
  expect((await request('launches/L1/identify', 'POST', {})).status).toBe(202);
  expect(launcher.identify).toHaveBeenCalledWith('L1');
  const missing = await request('launches/ghost/identify', 'POST', {});
  expect(missing.status).toBe(404);
  expect((await missing.json()).code).toBe('unknown-session');
  expect((await request('launches/L1/identify')).status).toBe(404);
});
it('rejects an invalid language override without launching', async () => {
  const launcher = fakeLauncher();
  const { request } = await setup(launcher);
  for (const bad of [{ reply: 'xx' }, 'he', [1]])
    expect(
      (await request('launches', 'POST', { agent: 'claude', folder: '/p', languageOverride: bad }))
        .status,
    ).toBe(400);
  expect(launcher.launch).not.toHaveBeenCalled();
});
it('maps tmux-unavailable to a clear 400', async () => {
  const { request } = await setup(
    fakeLauncher({
      launch: async () => {
        throw Object.assign(new Error('tmux is not installed.'), { code: 'tmux-unavailable' });
      },
    }),
  );
  const res = await request('launches', 'POST', { agent: 'codex', folder: '/p' });
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe('tmux-unavailable');
});
it('reads and replaces launch settings', async () => {
  const { request } = await setup(fakeLauncher());
  expect((await request('settings/launch', 'GET', undefined, false)).status).toBe(401);
  expect(await (await request('settings/launch')).json()).toEqual({
    extraArgs: { claude: [], codex: [] },
    popup: 'auto',
    terminalView: 'popup',
  });
  const next = {
    extraArgs: { claude: ['--x'], codex: [] },
    popup: 'dot-only',
    terminalView: 'popup',
  };
  expect(await (await request('settings/launch', 'PUT', next)).json()).toEqual(next);
  expect((await request('settings/launch', 'PUT', { popup: 'nope', extraArgs: {} })).status).toBe(
    400,
  );
  expect(await (await request('settings/launch')).json()).toEqual(next);
});
it('splits extra-argument strings per agent with the launcher quoting rules', async () => {
  const { request } = await setup(fakeLauncher());
  const put = await request('settings/launch', 'PUT', {
    extraArgs: { claude: '--model "opus 4" --x', codex: '' },
    popup: 'auto',
  });
  expect(await put.json()).toEqual({
    extraArgs: { claude: ['--model', 'opus 4', '--x'], codex: [] },
    popup: 'auto',
    terminalView: 'popup',
  });
  expect(
    (
      await request('settings/launch', 'PUT', {
        extraArgs: { claude: '"open', codex: '' },
        popup: 'auto',
      })
    ).status,
  ).toBe(400);
});
it('routes only loopback /api/launches upgrades to the terminal bridge', async () => {
  const seen: string[] = [];
  const handleUpgrade = vi.fn((req: any, socket: any) => {
    seen.push(req.url);
    socket.end('HTTP/1.1 101 Switching Protocols\r\n\r\n');
  });
  const { port } = await setup(fakeLauncher(), {
    issueTicket: () => ({ ticket: 't', expiresAt: 1 }),
    handleUpgrade,
    close: () => {},
  });
  expect(
    await rawUpgrade(port, '/api/launches/L1/terminal?ticket=t', `127.0.0.1:${port}`),
  ).toContain('101');
  expect(seen).toEqual(['/api/launches/L1/terminal?ticket=t']);
  expect(await rawUpgrade(port, '/api/events', `127.0.0.1:${port}`)).toBe('');
  expect(await rawUpgrade(port, '/api/launches/L1/terminal?ticket=t', 'evil.example')).toBe('');
  expect(handleUpgrade).toHaveBeenCalledTimes(1);
});
it('closes without a bridge and tears down launcher services with the application', async () => {
  const launcher = fakeLauncher();
  const close = vi.fn();
  const attentionStart = vi.fn();
  const attentionClose = vi.fn();
  const store = new SqliteStore(':memory:');
  const app = createApplication({
    store,
    agents: [new FakeAgent()],
    conversationId: 'A',
    capability: 'cap',
    languageBackends: {},
    launcher: launcher as any,
    terminals: {
      issueTicket: () => ({ ticket: 't', expiresAt: 1 }),
      handleUpgrade: () => {},
      close,
    },
    attention: {
      start: attentionStart,
      markers: async () => undefined,
      current: () => new Map(),
      subscribe: () => () => {},
      close: attentionClose,
    },
  });
  await app.restore!();
  expect(launcher.reconcile).toHaveBeenCalled();
  expect(attentionStart).toHaveBeenCalled();
  expect(launcher.watch).toHaveBeenCalled();
  await app.close();
  expect(close).toHaveBeenCalled();
  expect(attentionClose).toHaveBeenCalled();
  expect(launcher.close).toHaveBeenCalled();
});

it('approves only real absolute directories picked in the native folder dialog', async () => {
  const { mkdtempSync, writeFileSync, realpathSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'folder-'));
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'x');
  const link = join(tmpdir(), 'link-' + Date.now());
  symlinkSync(dir, link);
  const approved: string[] = [];
  const { request } = await setup(fakeLauncher(), undefined, {
    approveLaunchFolder: (f: string) => {
      approved.push(f);
    },
  });
  expect((await request('launch-folders', 'POST', { folder: dir }, false)).status).toBe(401);
  expect((await request('launch-folders', 'POST', { folder: 'relative/dir' })).status).toBe(400);
  expect((await request('launch-folders', 'POST', { folder: file })).status).toBe(400);
  expect((await request('launch-folders', 'POST', { folder: join(dir, 'missing') })).status).toBe(
    400,
  );
  expect(approved).toEqual([]);
  const ok = await request('launch-folders', 'POST', { folder: link });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ folder: realpathSync(dir) });
  expect(approved).toEqual([realpathSync(dir)]);
});
it('forwards a first message as prompt and nothing else new', async () => {
  const launcher = fakeLauncher();
  const { request } = await setup(launcher);
  expect(
    (
      await request('launches', 'POST', {
        agent: 'claude',
        folder: '/p',
        prompt: 'Fix the tests',
        argv: ['rm'],
      })
    ).status,
  ).toBe(200);
  expect(launcher.launch).toHaveBeenLastCalledWith({
    agent: 'claude',
    folder: '/p',
    prompt: 'Fix the tests',
  });
  expect((await request('launches', 'POST', { agent: 'shell', folder: '/p' })).status).toBe(200);
  expect(launcher.launch).toHaveBeenLastCalledWith({ agent: 'shell', folder: '/p' });
});
it('run endpoint requires the capability and passes folder, command and origin only', async () => {
  const launcher = fakeLauncher();
  const { request } = await setup(launcher);
  expect(
    (await request('launches/run', 'POST', { folder: '/p', command: 'ls' }, false)).status,
  ).toBe(401);
  const res = await request('launches/run', 'POST', {
    folder: '/p',
    command: 'npm test',
    originSessionId: 'S1',
    argv: ['x'],
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ reused: false, typed: true, launch: { id: 'T1' } });
  expect(launcher.run).toHaveBeenLastCalledWith({
    folder: '/p',
    command: 'npm test',
    originSessionId: 'S1',
  });
  expect((await request('launches/run', 'POST', { folder: '/p' })).status).toBe(400);
  const big = await request('launches/run', 'POST', { folder: '/p', command: 'x'.repeat(9000) });
  expect(big.status).toBe(400);
});
it('identify refuses a terminal with 400', async () => {
  const launcher = fakeLauncher();
  const { request } = await setup(launcher);
  const res = await request('launches/T1/identify', 'POST', {});
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe('Terminals have nothing to identify');
  expect(launcher.identify).not.toHaveBeenCalled();
});

it('lists past sessions of a folder through the service', async () => {
  const pastSessions = {
    list: vi.fn(async (folder: unknown) => ({ folder, entries: [] })),
    invalidate: vi.fn(),
    close: vi.fn(),
  };
  const { request } = await setup(fakeLauncher(), undefined, { pastSessions });
  const res = await request('/api/past-sessions?folder=%2Fp');
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(await res.json()).toEqual({ folder: '/p', entries: [] });
  expect(pastSessions.list).toHaveBeenCalledWith('/p');
});
it('reopens a session with only agent, id and folder forwarded', async () => {
  const prepareResume = vi.fn(async (input: any) => ({ ...input, cwd: input.folder, argv: [] }));
  const resume = vi.fn(async (p: any) => ({
    id: 'R1',
    agent: p.agent,
    folder: p.cwd,
    panePid: 9,
    state: 'starting',
    createdAt: 0,
    sessionRef: p.sessionRef,
  }));
  const { request } = await setup(fakeLauncher({ prepareResume, resume }));
  const res = await request('/api/launches/resume', 'POST', {
    agent: 'codex',
    sessionRef: 'T',
    folder: '/p',
    argv: ['evil'],
  });
  expect(res.status).toBe(200);
  expect(prepareResume).toHaveBeenCalledWith({ agent: 'codex', sessionRef: 'T', folder: '/p' });
  expect(await res.json()).toMatchObject({ id: 'R1', agent: 'codex' });
});
it('hides a past conversation that has no panel', async () => {
  const { request, store } = await setup(fakeLauncher());
  const res = await request('/api/past-sessions/hide', 'POST', {
    agent: 'claude',
    sessionRef: 'c-9',
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ hidden: true });
  expect(store.listHiddenSessions()).toEqual([{ agent: 'claude', sessionRef: 'c-9' }]);
});
it('rejects a reopen with an unknown agent', async () => {
  const { request } = await setup(fakeLauncher());
  const res = await request('/api/launches/resume', 'POST', {
    agent: 'shell',
    sessionRef: 'T',
    folder: '/p',
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe('Invalid agent');
});
