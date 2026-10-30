// tests/adapters/claude-past-sessions.test.ts
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, realpath, rm, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeProjectSlug,
  listClaudePastSessions,
  CLAUDE_PAST_HEAD_BYTES,
  CLAUDE_PAST_TAIL_BYTES,
} from '../../src/agents/claude/past-sessions.js';
import { CLAUDE_SETUP_PROMPT } from '../../src/core/session-contracts.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';
const rec = (o: object) => JSON.stringify(o) + '\n';
async function home() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gloss-claude-past-')));
  dirs.push(root);
  const folder = join(root, 'my.project');
  await mkdir(folder);
  const config = join(root, 'config');
  const dir = join(config, 'projects', claudeProjectSlug(folder));
  await mkdir(dir, { recursive: true });
  return { folder, config, dir };
}

it('maps a folder to Claude’s project slug', () => {
  expect(claudeProjectSlug('/Users/k/.superset/projects/gl299.PNrp')).toBe(
    '-Users-k--superset-projects-gl299-PNrp',
  );
  expect(claudeProjectSlug("/a b/it's")).toBe('-a-b-it-s');
});
it('lists transcripts of the folder with title, branch and time; newest title record wins', async () => {
  const { folder, config, dir } = await home();
  const body =
    rec({ type: 'mode', sessionId: ID1 }) +
    rec({
      type: 'user',
      cwd: folder,
      gitBranch: 'main',
      sessionId: ID1,
      timestamp: '2026-10-30T08:00:00Z',
      message: { role: 'user', content: CLAUDE_SETUP_PROMPT },
    }) +
    rec({
      type: 'user',
      cwd: folder,
      sessionId: ID1,
      message: { role: 'user', content: 'Fix the login bug' },
    }) +
    rec({ type: 'ai-title', aiTitle: 'Old title', sessionId: ID1 }) +
    rec({ type: 'ai-title', aiTitle: 'Login fix', sessionId: ID1 });
  await writeFile(join(dir, `${ID1}.jsonl`), body);
  await utimes(join(dir, `${ID1}.jsonl`), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  expect(await listClaudePastSessions(config, folder)).toEqual([
    {
      agent: 'claude',
      sessionRef: ID1,
      title: 'Login fix',
      branch: 'main',
      lastActiveAt: 1_700_000_000_000,
    },
  ]);
});
it('falls back to the first prompt that is not the setup prompt', async () => {
  const { folder, config, dir } = await home();
  await writeFile(
    join(dir, `${ID1}.jsonl`),
    rec({ type: 'user', cwd: folder, sessionId: ID1, message: { content: CLAUDE_SETUP_PROMPT } }) +
      rec({
        type: 'user',
        cwd: folder,
        sessionId: ID1,
        message: { content: [{ type: 'text', text: 'Rename the module' }] },
      }),
  );
  expect((await listClaudePastSessions(config, folder))[0]?.title).toBe('Rename the module');
});

const user = (folder: string, id: string, content: unknown = 'hello') =>
  rec({ type: 'user', cwd: folder, sessionId: id, message: { content } });

it('skips a directory named like a transcript', async () => {
  const { folder, config, dir } = await home();
  await mkdir(join(dir, `${ID2}.jsonl`));
  expect(await listClaudePastSessions(config, folder)).toEqual([]);
});
it('skips subagent directories, the memory directory and non-uuid file names', async () => {
  const { folder, config, dir } = await home();
  await mkdir(join(dir, ID2));
  await writeFile(join(dir, ID2, `${ID3}.jsonl`), user(folder, ID3));
  await mkdir(join(dir, 'memory'));
  await writeFile(join(dir, 'notes.jsonl'), user(folder, ID1));
  expect(await listClaudePastSessions(config, folder)).toEqual([]);
});
it('skips a file without a user record', async () => {
  const { folder, config, dir } = await home();
  await writeFile(join(dir, `${ID3}.jsonl`), rec({ type: 'file-history-snapshot', cwd: folder }));
  expect(await listClaudePastSessions(config, folder)).toEqual([]);
});
it('lists a transcript whose only prompt is the setup prompt, without a title', async () => {
  const { folder, config, dir } = await home();
  await writeFile(join(dir, `${ID3}.jsonl`), user(folder, ID3, CLAUDE_SETUP_PROMPT));
  const [entry, ...rest] = await listClaudePastSessions(config, folder);
  expect(rest).toEqual([]);
  expect(entry).toMatchObject({ agent: 'claude', sessionRef: ID3 });
  expect(entry).not.toHaveProperty('title');
});
it('skips a transcript of another existing folder that shares the slug', async () => {
  const { folder, config, dir } = await home();
  const other = folder.replace('my.project', 'my-project');
  await mkdir(other);
  await writeFile(join(dir, `${ID1}.jsonl`), user(other, ID1));
  expect(await listClaudePastSessions(config, folder)).toEqual([]);
});
it('lists a transcript whose cwd is a symlink to the folder', async () => {
  const { folder, config, dir } = await home();
  const alias = join(folder, '..', 'alias');
  await symlink(folder, alias);
  await writeFile(join(dir, `${ID1}.jsonl`), user(alias, ID1));
  expect((await listClaudePastSessions(config, folder)).map((s) => s.sessionRef)).toEqual([ID1]);
});
it('drops a partial last line of the head window', async () => {
  const { folder, config, dir } = await home();
  const head = user(folder, ID1, 'first');
  // The only second user record straddles the head bound, so it must not be parsed.
  const pad = rec({ type: 'mode', pad: 'x'.repeat(CLAUDE_PAST_HEAD_BYTES - head.length - 200) });
  const straddling = JSON.stringify({
    type: 'user',
    cwd: folder,
    message: { content: 'x'.repeat(500) },
  });
  await writeFile(join(dir, `${ID1}.jsonl`), head + pad + straddling + '\n');
  expect((await listClaudePastSessions(config, folder))[0]?.title).toBe('first');
});
it('ignores a title record that only the tail’s partial first line could hold', async () => {
  const { folder, config, dir } = await home();
  const early = rec({ type: 'ai-title', aiTitle: 'Early', sessionId: ID1 });
  const filler = rec({ type: 'mode', pad: 'x'.repeat(1000) }).repeat(
    Math.ceil(CLAUDE_PAST_TAIL_BYTES / 1000) + 2,
  );
  await writeFile(join(dir, `${ID1}.jsonl`), user(folder, ID1, 'prompt') + early + filler);
  expect((await listClaudePastSessions(config, folder))[0]?.title).toBe('prompt');
});
it('reads a title inside the tail window and drops the line the window cuts', async () => {
  const { folder, config, dir } = await home();
  const filler = rec({ type: 'mode', pad: 'x'.repeat(1000) }).repeat(
    Math.ceil(CLAUDE_PAST_TAIL_BYTES / 1000) + 2,
  );
  const tail = rec({ type: 'ai-title', aiTitle: 'Late', sessionId: ID1 });
  await writeFile(join(dir, `${ID1}.jsonl`), user(folder, ID1, 'prompt') + filler + tail);
  expect((await listClaudePastSessions(config, folder))[0]?.title).toBe('Late');
});
it('survives a multibyte character cut at the window edge', async () => {
  const { folder, config, dir } = await home();
  const head = user(folder, ID1, 'prompt');
  const filler = rec({ type: 'mode', pad: 'é'.repeat(CLAUDE_PAST_TAIL_BYTES) });
  const tail = rec({ type: 'ai-title', aiTitle: 'שלום', sessionId: ID1 });
  await writeFile(join(dir, `${ID1}.jsonl`), head + filler + tail);
  expect((await listClaudePastSessions(config, folder))[0]?.title).toBe('שלום');
});
it('rejects a project directory with more than 10,000 entries', async () => {
  const { folder, config, dir } = await home();
  await Promise.all(Array.from({ length: 10_001 }, (_, i) => writeFile(join(dir, `f${i}`), '')));
  await expect(listClaudePastSessions(config, folder)).rejects.toThrow(
    'Transcript enumeration exceeds bound',
  );
});

it('ignores a file whose first cwd lies beyond the head bound', async () => {
  const { folder, config, dir } = await home();
  const filler = rec({ type: 'mode', pad: 'x'.repeat(4096) }).repeat(
    Math.ceil(CLAUDE_PAST_HEAD_BYTES / 4096) + 1,
  );
  await writeFile(
    join(dir, `${ID1}.jsonl`),
    filler + rec({ type: 'user', cwd: folder, sessionId: ID1, message: { content: 'late' } }),
  );
  expect(await listClaudePastSessions(config, folder)).toEqual([]);
});
it('returns nothing for a folder with no project directory', async () => {
  const { folder, config } = await home();
  expect(await listClaudePastSessions(config, join(folder, '..'))).toEqual([]);
});
