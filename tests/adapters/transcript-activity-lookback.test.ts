import { expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transcript } from '../../src/agents/shared.js';
import { parseClaudeRecord } from '../../src/agents/claude/index.js';

const row = (value: object) => JSON.stringify(value) + '\n';
const pad = 'x'.repeat(200_000);
it('replays unresolved task starts from before the live tail window, in order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lookback-'));
  const path = join(dir, 's.jsonl');
  const early = row({
    type: 'assistant',
    uuid: 'a0',
    sessionId: 's',
    cwd: '/r',
    timestamp: 'T0',
    message: {
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'b1',
          name: 'Bash',
          input: { command: 'npm run dev', description: 'Serve', run_in_background: true },
        },
      ],
    },
  });
  const filler = Array.from({ length: 7 }, (_, i) =>
    row({
      type: 'assistant',
      uuid: `f${i}`,
      sessionId: 's',
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: pad }],
      },
    }),
  ).join('');
  const late = row({
    type: 'assistant',
    uuid: 'a9',
    sessionId: 's',
    cwd: '/r',
    timestamp: 'T9',
    message: {
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't9', name: 'Read', input: { file_path: '/r/x.ts' } }],
    },
  });
  await writeFile(path, early + filler + late);
  const transcript = new Transcript(path, (r, o) => parseClaudeRecord(r, o, 's'), {
    activityLookback: true,
  });
  await transcript.initialize();
  const initial = transcript.takeInitial();
  const activity = initial.flatMap((e) => (e.type === 'activity' ? [e.event] : []));
  expect(initial[0]).toMatchObject({ type: 'gap' });
  expect(activity.map((e) => e.kind)).toEqual(['call', 'task-start', 'call']);
  expect(activity[1]).toMatchObject({ kind: 'task-start', task: { id: 'b1' } });
  expect(activity[2]).toMatchObject({ kind: 'call', call: { id: 't9' } });
});
it('reports an incomplete lookback as an activity gap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lookback-'));
  const path = join(dir, 's.jsonl');
  const filler = Array.from({ length: 60 }, (_, i) =>
    row({
      type: 'assistant',
      uuid: `f${i}`,
      sessionId: 's',
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: pad }],
      },
    }),
  ).join('');
  await writeFile(path, filler);
  const transcript = new Transcript(path, (r, o) => parseClaudeRecord(r, o, 's'), {
    activityLookback: true,
  });
  await transcript.initialize();
  const gaps = transcript
    .takeInitial()
    .flatMap((e) => (e.type === 'activity' && e.event.kind === 'gap' ? [e.event.reason] : []));
  expect(gaps).toEqual(['Older activity is not shown; the lookback is bounded.']);
});
