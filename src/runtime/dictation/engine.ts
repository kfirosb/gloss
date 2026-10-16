import { spawn as nodeSpawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { accessSync, constants, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { cpus } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOOPBACK_HOST } from '../loopback.js';
import { packageRoot } from '../package-root.js';
import {
  DICTATION_REASON_TEXT,
  DictationFailure,
  ENGINE_IDLE_MS,
  NO_SPEECH_PROBABILITY,
  type DictationLanguage,
} from '../../core/dictation-contracts.js';
import type { ModelProgress, ModelStore } from './model.js';
import { encodeWav } from './wav.js';

export interface EngineProcess {
  pid?: number;
  kill(): void;
  onExit(cb: (code: number | null) => void): void;
  /** Raw stderr chunks, kept only for diagnosing a failed start or crash. */ onStderr?(
    cb: (text: string) => void,
  ): void;
}
export const STDERR_LINES = 20;
const STDERR_BYTES = 8 * 1024;
/** How long a starting whisper-server may take to answer its readiness probe (model load included), and how often it is probed. */
const START_TIMEOUT_MS = 60_000,
  READY_POLL_MS = 250;
/** Default inference threads: half the cores, kept within these bounds. */
const MIN_THREADS = 2,
  MAX_THREADS = 8;
/** Keeps the last STDERR_LINES lines (at most STDERR_BYTES characters in all) of a child's stderr. */
function stderrTail() {
  let lines: string[] = [];
  let partial = '';
  const trim = () => {
    if (lines.length > STDERR_LINES) lines = lines.slice(-STDERR_LINES);
    let total = lines.reduce((n, l) => n + l.length, 0);
    while (total > STDERR_BYTES && lines.length) total -= lines.shift()!.length;
  };
  return {
    push(text: string) {
      const parts = (partial + text).split(/\r?\n/);
      partial = parts.pop()!.slice(-STDERR_BYTES);
      lines.push(...parts.filter(Boolean).map((l) => l.slice(-STDERR_BYTES)));
      trim();
    },
    lines: () => {
      const all = partial ? [...lines, partial] : lines;
      return all.slice(-STDERR_LINES);
    },
  };
}
export interface DictationEngineOptions {
  binary: string | undefined;
  model: ModelStore;
  spawn?: (binary: string, args: string[]) => EngineProcess;
  fetch?: typeof fetch;
  freePort?: () => Promise<number>;
  idleMs?: number;
  startTimeoutMs?: number;
  pollMs?: number;
  threads?: number;
  log?: (line: string) => void;
}
export interface Transcription {
  text: string;
  noSpeech: boolean;
}
export interface DictationEngine {
  available(): { available: boolean; reason?: 'engine-missing' };
  state(): 'stopped' | 'starting' | 'running';
  ensureReady(onProgress: ModelProgress, signal?: AbortSignal): Promise<void>;
  transcribe(
    samples: Int16Array,
    options: { language: DictationLanguage; prompt?: string },
  ): Promise<Transcription>;
  touch(): void;
  cancelDownload(): void;
  close(): void;
}

/** Explicit env path first (the desktop shell sets it), then the packaged resources, then the checkout's vendor dir (omitted when no repo root is found). `start` overrides the module's directory, for tests. */
export function whisperCandidates(
  env: NodeJS.ProcessEnv = process.env,
  resourcesPath = (process as { resourcesPath?: string }).resourcesPath,
  start = dirname(fileURLToPath(import.meta.url)),
): string[] {
  const explicit = env.LANGUAGE_ASSISTANT_WHISPER;
  const root = packageRoot(start);
  return [
    ...new Set([
      ...(explicit && isAbsolute(explicit) ? [explicit] : []),
      ...(resourcesPath ? [join(resourcesPath, 'bin', 'whisper-server')] : []),
      ...(root ? [join(root, 'vendor', 'whisper', 'bin', 'whisper-server')] : []),
    ]),
  ];
}
export function locateWhisper(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return whisperCandidates(env).find((p) => {
    try {
      accessSync(p, constants.X_OK);
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
}
const nodeEngineSpawn = (binary: string, args: string[]): EngineProcess => {
  const child = nodeSpawn(binary, args, {
    shell: false,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.platform !== 'win32',
  });
  // Always drained; the engine's own output never reaches the UI and is logged only when a start fails or the engine crashes.
  let onStderr: ((text: string) => void) | undefined;
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (text: string) => onStderr?.(text));
  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    onStderr: (cb) => {
      onStderr = cb;
    },
    kill: () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
        else child.kill();
      } catch {
        /* already gone */
      }
    },
    onExit: (cb) => {
      child.once('exit', (code) => cb(code));
      child.once('error', () => cb(null));
    },
  };
};
const freeLoopbackPort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, LOOPBACK_HOST, () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });

export function createDictationEngine(options: DictationEngineOptions): DictationEngine {
  const spawn = options.spawn ?? nodeEngineSpawn,
    doFetch = options.fetch ?? fetch,
    freePort = options.freePort ?? freeLoopbackPort;
  const idleMs = options.idleMs ?? ENGINE_IDLE_MS,
    startTimeout = options.startTimeoutMs ?? START_TIMEOUT_MS,
    pollMs = options.pollMs ?? READY_POLL_MS;
  const threads =
      options.threads ?? Math.max(MIN_THREADS, Math.min(MAX_THREADS, Math.ceil(cpus().length / 2))),
    log = options.log ?? (() => undefined);
  let state: 'stopped' | 'starting' | 'running' = 'stopped';
  let proc: EngineProcess | undefined;
  let base = '';
  let generation = 0;
  let starting: Promise<void> | undefined;
  let idle: NodeJS.Timeout | undefined;
  let queue: Promise<void> = Promise.resolve();
  const missing = () =>
    new DictationFailure('engine-missing', DICTATION_REASON_TEXT['engine-missing']);
  const stopped = () => new DictationFailure('engine-failed', 'Speech engine stopped unexpectedly');
  const stop = (why: string) => {
    if (idle) clearTimeout(idle);
    idle = undefined;
    const p = proc;
    proc = undefined;
    base = '';
    state = 'stopped';
    generation++;
    starting = undefined;
    p?.kill();
    log('dictation-engine ' + why);
  };
  const touch = () => {
    if (state !== 'running') return;
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => stop('idle-exit'), idleMs);
  };
  async function start(onProgress: ModelProgress, signal?: AbortSignal): Promise<void> {
    const gen = generation;
    const closed = () => new DictationFailure('engine-failed', 'Speech engine was closed');
    const modelPath = await options.model.ensure(onProgress, signal);
    if (generation !== gen) throw closed();
    const port = await freePort();
    if (generation !== gen) throw closed();
    const started = Date.now();
    state = 'starting';
    base = 'http://' + LOOPBACK_HOST + ':' + port;
    proc = spawn(options.binary!, [
      '--host',
      LOOPBACK_HOST,
      '--port',
      String(port),
      '-m',
      modelPath,
      '-t',
      String(threads),
    ]);
    const tail = stderrTail();
    proc.onStderr?.((text) => tail.push(text));
    const dumpStderr = () => {
      for (const line of tail.lines()) log('dictation-engine stderr: ' + line);
    };
    let exited = false;
    proc.onExit((code) => {
      exited = true;
      if (generation === gen) {
        log('dictation-engine exit ' + code);
        dumpStderr();
        stop('exit');
      }
    });
    for (;;) {
      if (exited || generation !== gen) throw stopped();
      if (Date.now() - started > startTimeout) {
        options.model.invalidate();
        dumpStderr();
        stop('start-timeout');
        throw new DictationFailure('engine-failed', 'Speech engine did not start');
      }
      try {
        const r = await doFetch(base + '/', { method: 'GET' });
        if (r.ok) break;
      } catch {
        /* not listening yet */
      }
      await sleep(pollMs);
    }
    state = 'running';
    log('dictation-engine ready ' + (Date.now() - started) + 'ms');
    touch();
  }
  return {
    available: () =>
      options.binary ? { available: true } : { available: false, reason: 'engine-missing' },
    state: () => state,
    async ensureReady(onProgress, signal) {
      if (!options.binary) throw missing();
      if (state === 'running') {
        touch();
        return;
      }
      if (!starting) {
        const run: Promise<void> = start(onProgress, signal).finally(() => {
          if (starting === run) starting = undefined;
        });
        starting = run;
      }
      return starting;
    },
    transcribe(samples, { language, prompt }) {
      const gen = generation;
      const job = async (): Promise<Transcription> => {
        if (state !== 'running' || generation !== gen)
          throw new DictationFailure('engine-failed', 'Speech engine is not running');
        touch();
        const form = new FormData();
        form.set(
          'file',
          new Blob([new Uint8Array(encodeWav(samples))], { type: 'audio/wav' }),
          'audio.wav',
        );
        form.set('response_format', 'verbose_json');
        form.set('language', language);
        form.set('temperature', '0');
        form.set('no_timestamps', 'true');
        form.set('no_language_probabilities', 'true');
        if (prompt) form.set('prompt', prompt);
        let response: Response;
        try {
          response = await doFetch(base + '/inference', { method: 'POST', body: form });
        } catch (e) {
          if (generation !== gen || state !== 'running') throw stopped();
          throw e instanceof Error ? e : new Error('Transcription request failed');
        }
        if (generation !== gen || state !== 'running') throw stopped();
        if (!response.ok) throw new Error('Transcription failed (' + response.status + ')');
        const body = (await response.json()) as {
          text?: unknown;
          segments?: { no_speech_prob?: unknown }[];
        };
        const text = typeof body.text === 'string' ? body.text : '';
        const probs = (body.segments ?? []).map((s) =>
          typeof s.no_speech_prob === 'number' ? s.no_speech_prob : 0,
        );
        touch();
        return {
          text,
          noSpeech: probs.length > 0 && probs.every((p) => p > NO_SPEECH_PROBABILITY),
        };
      };
      const result = queue.then(job, job);
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    touch,
    cancelDownload: () => options.model.cancel(),
    close: () => stop('close'),
  };
}
