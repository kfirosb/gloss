import { appendFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { harness, watch } from './agent-harness.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

it('a Codex session beyond the live tail reads no activity lookback', async () => {
  const h = await harness('codex');
  cleanups.push(h.cleanup);
  // Older than the live tail and the whole activity lookback, so a Claude transcript would report a gap.
  const filler = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(200_000) } });
  await appendFile(h.transcript, (filler + '\n').repeat(60));
  await h.appendMessage('Latest answer', 'latest');
  const connection = await h.adapter.attach(h.target);
  const w = watch(connection);
  try {
    await expect
      .poll(() => w.events.some((e) => e.type === 'message' && e.message.sourceId === 'latest'))
      .toBe(true);
    expect(w.events.some((e) => e.type === 'gap')).toBe(true);
    expect(w.events.filter((e) => e.type === 'activity')).toEqual([]);
  } finally {
    await w.stop();
  }
});
