import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DictationFailure, MODEL_FILE } from '../../core/dictation-contracts.js';

export const MODEL_REPO_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
export const MODEL_URL = `${MODEL_REPO_URL}/${MODEL_FILE}`;
export const MODEL_SHA256 = '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2';
export type ModelProgress = (received: number, total: number | null) => void;
export interface ModelStore {
  readonly path: string;
  present(): Promise<{ present: boolean; bytes?: number }>;
  /** Resolves with the verified file path; downloads once if missing. Concurrent callers share one download. */
  ensure(onProgress: ModelProgress, signal?: AbortSignal): Promise<string>;
  /** Forces a checksum verification on the next ensure(); a mismatching file is deleted and re-downloaded. */
  invalidate(): void;
  cancel(): void;
}
const failure = (message: string) => new DictationFailure('download-failed', message);
const cancelled = () => failure('Download cancelled');

export function createModelStore(options: {
  directory: string;
  url?: string;
  sha256?: string;
  fetch?: typeof fetch;
  file?: string;
}): ModelStore {
  const url = options.url ?? MODEL_URL,
    expected = (options.sha256 ?? MODEL_SHA256).toLowerCase(),
    doFetch = options.fetch ?? fetch;
  const path = join(options.directory, options.file ?? MODEL_FILE),
    partial = path + '.partial';
  let inflight: Promise<string> | undefined;
  let controller: AbortController | undefined;
  let listeners: ModelProgress[] = [];
  let verify = false;
  const size = async () => {
    try {
      const s = await stat(path);
      return s.isFile() ? s.size : undefined;
    } catch {
      return undefined;
    }
  };
  // Streamed: the model is ~574 MB and must never be read into memory whole.
  const hashOf = async (file: string) => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  };
  async function download(signal: AbortSignal): Promise<string> {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    await rm(partial, { force: true });
    let response: Response;
    try {
      response = await doFetch(url, { signal, redirect: 'follow' });
    } catch (e) {
      throw signal.aborted ? cancelled() : failure('Network error');
    }
    if (!response.ok || !response.body) throw failure('Download failed (' + response.status + ')');
    const header = Number(response.headers.get('content-length'));
    const total = Number.isFinite(header) && header > 0 ? header : null;
    const hash = createHash('sha256');
    const out = createWriteStream(partial, { mode: 0o600 });
    let received = 0;
    // One persistent error handler: a disk error must never be an unhandled 'error' event, and must unblock every wait below.
    let writeError: Error | undefined;
    const broken = new Promise<never>((_, j) =>
      out.on('error', (e) => {
        writeError = e;
        j(e);
      }),
    );
    broken.catch(() => undefined);
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), broken]);
        if (done) break;
        hash.update(value);
        received += value.length;
        for (const l of listeners) l(received, total);
        if (!out.write(value))
          await Promise.race([new Promise<void>((r) => out.once('drain', r)), broken]);
      }
      await Promise.race([
        new Promise<void>((r) => {
          out.once('finish', r);
          out.end();
        }),
        broken,
      ]);
    } catch (e) {
      reader.cancel().catch(() => undefined);
      if (!out.closed)
        await new Promise<void>((r) => {
          out.once('close', r);
          out.destroy();
        });
      await rm(partial, { force: true }).catch(() => undefined);
      const text = (writeError ?? e) instanceof Error ? ((writeError ?? e) as Error).message : '';
      throw signal.aborted
        ? cancelled()
        : failure(
            /ENOSPC/.test(text)
              ? 'Not enough disk space'
              : writeError
                ? 'Could not write the model file'
                : 'Download interrupted',
          );
    }
    if (hash.digest('hex') !== expected) {
      await rm(partial, { force: true });
      throw failure('Downloaded file failed verification');
    }
    await rename(partial, path);
    return path;
  }
  return {
    path,
    async present() {
      const bytes = await size();
      return bytes === undefined ? { present: false } : { present: true, bytes };
    },
    async ensure(onProgress, signal) {
      if (inflight) {
        listeners.push(onProgress);
        return inflight;
      }
      // Claim the in-flight slot synchronously so concurrent callers cannot both start a download.
      const own = (controller = new AbortController());
      listeners = [onProgress];
      signal?.addEventListener('abort', () => own.abort(), { once: true });
      inflight = (async () => {
        try {
          if ((await size()) !== undefined) {
            if (!verify) return path;
            verify = false;
            if ((await hashOf(path)) === expected) return path;
            await rm(path, { force: true });
          }
          return await download(own.signal);
        } catch (e) {
          throw e instanceof DictationFailure ? e : failure('Could not prepare the model file');
        }
      })().finally(() => {
        inflight = undefined;
        controller = undefined;
        listeners = [];
      });
      return inflight;
    },
    invalidate() {
      verify = true;
    },
    cancel() {
      controller?.abort();
    },
  };
}
