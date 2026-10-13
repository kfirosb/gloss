import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCodexAdapter } from '../../src/agents/codex/index.js';
import type { ProcessRunner } from '../../src/runtime/process-runner.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'codex-discovery-')));
  await mkdir(join(home, 'thread-writer-locks'));
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, rollout_path TEXT, cli_version TEXT, source TEXT, thread_source TEXT, agent_path TEXT, originator TEXT)');
  cleanups.push(async () => { db.close(); await rm(home, { recursive: true, force: true }); });
  const stale = new Set<string>();
  const runner: ProcessRunner = async function* (command, args, _input, signal) {
    if (command !== '/usr/sbin/lsof' || args[0] !== '-Fpcfn') throw new Error('Unexpected process');
    let found = false;
    for (const path of args.slice(2)) {
      const id = path.split('/').at(-1)!.replace('.lock', '');
      if (!signal.aborted && !stale.has(id)) {
        found = true;
        yield { type: 'line', line: 'p1234' }; yield { type: 'line', line: 'ccodex' };
        yield { type: 'line', line: 'f12' }; yield { type: 'line', line: `n${path}` };
      }
    }
    yield { type: 'exit', outcome: { code: found ? 0 : 1, signal: null, reason: signal.aborted ? 'cancelled' : 'exited', diagnostics: '' } };
  };
  async function add(n: number, source = 'cli', threadSource = 'user', version = '0.154.0', metadata = true, originator: string | null = 'codex-tui', agentPath: string | null = null) {
    const id = `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
    await writeFile(join(home, 'thread-writer-locks', `${id}.lock`), '');
    if (metadata) db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)').run(id, home, '/must-not-read-transcripts', version, source, threadSource, agentPath, originator);
    return id;
  }
  // Fake process table: pid -> [elapsed, args]. Lock owners 101 and 1234 are terminal clients holding their own locks.
  const processes = new Map<number, [string, string]>([[101, ['01:00', '/opt/codex/bin/codex']], [1234, ['01:00', '/opt/codex/bin/codex --model gpt']]]);
  const cwds = new Map<number, string>();
  const withProcesses = (inner: ProcessRunner): ProcessRunner => async function* (command, args, input, signal, options) {
    if (command === '/bin/ps') {
      for (const [pid, [elapsed, line]] of processes) yield { type: 'line', line: `${pid} ${elapsed} codex ${line}` };
      yield { type: 'exit', outcome: { code: 0, signal: null, reason: 'exited', diagnostics: '' } }; return;
    }
    if (command === '/usr/sbin/lsof' && args[0] === '-a') {
      const pids = args.at(-1)!.split(',').map(Number);
      for (const pid of pids) { const cwd = cwds.get(pid); if (cwd) { yield { type: 'line', line: `p${pid}` }; yield { type: 'line', line: 'fcwd' }; yield { type: 'line', line: `n${cwd}` }; } }
      yield { type: 'exit', outcome: { code: 0, signal: null, reason: 'exited', diagnostics: '' } }; return;
    }
    yield* inner(command, args, input, signal, options);
  };
  const scan = (signal = new AbortController().signal, override = runner, extra: Partial<Parameters<typeof createCodexAdapter>[0]> = {}) => createCodexAdapter({ codexHome: home, runner: withProcesses(override), ...extra }).discoverOpen?.(signal);
  return { home, db, stale, runner, add, scan, processes, cwds, withProcesses };
}
it('includes only verified interactive writers with exact identities', async () => {
  const f = await fixture(); const id = await f.add(1); const stale = await f.add(2); f.stale.add(stale);
  await f.add(3, 'exec'); await f.add(4, JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: id, depth: 1, agent_path: '/root/child' } } }), 'subagent');
  expect(await f.scan()).toEqual({ complete: true, candidates: [{ target: { agent: 'codex', sessionRef: id, projectId: f.home }, support: 'supported', nativePid: 1234 }] });
});
it('uses optional native titles without changing identity and tolerates malformed titles', async () => {
  const f = await fixture(); const id = await f.add(1); const other = await f.add(2);
  f.db.exec('ALTER TABLE threads ADD COLUMN title');
  f.db.prepare('UPDATE threads SET title = ?').run('  Same\u0001 title  ');
  let scan = await f.scan();
  expect(scan?.candidates.map(c => [c.target.sessionRef, c.sessionTitle])).toEqual([[id, 'Same title'], [other, 'Same title']]);
  f.db.prepare('UPDATE threads SET title = ? WHERE id = ?').run('Renamed', id);
  expect((await f.scan())?.candidates[0]).toMatchObject({target:{sessionRef:id,projectId:f.home},sessionTitle:'Renamed'});
  for (const title of [123, '\u0000\n', null]) {
    f.db.prepare('UPDATE threads SET title = ? WHERE id = ?').run(title, id);
    expect((await f.scan())?.candidates[0]?.sessionTitle).toBeUndefined();
  }
});
it('reports the thread creation time from the same metadata row, preferring milliseconds', async () => {
  const f = await fixture(); const a = await f.add(1); const b = await f.add(2); const c = await f.add(3);
  expect((await f.scan())?.candidates.every(candidate => candidate.createdAt === undefined)).toBe(true);
  f.db.exec('ALTER TABLE threads ADD COLUMN created_at INTEGER'); f.db.exec('ALTER TABLE threads ADD COLUMN created_at_ms INTEGER');
  f.db.prepare('UPDATE threads SET created_at = ? WHERE id = ?').run(1_700_000_000, a);
  f.db.prepare('UPDATE threads SET created_at = ?, created_at_ms = ? WHERE id = ?').run(1_700_000_000, 1_700_000_000_123, b);
  f.db.prepare('UPDATE threads SET created_at = ? WHERE id = ?').run('garbage', c);
  expect((await f.scan())?.candidates.map(candidate => [candidate.target.sessionRef, candidate.createdAt])).toEqual([[a, 1_700_000_000_000], [b, 1_700_000_000_123], [c, undefined]]);
});
it.each(['0.155.0', '0.160.0', '9.0.0'])('discovers a live user session independently of version %s', async protocol => {
  const f = await fixture(); const id = await f.add(1, 'cli', 'user', protocol);
  expect(await f.scan()).toMatchObject({ complete: true, candidates: [{ target: { agent: 'codex', sessionRef: id, projectId: f.home }, support: 'supported' }] });
});
it('retries a writer whose metadata has not appeared on the next scan', async () => {
  const f = await fixture(); const id = await f.add(1, 'cli', 'user', '0.154.0', false);
  expect(await f.scan()).toMatchObject({ complete: false, candidates: [], error: expect.any(String) });
  f.db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)').run(id, f.home, '/unread', '0.154.0', 'cli', 'user', null, 'codex-tui');
  expect(await f.scan()).toMatchObject({ complete: true, candidates: [{ target: { sessionRef: id } }] });
});
it('reports unknown origin instead of exposing it as a user session', async () => {
  const f = await fixture(); await f.add(1, 'unknown');
  expect(await f.scan()).toMatchObject({ complete: false, candidates: [], error: expect.stringMatching(/origin/i) });
});
it('reports enumeration failures instead of closing the catalog', async () => {
  const f = await fixture(); await rm(join(f.home, 'thread-writer-locks'), { recursive: true });
  expect(await f.scan()).toMatchObject({ complete: false, candidates: [], error: expect.any(String) });
});
it('reports ownership probe failure as incomplete', async () => {
  const f = await fixture(); await f.add(1);
  const broken: ProcessRunner = async function* () { yield { type: 'exit', outcome: { code: null, signal: null, reason: 'spawn-error', diagnostics: 'private diagnostic' } }; };
  expect(await f.scan(undefined, broken)).toMatchObject({ complete: false, candidates: [], error: expect.not.stringContaining('private diagnostic') });
});
it('cancels before enumeration and during writer verification without publishing late candidates', async () => {
  const f = await fixture(); await f.add(1); const controller = new AbortController(); controller.abort();
  expect(await f.scan(controller.signal)).toMatchObject({ complete: false, candidates: [], error: expect.stringMatching(/cancel/i) });
  const during = new AbortController();
  const cancelling: ProcessRunner = async function* (command, args, input, signal, options) { during.abort(); yield* f.runner(command, args, input, signal, options); };
  expect(await f.scan(during.signal, cancelling)).toMatchObject({ complete: false, candidates: [], error: expect.stringMatching(/cancel/i) });
});

it.each(['0.153.4', '0.157.1', '0.158.0', '0.159.3'])('admits the verified vscode TUI origin on %s but excludes exec and child origins', async protocol => {
  const f = await fixture(); const id = await f.add(1, 'vscode', 'user', protocol);
  await f.add(2, 'exec', 'user', protocol); await f.add(3, 'vscode', 'subagent', protocol);
  expect(await f.scan()).toEqual({ complete: true, candidates: [{ target: { agent: 'codex', sessionRef: id, projectId: f.home }, support: 'supported', nativePid: 1234 }] });
});
it.each([null, 'unknown-app'])('does not admit an unverified vscode originator: %s', async originator => {
  const f = await fixture(); await f.add(1, 'vscode', 'user', '0.157.1', true, originator);
  expect(await f.scan()).toMatchObject({ complete: false, candidates: [], error: expect.stringMatching(/origin/i) });
});
it('requires the exact Codex owner command for a supported origin', async () => {
  const f = await fixture(); await f.add(1, 'vscode', 'user', '0.157.1');
  const wrongOwner: ProcessRunner = async function* (command, args, input, signal, options) {
    for await (const event of f.runner(command, args, input, signal, options)) yield event.type === 'line' && event.line === 'ccodex' ? { type: 'line', line: 'cother' } : event;
  };
  expect(await f.scan(undefined, wrongOwner)).toEqual({ complete: true, candidates: [] });
});

it('uses one ownership snapshot and associates mixed process/file records with exact targets', async () => {
  const f = await fixture(); const [first, second, foreign, stale] = await Promise.all([1, 2, 3, 4].map(n => f.add(n)));
  const calls: string[][] = [];
  const runner: ProcessRunner = async function* (command, args) {
    expect(command).toBe('/usr/sbin/lsof'); calls.push(args);
    for (const line of [
      'p101', 'ccodex', 'f10', `n${join(f.home, 'thread-writer-locks', `${second}.lock`)}`,
      'f11', `n${join(f.home, 'thread-writer-locks', `${first}.lock`)}`,
      'p202', 'cforeign', 'f12', `n${join(f.home, 'thread-writer-locks', `${foreign}.lock`)}`,
    ]) yield { type: 'line', line };
    yield { type: 'exit', outcome: { code: 0, signal: null, reason: 'exited', diagnostics: '' } };
  };
  const result = await f.scan(undefined, runner);
  expect(result).toEqual({ complete: true, candidates: [first, second].map(sessionRef => ({ target: { agent: 'codex', sessionRef, projectId: f.home }, support: 'supported', nativePid: 101 })) });
  expect(calls).toHaveLength(1);
  expect(new Set(calls[0]!.slice(2))).toEqual(new Set([first, second, foreign, stale].map(id => join(f.home, 'thread-writer-locks', `${id}.lock`))));
});

it.each(['missing-command', 'missing-file', 'unknown-path', 'truncated-file', 'duplicate-name'])('marks malformed ownership %s incomplete without admitting an unverified writer', async kind => {
  const f = await fixture(); const id = await f.add(1); const path = join(f.home, 'thread-writer-locks', `${id}.lock`);
  const records: Record<string, string[]> = {
    'missing-command': ['p101', 'ccodex', 'f10', `n${path}`, 'p202', 'f11', `n${path}`],
    'missing-file': ['p101', 'ccodex', `n${path}`],
    'unknown-path': ['p101', 'ccodex', 'f10', `n${path}.other`],
    'truncated-file': ['p101', 'ccodex', 'f10'],
    'duplicate-name': ['p101', 'ccodex', 'f10', `n${path}`, `n${path}`],
  };
  const runner: ProcessRunner = async function* () {
    for (const line of records[kind]!) yield { type: 'line', line };
    yield { type: 'exit', outcome: { code: 0, signal: null, reason: 'exited', diagnostics: '' } };
  };
  expect(await f.scan(undefined, runner)).toMatchObject({ complete: false, candidates: [], error: expect.any(String) });
});

it.each(['timeout', 'output-limit', 'diagnostic'])('does not treat partial %s ownership output as complete evidence', async kind => {
  const f = await fixture(); const id = await f.add(1);
  const runner: ProcessRunner = async function* () {
    for (const line of ['p101', 'ccodex', 'f10', `n${join(f.home, 'thread-writer-locks', `${id}.lock`)}`]) yield { type: 'line', line };
    yield { type: 'exit', outcome: { code: kind === 'diagnostic' ? 1 : null, signal: null, reason: kind === 'diagnostic' ? 'exited' : kind as 'timeout' | 'output-limit', diagnostics: kind === 'diagnostic' ? 'private diagnostic' : '' } };
  };
  expect(await f.scan(undefined, runner)).toMatchObject({ complete: false, candidates: [], error: expect.not.stringContaining('private diagnostic') });
});

it('bounds batch arguments and preserves verified candidates when another batch fails', async () => {
  const f = await fixture(); for (let n = 1; n <= 130; n++) await f.add(n);
  const sizes: number[] = []; let failed = false;
  const runner: ProcessRunner = async function* (command, args, input, signal, options) {
    sizes.push(args.length - 2);
    expect(args.slice(2).reduce((sum, path) => sum + Buffer.byteLength(path) + 1, 0)).toBeLessThanOrEqual(65536);
    if (!failed) { failed = true; yield { type: 'exit', outcome: { code: null, signal: null, reason: 'spawn-error', diagnostics: '' } }; }
    else yield* f.runner(command, args, input, signal, options);
  };
  const result = await f.scan(undefined, runner);
  expect(sizes.sort((a,b) => a-b)).toEqual([2, 128]);
  expect(result?.complete).toBe(false); expect(result?.candidates).toHaveLength(2);
});

it.each([
  { signal: 'exec source', source: 'exec', threadSource: 'user', agentPath: null },
  { signal: 'structured subagent source', source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } }), threadSource: 'user', agentPath: null },
  { signal: 'structured internal source', source: JSON.stringify({ internal: 'language-worker' }), threadSource: 'user', agentPath: null },
  { signal: 'thread source', source: 'cli', threadSource: 'subagent', agentPath: null },
  { signal: 'agent path', source: 'cli', threadSource: 'user', agentPath: '/root/child' },
])('excludes a native writer using only its $signal evidence', async row => {
  const f = await fixture();
  const user = await f.add(1);
  await f.add(2, row.source, row.threadSource, '0.154.0', true, 'codex-tui', row.agentPath);
  expect(await f.scan()).toEqual({ complete: true, candidates: [{ target: { agent: 'codex', sessionRef: user, projectId: f.home }, support: 'supported', nativePid: 1234 }] });
});

describe('Codex 0.162 shared app-server daemon: a thread is open only while a terminal is attached', () => {
  const DAEMON = '/Users/u/.codex/packages/app-server-daemon/releases/0.162.1/bin/codex app-server --listen unix:// --managed-daemon';
  async function daemonFixture() {
    const f = await fixture();
    f.processes.set(1234, ['10:00:00', DAEMON]);
    const now = Date.now();
    const ids = [await f.add(1), await f.add(2)];
    f.db.exec('ALTER TABLE threads ADD COLUMN created_at_ms INTEGER');
    // Thread 1 was created 5 minutes ago, thread 2 one minute ago.
    f.db.prepare('UPDATE threads SET created_at_ms = ? WHERE id = ?').run(now - 300_000, ids[0]!);
    f.db.prepare('UPDATE threads SET created_at_ms = ? WHERE id = ?').run(now - 60_000, ids[1]!);
    const refs = async (extra = {}) => (await f.scan(undefined, undefined, extra))?.candidates.map(c => c.target.sessionRef);
    return { ...f, ids, refs };
  }
  it('treats a daemon-held lock with no attached terminal as closed', async () => {
    const f = await daemonFixture();
    expect(await f.scan()).toEqual({ complete: true, candidates: [] });
  });
  it('keeps a lock held by the terminal client itself open', async () => {
    const f = await daemonFixture(); f.processes.set(1234, ['00:30', '/opt/codex/bin/codex --dangerously-bypass-approvals-and-sandbox']);
    expect(await f.refs()).toEqual(f.ids);
  });
  it('opens only the newest daemon thread a client in the same folder could have started', async () => {
    const f = await daemonFixture();
    f.processes.set(555, ['02:00', `/opt/codex/bin/codex ${'Reply with READY only. Do not run commands.'}`]); f.cwds.set(555, f.home);
    expect(await f.refs()).toEqual([f.ids[1]]);
    // A client started after both threads were created cannot be attached to either.
    f.processes.set(555, ['00:10', '/opt/codex/bin/codex']);
    expect(await f.refs()).toEqual([]);
    // A client elsewhere is not attached either.
    f.processes.set(555, ['02:00', '/opt/codex/bin/codex']); f.cwds.set(555, '/elsewhere');
    expect(await f.refs()).toEqual([]);
  });
  it('opens a daemon thread named exactly by `codex resume <id>`', async () => {
    const f = await daemonFixture();
    f.processes.set(556, ['00:05', `/opt/codex/bin/codex -m gpt resume ${f.ids[0]}`]);
    expect(await f.refs()).toEqual([f.ids[0]]);
  });
  it('never counts daemon, queue or exec processes as attached terminals', async () => {
    const f = await daemonFixture();
    for (const [pid, line] of [[601, '/opt/codex/bin/codex queue --thread x --message=hi'], [602, '/opt/codex/bin/codex exec hi'], [603, '/opt/codex/bin/codex app-server daemon pid-update-loop']] as const) { f.processes.set(pid, ['20:00', line]); f.cwds.set(pid, f.home); }
    expect(await f.refs()).toEqual([]);
  });
  it('follows the launch: open while its tmux session runs, closed once it ended', async () => {
    const f = await daemonFixture();
    expect(await f.refs({ launched: (ref: string) => ref === f.ids[0] ? true : undefined })).toEqual([f.ids[0]]);
    // An ended launch stays closed even if an unrelated client sits in the same folder.
    f.processes.set(555, ['10:00', '/opt/codex/bin/codex']); f.cwds.set(555, f.home);
    expect(await f.refs({ launched: (ref: string) => ref === f.ids[1] ? false : undefined })).toEqual([f.ids[0]]);
  });
  it('reports an incomplete scan when the process table cannot be read', async () => {
    const f = await daemonFixture();
    const noPs: ProcessRunner = async function* (command, args, input, signal, options) {
      if (command === '/bin/ps') { yield { type: 'exit', outcome: { code: null, signal: null, reason: 'spawn-error', diagnostics: '' } }; return; }
      yield* f.runner(command, args, input, signal, options);
    };
    expect(await createCodexAdapter({ codexHome: f.home, runner: noPs }).discoverOpen?.(new AbortController().signal)).toMatchObject({ complete: false, candidates: [] });
  });
});
