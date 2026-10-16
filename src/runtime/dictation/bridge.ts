import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  acceptTranscription,
  DictationFailure,
  isDictationLanguage,
  isRepetitive,
  MAX_AUDIO_MESSAGE_BYTES,
  MAX_CONSECUTIVE_FAILURES,
  MAX_RECORDING_MS,
  nextPrompt,
  SAMPLE_RATE,
  type DictationLanguage,
  type DictationServerMessage,
  type DictationStatus,
} from '../../core/dictation-contracts.js';
import { createSegmenter, type Segmenter } from '../../core/dictation-segmenter.js';
import { isLoopbackOrigin, rejectUpgrade } from '../loopback.js';
import type { DictationEngine } from './engine.js';
import type { ModelStore } from './model.js';

export interface DictationBridge {
  status(): Promise<DictationStatus>;
  cancelDownload(): void;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
}
const PATH = '/api/dictation/audio',
  SESSION = /^[\w.:-]{1,128}$/;
const same = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createDictationBridge(options: {
  engine: DictationEngine;
  model: ModelStore;
  capability: () => string;
  now?: () => number;
  maxRecordingMs?: number;
  createSegmenter?: () => Segmenter;
  log?: (line: string) => void;
}): DictationBridge {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_AUDIO_MESSAGE_BYTES });
  const maxMs = options.maxRecordingMs ?? MAX_RECORDING_MS,
    log = options.log ?? (() => undefined),
    now = options.now ?? Date.now;
  function record(ws: WebSocket, language: DictationLanguage, session: string) {
    const started = now();
    const segmenter = (options.createSegmenter ?? createSegmenter)();
    let closed = false;
    let stopping = false;
    let ready = false;
    let sequence = 0;
    let context = '';
    let skipPrompt = false;
    let failures = 0;
    let pendingStop = false;
    let earlySamples = 0;
    const earlyLimit = (SAMPLE_RATE * maxMs) / 1000;
    let cap: NodeJS.Timeout | undefined;
    let queue: Promise<void> = Promise.resolve();
    const early: Int16Array[] = [];
    const send = (m: DictationServerMessage) => {
      if (!closed && ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    };
    const end = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      clearTimeout(cap);
      log(`dictation ${session} ${reason} ${now() - started}ms segments=${sequence}`);
      if (ws.readyState === ws.OPEN) ws.close(code, reason);
      else ws.terminate();
    };
    const fail = (error: unknown) => {
      const f =
        error instanceof DictationFailure
          ? error
          : new DictationFailure('engine-failed', 'Speech engine failed');
      send({ type: 'error', code: f.code, message: f.message });
      end(1011, f.code);
    };
    const enqueue = (samples: Int16Array) => {
      queue = queue.then(async () => {
        if (closed) return;
        try {
          const prompt = nextPrompt(context, skipPrompt, language);
          const result = await options.engine.transcribe(samples, {
            language,
            ...(prompt ? { prompt } : {}),
          });
          if (closed) return;
          failures = 0;
          const text = acceptTranscription(result.text, result.noSpeech, language);
          if (text) {
            sequence++;
            skipPrompt = isRepetitive(text);
            if (!skipPrompt) context = context ? context + ' ' + text : text;
            send({ type: 'segment', sequence, text });
          }
        } catch (error) {
          if (closed) return;
          if (error instanceof DictationFailure) {
            fail(error);
            return;
          }
          if (++failures >= MAX_CONSECUTIVE_FAILURES) {
            fail(new DictationFailure('engine-failed', 'Transcription keeps failing'));
            return;
          }
          send({ type: 'notice', code: 'segment-lost' });
        }
      });
    };
    const flush = () => {
      const last = segmenter.stop();
      if (last) enqueue(last);
      queue = queue.then(() => {
        if (closed) return;
        send({ type: 'state', state: 'finished' });
        end(1000, 'finished');
      });
    };
    // Before the engine is ready the buffered audio must still be transcribed, so the stop flow waits for the ready handler.
    const stop = () => {
      if (stopping || closed) return;
      stopping = true;
      if (ready) flush();
      else pendingStop = true;
    };
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      closed = true;
      clearTimeout(cap);
      options.engine.touch();
    });
    ws.on('message', (raw, binary) => {
      if (closed || stopping) return;
      if (!binary) {
        let m: unknown;
        try {
          m = JSON.parse(String(raw));
        } catch {
          return;
        }
        if ((m as { type?: unknown })?.type === 'stop') stop();
        return;
      }
      const buf = Array.isArray(raw)
        ? Buffer.concat(raw)
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw)
          : raw;
      if (!buf.length || buf.length % 2) return; // odd-length frames are malformed: drop whole
      const samples = new Int16Array(buf.length / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(i * 2);
      options.engine.touch();
      if (!ready) {
        if (earlySamples + samples.length <= earlyLimit) {
          earlySamples += samples.length;
          early.push(samples);
        }
        return;
      }
      for (const segment of segmenter.push(samples)) enqueue(segment);
    });
    send({ type: 'state', state: 'starting' });
    options.engine
      .ensureReady((received, total) =>
        send({ type: 'state', state: 'downloading', received, total }),
      )
      .then(() => {
        if (closed) return;
        ready = true;
        send({ type: 'state', state: 'recording' });
        cap = setTimeout(() => {
          if (closed) return;
          send({ type: 'notice', code: 'max-duration' });
          stop();
        }, maxMs);
        for (const s of early.splice(0)) for (const segment of segmenter.push(s)) enqueue(segment);
        if (pendingStop) flush();
      }, fail);
  }
  return {
    async status() {
      const a = options.engine.available();
      return {
        available: a.available,
        ...(a.reason ? { reason: a.reason } : {}),
        model: await options.model.present(),
        engine: options.engine.state(),
      };
    },
    cancelDownload: () => options.engine.cancelDownload(),
    handleUpgrade(req, socket, head) {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== PATH) return rejectUpgrade(socket, 400);
      const origin = req.headers.origin;
      if (origin && !isLoopbackOrigin(origin)) return rejectUpgrade(socket, 403);
      const expected = options.capability();
      if (!expected || !same(url.searchParams.get('capability') ?? '', expected))
        return rejectUpgrade(socket, 401);
      const language = url.searchParams.get('language');
      const session = url.searchParams.get('session') ?? '';
      if (!isDictationLanguage(language) || !SESSION.test(session))
        return rejectUpgrade(socket, 400);
      wss.handleUpgrade(req, socket, head, (ws) => record(ws, language, session));
    },
    close() {
      for (const c of wss.clients) c.terminate();
      wss.close();
      options.engine.close();
    },
  };
}
