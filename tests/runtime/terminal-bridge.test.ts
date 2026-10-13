import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createTerminalBridge, nodePty, type PtyProcess } from '../../src/runtime/terminal-bridge.js';
import { createTmux, locateTmux } from '../../src/runtime/tmux.js';

const closers: (() => void)[] = []; afterEach(() => { for (const c of closers.splice(0)) c(); });
function fakePty() { const handlers: ((d: Buffer) => void)[] = []; const exits: (() => void)[] = []; const writes: string[] = []; let killed = false;
  let pauses = 0, resumes = 0;
  const p: PtyProcess = { pause: () => { pauses++; }, resume: () => { resumes++; }, onData: cb => handlers.push(cb), write: d => writes.push(String(d)), kill: () => { killed = true; exits.forEach(e => e()); }, onExit: cb => exits.push(cb) };
  return { p, emit: (s: string) => handlers.forEach(h => h(Buffer.from(s))), writes, get killed() { return killed; }, get pauses() { return pauses; }, get resumes() { return resumes; } }; }
async function setup(t = 0, overrides: { spawnPty?: (argv: string[]) => PtyProcess; tmux?: () => Promise<any> } = {}) {
  let clock = t; const pty = fakePty(); const resizes: number[][] = []; const spawned: string[][] = [];
  const bridge = createTerminalBridge({ tmux: overrides.tmux ?? (async () => ({ attachArgv: (n: string) => ['tmux', 'attach', n], resizeWindow: async (_n: string, c: number, r: number) => { resizes.push([c, r]); } } as any)),
    launches: () => [{ id: 'L1', agent: 'claude', folder: '/p', panePid: 2, state: 'running', createdAt: 0 }], now: () => clock, spawnPty: overrides.spawnPty ?? (argv => { spawned.push(argv); return pty.p; }) });
  const server = createServer(); server.on('upgrade', (req, s, h) => bridge.handleUpgrade(req, s, h));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const port = (server.address() as any).port;
  closers.push(() => { bridge.close(); server.close(); });
  const connect = (path: string) => new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { origin: `http://127.0.0.1:${port}` } });
  return { bridge, connect, port, pty, resizes, spawned, advance: (ms: number) => { clock += ms; } };
}
const opened = (ws: WebSocket) => new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); ws.once('unexpected-response', (_q, r) => rej(new Error(String(r.statusCode)))); });

it('streams output, forwards input and resize, and kills the attach client on close', async () => {
  const { bridge, connect, pty, resizes, spawned } = await setup();
  const ws = connect(`/api/launches/L1/terminal?ticket=${bridge.issueTicket('L1').ticket}`); await opened(ws);
  expect(spawned[0]).toEqual(['tmux', 'attach', 'la-L1']);
  const got = new Promise<string>(r => ws.once('message', d => r(String(d)))); pty.emit('hello'); expect(await got).toBe('hello');
  ws.send(JSON.stringify({ type: 'input', data: 'y' })); ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  await new Promise(r => setTimeout(r, 50));
  expect(pty.writes).toEqual(['y']); expect(resizes).toEqual([[100, 30]]);
  ws.close(); await new Promise(r => setTimeout(r, 50)); expect(pty.killed).toBe(true);
});
it('rejects reused, expired, wrong-launch and missing tickets without spawning', async () => {
  const { bridge, connect, spawned, advance } = await setup();
  const t = bridge.issueTicket('L1').ticket; const first = connect(`/api/launches/L1/terminal?ticket=${t}`); await opened(first); first.close();
  await expect(opened(connect(`/api/launches/L1/terminal?ticket=${t}`))).rejects.toThrow('401');
  const late = bridge.issueTicket('L1').ticket; advance(31_000);
  await expect(opened(connect(`/api/launches/L1/terminal?ticket=${late}`))).rejects.toThrow('401');
  await expect(opened(connect(`/api/launches/L2/terminal?ticket=${bridge.issueTicket('L1').ticket}`))).rejects.toThrow('401');
  await expect(opened(connect(`/api/launches/L1/terminal`))).rejects.toThrow('401');
  expect(spawned).toHaveLength(1);
});
it('refuses tickets for unknown launches', async () => {
  const { bridge } = await setup();
  expect(() => bridge.issueTicket('missing')).toThrow('Unknown launch');
});

const ticketed = async (s: Awaited<ReturnType<typeof setup>>) => { const ws = s.connect(`/api/launches/L1/terminal?ticket=${s.bridge.issueTicket('L1').ticket}`); await opened(ws); return ws; };
const closedP = (ws: WebSocket) => new Promise<number>(r => ws.once('close', c => r(c)));
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

it('survives an oversized client frame and kills the pty', async () => {
  const crashes: unknown[] = []; const on = (e: unknown) => { crashes.push(e); }; process.on('uncaughtException', on);
  try {
    const s = await setup(); const ws = await ticketed(s); const closed = closedP(ws);
    ws.send(JSON.stringify({ type: 'input', data: 'x'.repeat(70 * 1024) }));
    await closed; await wait(50);
    expect(crashes).toEqual([]); expect(s.pty.killed).toBe(true); expect(s.pty.writes).toEqual([]);
  } finally { process.off('uncaughtException', on); }
});
it('closes the socket with 1011 when spawning throws or tmux rejects', async () => {
  for (const overrides of [{ spawnPty: () => { throw new Error('posix_spawnp failed'); } }, { tmux: async () => { throw new Error('no tmux'); } }]) {
    const s = await setup(0, overrides); const ws = s.connect(`/api/launches/L1/terminal?ticket=${s.bridge.issueTicket('L1').ticket}`);
    const closed = closedP(ws); await opened(ws).catch(() => undefined);
    expect(await closed).toBe(1011);
  }
});
it('pauses the pty under output backpressure and terminates past the hard cap', async () => {
  const s = await setup(); const ws = await ticketed(s); const closed = closedP(ws);
  (ws as any)._socket.pause();
  const chunk = 'x'.repeat(512 * 1024);
  for (let i = 0; i < 100 && !s.pty.pauses; i++) { s.pty.emit(chunk); await wait(5); }
  expect(s.pty.pauses).toBeGreaterThan(0);
  for (let i = 0; i < 100; i++) s.pty.emit(chunk);
  (ws as any)._socket.resume(); await closed; expect(s.pty.killed).toBe(true);
});
it('terminates a client that floods frames beyond the rate limit', async () => {
  const s = await setup(); const ws = await ticketed(s); const closed = closedP(ws);
  for (let i = 0; i < 1000; i++) ws.send(JSON.stringify({ type: 'input', data: 'a' }));
  await closed; expect(s.pty.killed).toBe(true); expect(s.pty.writes.length).toBeLessThanOrEqual(400);
});
it('rejects a foreign origin with 403 and does not spawn', async () => {
  const s = await setup(); const port = s.port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/launches/L1/terminal?ticket=${s.bridge.issueTicket('L1').ticket}`, { headers: { origin: 'https://evil.example' } });
  await expect(opened(ws)).rejects.toThrow('403'); expect(s.spawned).toHaveLength(0);
});

const available = await locateTmux().then(() => true, () => false);
const ps = () => new Promise<string>(res => execFile('ps', ['-ax', '-o', 'pid,command'], (_e, out) => res(out)));
describe.skipIf(!available)('with real tmux and node-pty', () => {
  it('detaches without killing the tmux session when the socket closes', async () => {
    const state = await realpath(await mkdtemp(join(tmpdir(), 'la-bridge-')));
    const tmux = await createTmux({ stateDir: state });
    try {
      await tmux.newSession('la-R1', state, ['sh', '-c', 'yes | head -c 5000000; sleep 30']);
      const bridge = createTerminalBridge({ tmux: async () => tmux, launches: () => [{ id: 'R1', agent: 'claude', folder: state, panePid: 2, state: 'running', createdAt: 0 }] });
      const server = createServer(); server.on('upgrade', (req, s, h) => bridge.handleUpgrade(req, s, h));
      await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const port = (server.address() as any).port;
      closers.push(() => { bridge.close(); server.close(); });
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/launches/R1/terminal?ticket=${bridge.issueTicket('R1').ticket}`, { headers: { origin: `http://127.0.0.1:${port}` } });
      await new Promise<void>((res, rej) => { ws.once('message', () => res()); ws.once('error', rej); });
      expect((await ps()).split('\n').some(l => l.includes('attach-session') && l.includes('la-R1'))).toBe(true);
      ws.close();
      expect(await tmux.hasSession('la-R1')).toBe(true);
      const deadline = Date.now() + 2000; let remaining = true;
      while (Date.now() < deadline) { remaining = (await ps()).split('\n').some(l => l.includes('attach-session') && l.includes('la-R1')); if (!remaining) break; await new Promise(r => setTimeout(r, 100)); }
      expect(remaining).toBe(false);
      expect(await tmux.hasSession('la-R1')).toBe(true);
    } finally {
      await new Promise<void>(r => execFile(tmux.executable, ['-S', tmux.socket, 'kill-server'], () => r()));
      await rm(state, { recursive: true, force: true });
    }
  }, 15000);
});
it('attaches without an enclosing TMUX or the panel capability in the client environment', () => {
  const saved = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE, LANGUAGE_PANEL_CAPABILITY: process.env.LANGUAGE_PANEL_CAPABILITY };
  Object.assign(process.env, { TMUX: '/tmp/outer,1,0', TMUX_PANE: '%1', LANGUAGE_PANEL_CAPABILITY: 'secret' });
  let seen: { file: string; args: string[]; env: Record<string, string | undefined> } | undefined;
  try {
    const spawn = ((file: string, args: string[], opts: { env: Record<string, string> }) => { seen = { file, args, env: opts.env }; return { onExit: () => ({ dispose() {} }), onData: () => ({ dispose() {} }) }; }) as any;
    nodePty(['/bin/tmux', 'attach-session', '-t', '=la-x'], 80, 24, spawn);
  } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  expect(seen!.file).toBe('/bin/tmux'); expect(seen!.args).toEqual(['attach-session', '-t', '=la-x']);
  expect(seen!.env).not.toHaveProperty('TMUX'); expect(seen!.env).not.toHaveProperty('TMUX_PANE'); expect(seen!.env).not.toHaveProperty('LANGUAGE_PANEL_CAPABILITY');
  expect(seen!.env.TERM).toBe('xterm-256color'); expect(seen!.env.PATH).toBe(process.env.PATH);
});
