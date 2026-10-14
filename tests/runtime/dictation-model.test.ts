import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { createModelStore } from '../../src/runtime/dictation/model.js';
import { DictationFailure } from '../../src/core/dictation-contracts.js';

const body = Buffer.from('model-bytes-'.repeat(1000));
const sha = createHash('sha256').update(body).digest('hex');
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'la-model-')); });
afterEach(() => rm(dir, { recursive: true, force: true }));

/** A fetch that streams `data` in `chunks` pieces, optionally without content-length, optionally failing midway. */
function fakeFetch(data: Buffer, opts: { chunks?: number; contentLength?: boolean; failAfter?: number; calls?: string[] } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    opts.calls?.push(String(input));
    const n = opts.chunks ?? 4; const size = Math.ceil(data.length / n); let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (init?.signal?.aborted) { controller.error(new Error('aborted')); return; }
        if (opts.failAfter !== undefined && i >= opts.failAfter) { controller.error(new Error('socket reset')); return; }
        if (i * size >= data.length) { controller.close(); return; }
        controller.enqueue(new Uint8Array(data.subarray(i * size, (i + 1) * size))); i++;
      },
    });
    return new Response(stream, { status: 200, headers: opts.contentLength === false ? {} : { 'content-length': String(data.length) } });
  }) as typeof fetch;
}

describe('createModelStore', () => {
  it('reports absent, downloads with progress, verifies and keeps the file', async () => {
    const calls: string[] = []; const store = createModelStore({ directory: dir, sha256: sha, fetch: fakeFetch(body, { calls }), file: 'm.bin' });
    expect(await store.present()).toEqual({ present: false });
    const progress: [number, number | null][] = [];
    const path = await store.ensure((r, t) => progress.push([r, t]));
    expect(path).toBe(join(dir, 'm.bin'));
    expect(progress.at(-1)).toEqual([body.length, body.length]); expect(progress.length).toBeGreaterThan(1);
    expect(await readFile(path)).toEqual(body);
    expect(await store.present()).toEqual({ present: true, bytes: body.length });
    expect(await readdir(dir)).toEqual(['m.bin']);
    await store.ensure(() => undefined); expect(calls).toHaveLength(1);
  });
  it('reports a null total when content-length is missing', async () => {
    const store = createModelStore({ directory: dir, sha256: sha, fetch: fakeFetch(body, { contentLength: false }), file: 'm.bin' });
    const totals = new Set<number | null>(); await store.ensure((_r, t) => totals.add(t));
    expect([...totals]).toEqual([null]);
  });
  it('rejects a checksum mismatch, removes the partial file and allows a retry', async () => {
    const store = createModelStore({ directory: dir, sha256: 'ab'.repeat(32), fetch: fakeFetch(body), file: 'm.bin' });
    await expect(store.ensure(() => undefined)).rejects.toMatchObject({ code: 'download-failed' });
    expect(await readdir(dir)).toEqual([]);
    const good = createModelStore({ directory: dir, sha256: sha, fetch: fakeFetch(body), file: 'm.bin' });
    await expect(good.ensure(() => undefined)).resolves.toBe(join(dir, 'm.bin'));
  });
  it('cleans up after a mid-stream failure and after cancel', async () => {
    const store = createModelStore({ directory: dir, sha256: sha, fetch: fakeFetch(body, { failAfter: 2 }), file: 'm.bin' });
    const error = await store.ensure(() => undefined).catch(e => e);
    expect(error).toBeInstanceOf(DictationFailure); expect(error.code).toBe('download-failed');
    expect(await readdir(dir)).toEqual([]);
    const slow = createModelStore({ directory: dir, sha256: sha, fetch: fakeFetch(body, { chunks: 50 }), file: 'm.bin' });
    const pending = slow.ensure((r) => { if (r > 0) slow.cancel(); });
    await expect(pending).rejects.toMatchObject({ code: 'download-failed' });
    expect(await readdir(dir)).toEqual([]);
  });
  it('shares one in-flight download between concurrent callers', async () => {
    const calls: string[] = []; const store = createModelStore({ directory: dir, sha256: sha, fetch: fakeFetch(body, { chunks: 20, calls }), file: 'm.bin' });
    const [a, b] = await Promise.all([store.ensure(() => undefined), store.ensure(() => undefined)]);
    expect(a).toBe(b); expect(calls).toHaveLength(1);
  });
  it('re-verifies after invalidate() and replaces a corrupt file', async () => {
    const calls: string[] = []; await writeFile(join(dir, 'm.bin'), 'corrupt');
    const store = createModelStore({ directory: dir, sha256: sha, fetch: fakeFetch(body, { calls }), file: 'm.bin' });
    expect(await store.ensure(() => undefined)).toBe(join(dir, 'm.bin')); expect(calls).toHaveLength(0); // present files are trusted by default
    store.invalidate();
    expect(await store.ensure(() => undefined)).toBe(join(dir, 'm.bin')); expect(calls).toHaveLength(1);
    expect(await readFile(join(dir, 'm.bin'))).toEqual(body);
    store.invalidate(); expect(await store.ensure(() => undefined)).toBe(join(dir, 'm.bin')); expect(calls).toHaveLength(1); // a verified file is kept
  });
  it('turns an unwritable target into download-failed instead of crashing or hanging', async () => {
    const ro = join(dir, 'ro'); await mkdir(ro); await chmod(ro, 0o500);
    try {
      const store = createModelStore({ directory: ro, sha256: sha, fetch: fakeFetch(body), file: 'm.bin' });
      await expect(store.ensure(() => undefined)).rejects.toMatchObject({ code: 'download-failed' });
      expect(await readdir(ro)).toEqual([]);
    } finally { await chmod(ro, 0o700); }
  });
  it('wraps setup errors (a directory where the partial file belongs) as download-failed', async () => {
    await mkdir(join(dir, 'm.bin.partial', 'x'), { recursive: true });
    const store = createModelStore({ directory: dir, sha256: sha, fetch: fakeFetch(body), file: 'm.bin' });
    const error = await store.ensure(() => undefined).catch(e => e);
    expect(error).toBeInstanceOf(DictationFailure); expect(error.code).toBe('download-failed');
  });
});
