import { afterEach, expect, it } from 'vitest';
import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OUTPUT_WINDOW_BYTES,
  readOutputWindow,
  tailOutput,
} from '../../src/runtime/output-tail.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function file(content: string) {
  const root = await mkdtemp(join(tmpdir(), 'output-tail-'));
  roots.push(root);
  const path = join(root, 't.output');
  await writeFile(path, content);
  return path;
}
const within = <T>(promise: Promise<T>) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
  ]);

it('reads a small file whole', async () => {
  const path = await file('a\nb\nc\n');
  expect(await readOutputWindow(path)).toEqual({ text: 'a\nb\nc\n', start: 0, end: 6, size: 6 });
});

it('starts a large file window at a line boundary', async () => {
  const line = 'x'.repeat(99) + '\n';
  const path = await file(line.repeat(1500));
  const window = await readOutputWindow(path);
  expect(window.start).toBeGreaterThan(0);
  expect(window.end).toBe(window.size);
  expect(window.text.startsWith(line)).toBe(true);
  expect(window.end - window.start).toBeLessThanOrEqual(OUTPUT_WINDOW_BYTES);
  const earlier = await readOutputWindow(path, window.start);
  expect(earlier.end).toBe(window.start);
});

it('tails appended bytes, then reports a shrink and ends', async () => {
  const path = await file('one\n');
  const abort = new AbortController();
  const tail = tailOutput(path, abort.signal, 10);
  const first = await within(tail.next());
  expect(first.value).toEqual({ kind: 'chunk', text: 'one\n', start: 0, end: 4 });
  await appendFile(path, 'two\n');
  const second = await within(tail.next());
  expect(second.value).toEqual({ kind: 'chunk', text: 'two\n', start: 4, end: 8 });
  await writeFile(path, 'x');
  const third = await within(tail.next());
  expect(third.value).toMatchObject({ kind: 'error' });
  expect((await within(tail.next())).done).toBe(true);
});

it('reports a file renamed over the tailed path as replaced and ends', async () => {
  const path = await file('one\n');
  const abort = new AbortController();
  const tail = tailOutput(path, abort.signal, 10);
  expect((await within(tail.next())).value).toMatchObject({ kind: 'chunk', text: 'one\n' });
  const replacement = `${path}.new`;
  // Longer than the original, so only the inode check can tell the files apart.
  await writeFile(replacement, 'one\ntwo\nthree\n');
  await rename(replacement, path);
  expect((await within(tail.next())).value).toEqual({
    kind: 'error',
    reason: 'Output file was replaced',
  });
  expect((await within(tail.next())).done).toBe(true);
});

it('ends when the signal aborts', async () => {
  const path = await file('one\n');
  const abort = new AbortController();
  const tail = tailOutput(path, abort.signal, 10);
  await within(tail.next());
  const pending = tail.next();
  abort.abort();
  expect((await within(pending)).done).toBe(true);
});
