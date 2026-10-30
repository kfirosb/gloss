// tests/adapters/claude-past-sessions.test.ts
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, realpath, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeProjectSlug,
  listClaudePastSessions,
  CLAUDE_PAST_HEAD_BYTES,
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
it('skips subagent and memory directories, non-uuid names, other folders and files without a user record', async () => {
  const { folder, config, dir } = await home();
  await mkdir(join(dir, ID2));
  await writeFile(
    join(dir, ID2, 'agent-x.jsonl'),
    rec({ type: 'user', cwd: folder, message: { content: 'x' } }),
  );
  await mkdir(join(dir, 'memory'));
  await writeFile(
    join(dir, 'notes.jsonl'),
    rec({ type: 'user', cwd: folder, message: { content: 'x' } }),
  );
  // Same slug, different folder (dot vs dash): must not be listed.
  await writeFile(
    join(dir, `${ID1}.jsonl`),
    rec({
      type: 'user',
      cwd: folder.replace('my.project', 'my-project'),
      sessionId: ID1,
      message: { content: 'x' },
    }),
  );
  await writeFile(join(dir, `${ID3}.jsonl`), rec({ type: 'file-history-snapshot' }));
  expect(await listClaudePastSessions(config, folder)).toEqual([]);
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
