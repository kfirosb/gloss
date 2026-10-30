import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listCodexPastSessions } from '../../src/agents/codex/past-sessions.js';
import { threadOrigin } from '../../src/agents/codex/discovery.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function db() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gloss-codex-past-')));
  dirs.push(root);
  const folder = join(root, 'proj');
  await mkdir(folder);
  const other = join(root, 'other');
  await mkdir(other);
  const path = join(root, 'state_5.sqlite');
  const d = new DatabaseSync(path);
  d.exec(
    'CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, rollout_path TEXT, cli_version TEXT, source TEXT, thread_source TEXT, agent_path TEXT, originator TEXT, title TEXT, first_user_message TEXT, updated_at INTEGER, archived INTEGER, git_branch TEXT)',
  );
  const ins = d.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const row = (id: string, o: Partial<Record<string, unknown>> = {}) =>
    ins.run(
      id,
      (o.cwd ?? folder) as string,
      '/r',
      '0.162.1',
      (o.source ?? '"cli"') as string,
      (o.thread_source ?? 'user') as string,
      (o.agent_path ?? null) as string | null,
      (o.originator ?? 'codex-tui') as string,
      (o.title ?? '') as string,
      (o.first_user_message ?? 'hello') as string,
      (o.updated_at ?? 1_700_000_000) as number,
      (o.archived ?? 0) as number,
      (o.git_branch ?? null) as string | null,
    );
  return { path, folder, other, row, close: () => d.close() };
}

it('classifies thread origins', () => {
  expect(
    threadOrigin({ source: '"cli"', thread_source: 'user', agent_path: null, originator: null }),
  ).toBe('user');
  expect(
    threadOrigin({ source: '"exec"', thread_source: 'user', agent_path: null, originator: null }),
  ).toBe('internal');
  expect(
    threadOrigin({
      source: '"vscode"',
      thread_source: 'user',
      agent_path: null,
      originator: 'other',
    }),
  ).toBe('unknown');
});
it('lists user threads of the folder, newest first, with title fallback and branch', async () => {
  const f = await db();
  f.row('t-old', { title: 'Old', updated_at: 1_700_000_000, git_branch: 'main' });
  f.row('t-new', { title: '', first_user_message: 'Add tests', updated_at: 1_700_000_100 });
  f.close();
  expect(await listCodexPastSessions(f.path, f.folder)).toEqual([
    { agent: 'codex', sessionRef: 't-new', title: 'Add tests', lastActiveAt: 1_700_000_100_000 },
    {
      agent: 'codex',
      sessionRef: 't-old',
      title: 'Old',
      branch: 'main',
      lastActiveAt: 1_700_000_000_000,
    },
  ]);
});
it('skips archived, promptless, non-user and other-folder threads', async () => {
  const f = await db();
  f.row('archived', { archived: 1 });
  f.row('empty', { first_user_message: '' });
  f.row('exec', { source: '"exec"' });
  f.row('sub', { thread_source: 'subagent' });
  f.row('elsewhere', { cwd: f.other });
  f.row('keep');
  f.close();
  expect((await listCodexPastSessions(f.path, f.folder)).map((e) => e.sessionRef)).toEqual([
    'keep',
  ]);
});
it('returns nothing when the database cannot be opened', async () => {
  expect(await listCodexPastSessions('/nonexistent/state_5.sqlite', process.cwd())).toEqual([]);
});
