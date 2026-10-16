import { expect, it, vi } from 'vitest';
import { readServerEvents } from '../../src/ui/server-events.js';

it('decodes split UTF-8 and multiline CRLF frames, ignoring comments and incomplete frames', async () => {
  const bytes = new TextEncoder().encode(
    ': heartbeat\r\n\r\ndata:{"text":\r\ndata: "שלום"}\r\n\r\ndata: {"unfinished":',
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const values = [];
  for await (const value of readServerEvents(body, new AbortController().signal))
    values.push(value);
  expect(values).toEqual([{ text: 'שלום' }]);
  expect(body.locked).toBe(false);
});

it('cancels an idle stream immediately when its owner aborts', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  const controller = new AbortController();
  const iterator = readServerEvents(body, controller.signal);
  const pending = iterator.next();
  controller.abort();
  await expect(pending).resolves.toMatchObject({ done: true });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.locked).toBe(false);
});
