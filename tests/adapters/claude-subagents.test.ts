import { afterEach, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findSubagentFile,
  streamSubagent,
  subagentsDir,
} from '../../src/agents/claude/subagents.js';

const clean: string[] = [];
afterEach(async () => {
  for (const path of clean.splice(0)) await rm(path, { recursive: true, force: true });
});
const row = (record: unknown) => JSON.stringify(record) + '\n';
const base = {
  sessionId: 's',
  isSidechain: true,
  agentId: 'ag1',
  timestamp: '2026-01-01T00:00:00Z',
};

it('builds the subagents directory beside the session transcript', () => {
  expect(subagentsDir('/p/proj/s.jsonl', 's')).toBe('/p/proj/s/subagents');
});

it('finds a subagent by tool use id and streams its activity until aborted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-subagents-'));
  clean.push(dir);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'agent-ag1.meta.json'),
    JSON.stringify({
      agentType: 'general-purpose',
      description: 'Review',
      toolUseId: 'a1',
      spawnDepth: 1,
      model: 'opus',
    }),
  );
  await writeFile(join(dir, 'agent-bad.meta.json'), JSON.stringify({ description: 'no id' }));
  await writeFile(join(dir, 'agent-junk.meta.json'), 'not json');
  const path = join(dir, 'agent-ag1.jsonl');
  await writeFile(
    path,
    row({
      ...base,
      type: 'assistant',
      uuid: 'u1',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }],
      },
    }),
  );
  expect(await findSubagentFile(dir, 'a1')).toEqual({
    agentId: 'ag1',
    path,
    meta: {
      agentType: 'general-purpose',
      description: 'Review',
      toolUseId: 'a1',
      spawnDepth: 1,
      model: 'opus',
    },
  });
  expect(await findSubagentFile(dir, 'zz')).toBeUndefined();
  expect(await findSubagentFile(join(dir, 'missing'), 'a1')).toBeUndefined();

  const controller = new AbortController();
  const stream = streamSubagent(path, 's', 1, controller.signal, 10);
  const first = await stream.next();
  expect(first.value).toMatchObject({ kind: 'call', call: { depth: 1 } });
  await appendFile(
    path,
    row({
      ...base,
      type: 'user',
      uuid: 'u2',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
      },
    }),
  );
  const second = await stream.next();
  expect(second.value).toMatchObject({ kind: 'result' });
  const pending = stream.next();
  controller.abort();
  expect((await pending).done).toBe(true);
});

it('yields a gap and ends when the transcript fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-subagents-'));
  clean.push(dir);
  const path = join(dir, 'agent-ag1.jsonl');
  await writeFile(path, 'not json\n');
  const events = [];
  for await (const event of streamSubagent(path, 's', 1, new AbortController().signal, 10))
    events.push(event);
  expect(events).toEqual([{ kind: 'gap', reason: expect.any(String) }]);
});
