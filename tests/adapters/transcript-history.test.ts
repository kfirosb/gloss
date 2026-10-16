import { afterEach, expect, it } from 'vitest';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transcript, transcriptConnection } from '../../src/agents/shared.js';

const roots: string[] = [];
it('reports verified status before replay so slow message consumers cannot starve connection state', async () => {
  const transcript = await fixture(0);
  const connection = await transcriptConnection({
    target: { agent: 'claude', sessionRef: 'test', projectId: '/project' },
    transcript,
    options: {},
    capabilities: {
      history: true,
      liveMessages: true,
      attachExisting: true,
      sendWhileBusy: false,
      acknowledgement: 'accepted',
    },
    status: async () => 'idle',
    dispatch: async () => ({ state: 'failed' }),
  });
  const abort = new AbortController();
  const events = connection.events(abort.signal)[Symbol.asyncIterator]();
  try {
    expect((await events.next()).value).toEqual({ type: 'status', state: 'idle' });
  } finally {
    abort.abort();
    await events.return?.();
    await connection.detach();
  }
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(padding: number) {
  const root = await mkdtemp(join(tmpdir(), 'transcript-history-'));
  roots.push(root);
  const path = join(root, 'session.jsonl');
  await writeFile(
    path,
    [
      JSON.stringify({ text: 'Older response' }),
      JSON.stringify({ tool: 'x'.repeat(padding) }),
      JSON.stringify({ text: 'Latest response' }),
    ].join('\n') + '\n',
  );
  return new Transcript(
    path,
    (record, offset) =>
      typeof record.text === 'string' && record.text
        ? {
            message: {
              sourceId: record.text,
              revision: offset + 1,
              role: 'assistant',
              text: record.text,
              complete: true,
            },
          }
        : {},
    1,
  );
}
it('advances across a large tool record without repeating cursors or dropping older messages', async () => {
  const transcript = await fixture(1_650_000);
  await transcript.initialize();
  let cursor: string | undefined;
  const cursors = new Set<string>();
  const messages: string[] = [];
  for (let pageNumber = 0; pageNumber < 6; pageNumber++) {
    const page = await transcript.history(cursor);
    messages.unshift(...page.messages.map((message) => message.text));
    if (!page.next) {
      cursor = undefined;
      break;
    }
    expect(cursors.has(page.next), 'history must advance on every page').toBe(false);
    cursors.add(page.next);
    cursor = page.next;
  }
  expect(cursor).toBeUndefined();
  expect(messages).toEqual(['Older response', 'Latest response']);
});
it('fails within a bounded read for an excessively large record instead of returning a repeated cursor', async () => {
  const transcript = await fixture(9 * 1024 * 1024);
  await transcript.initialize();
  const page = await transcript.history();
  await expect(transcript.history(page.next)).rejects.toThrow(/record exceeds read bound/);
});
it('keeps live polling after history fails on an excessively large old record', async () => {
  const transcript = await fixture(9 * 1024 * 1024);
  await transcript.initialize();
  const page = await transcript.history();
  await expect(transcript.history(page.next)).rejects.toThrow(/record exceeds read bound/);
  // History is a bounded look back; its failure must not end the live tail.
  await appendFile(transcript.path, JSON.stringify({ text: 'Newer response' }) + '\n');
  const events = await transcript.poll();
  expect(events.flatMap((event) => (event.type === 'message' ? [event.message.text] : []))).toEqual(
    ['Newer response'],
  );
  expect(transcript.caughtUp).toBe(true);
});
