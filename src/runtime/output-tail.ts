import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

/** Largest slice of a background output file sent to a client in one piece. */
export const OUTPUT_WINDOW_BYTES = 65_536;

export type OutputWindow = { text: string; start: number; end: number; size: number };
export type OutputTailEvent =
  { kind: 'chunk'; text: string; start: number; end: number } | { kind: 'error'; reason: string };

async function readSlice(path: string, from: number, to: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    const end = Math.min(to, info.size);
    const start = Math.min(from, end);
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return { bytes: buffer.subarray(0, bytesRead), start, size: info.size, ino: info.ino };
  } finally {
    await handle.close();
  }
}

/** Reads a window ending at `end`, moved forward to a line start so it never begins mid-line. */
async function readWindowBytes(path: string, end?: number) {
  const size = (await stat(path)).size;
  const to = Math.min(end ?? size, size);
  const slice = await readSlice(path, Math.max(0, to - OUTPUT_WINDOW_BYTES), to);
  let { bytes, start } = slice;
  if (start > 0) {
    const newline = bytes.indexOf(0x0a);
    const skip = newline === -1 ? bytes.length : newline + 1;
    bytes = bytes.subarray(skip);
    start += skip;
  }
  return { bytes, start, end: start + bytes.length, size: slice.size, ino: slice.ino };
}

export async function readOutputWindow(path: string, end?: number): Promise<OutputWindow> {
  const window = await readWindowBytes(path, end);
  return {
    text: window.bytes.toString('utf8'),
    start: window.start,
    end: window.end,
    size: window.size,
  };
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

/** Yields the latest window, then appended bytes; stops with an error if the file is replaced or shrinks. */
export async function* tailOutput(
  path: string,
  signal: AbortSignal,
  pollMs = 500,
): AsyncGenerator<OutputTailEvent> {
  // One decoder keeps a multi-byte character that straddles two chunks intact.
  const decoder = new StringDecoder('utf8');
  try {
    const initial = await readWindowBytes(path);
    if (signal.aborted) return;
    const inode = initial.ino;
    let position = initial.end;
    yield {
      kind: 'chunk',
      text: decoder.write(initial.bytes),
      start: initial.start,
      end: initial.end,
    };
    while (!signal.aborted) {
      await pause(pollMs, signal);
      if (signal.aborted) return;
      const info = await stat(path);
      if (info.ino !== inode) return yield { kind: 'error', reason: 'Output file was replaced' };
      if (info.size < position) return yield { kind: 'error', reason: 'Output file shrank' };
      while (position < info.size && !signal.aborted) {
        const slice = await readSlice(path, position, position + OUTPUT_WINDOW_BYTES);
        if (slice.ino !== inode) return yield { kind: 'error', reason: 'Output file was replaced' };
        if (!slice.bytes.length) break;
        const start = position;
        position += slice.bytes.length;
        yield { kind: 'chunk', text: decoder.write(slice.bytes), start, end: position };
      }
    }
  } catch {
    if (!signal.aborted) yield { kind: 'error', reason: 'Output unavailable' };
  }
}
