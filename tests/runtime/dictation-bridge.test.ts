import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { createDictationBridge } from '../../src/runtime/dictation/bridge.js';
import type { DictationEngine } from '../../src/runtime/dictation/engine.js';
import type { ModelStore } from '../../src/runtime/dictation/model.js';
import type { Segmenter } from '../../src/core/dictation-segmenter.js';
import {
  DictationFailure,
  FRAME_SAMPLES,
  MAX_AUDIO_MESSAGE_BYTES,
  MAX_CONSECUTIVE_FAILURES,
  SEED_PROMPT,
  type DictationServerMessage,
} from '../../src/core/dictation-contracts.js';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
  vi.useRealTimers();
});
/** A segmenter that emits every frame whose first sample is nonzero as its own segment; stop() flushes a frame starting with 9. */
const trivialSegmenter = (): Segmenter => {
  let last: Int16Array | null = null;
  return {
    push: (f) => {
      if (f[0] === 9) {
        last = f;
        return [];
      }
      return f[0] ? [f] : [];
    },
    stop: () => {
      const l = last;
      last = null;
      return l;
    },
  };
};
function fakeEngine(overrides: Partial<DictationEngine> = {}) {
  const calls: { first: number; language: string; prompt?: string }[] = [];
  const engine: DictationEngine = {
    available: () => ({ available: true }),
    state: () => 'running',
    touch: vi.fn(),
    cancelDownload: vi.fn(),
    close: vi.fn(),
    ensureReady: async (p) => {
      p(1, 2);
    },
    transcribe: async (s, o) => {
      calls.push({ first: s[0]!, ...o });
      return { text: 'seg' + s[0], noSpeech: false };
    },
    ...overrides,
  };
  return { engine, calls };
}
const model: ModelStore = {
  path: '/m',
  present: async () => ({ present: true, bytes: 5 }),
  ensure: async () => '/m',
  invalidate: () => undefined,
  cancel: () => undefined,
};
async function setup(
  engine: DictationEngine,
  extra: Partial<Parameters<typeof createDictationBridge>[0]> = {},
) {
  const bridge = createDictationBridge({
    engine,
    model,
    capability: () => 'cap',
    createSegmenter: trivialSegmenter,
    ...extra,
  });
  const server = createServer();
  server.on('upgrade', (r, s, h) => bridge.handleUpgrade(r, s, h));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  closers.push(() => {
    bridge.close();
    server.close();
  });
  const connect = (
    query = 'capability=cap&session=s1&language=he',
    origin = `http://127.0.0.1:${port}`,
  ) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/dictation/audio?${query}`, {
      headers: { origin },
    });
    const messages: DictationServerMessage[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(String(raw))));
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
    const until = async (pred: (m: DictationServerMessage[]) => boolean) => {
      for (let i = 0; i < 200 && !pred(messages); i++) await new Promise((r) => setTimeout(r, 5));
      return messages;
    };
    return { ws, messages, closed, until };
  };
  return { bridge, connect, port };
}
const opened = (ws: WebSocket) =>
  new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('unexpected-response', (_q, r) => rej(new Error(String(r.statusCode))));
    ws.once('error', rej);
  });
const frame = (first: number) => {
  const f = new Int16Array(FRAME_SAMPLES);
  f[0] = first;
  return Buffer.from(f.buffer);
};

describe('createDictationBridge', () => {
  it('rejects a wrong capability, a bad language, a foreign origin and an unknown path', async () => {
    const { connect, port } = await setup(fakeEngine().engine);
    await expect(opened(connect('capability=nope&session=s&language=he').ws)).rejects.toThrow(
      '401',
    );
    await expect(opened(connect('capability=cap&session=s&language=xx').ws)).rejects.toThrow('400');
    await expect(
      opened(connect('capability=cap&session=s&language=he', 'http://evil.example').ws),
    ).rejects.toThrow('403');
    await expect(
      opened(
        new WebSocket(`ws://127.0.0.1:${port}/api/other?capability=cap&session=s&language=he`),
      ),
    ).rejects.toThrow('400');
    await expect(opened(connect('capability=cap&session=&language=he').ws)).rejects.toThrow('400');
  });
  it('accepts any supported language and reaches recording', async () => {
    const { connect } = await setup(fakeEngine().engine);
    const c = connect('capability=cap&session=s&language=fr');
    await opened(c.ws);
    await c.until((m) => m.some((x) => x.type === 'state' && x.state === 'recording'));
    expect(c.messages).toContainEqual({ type: 'state', state: 'recording' });
    c.ws.close();
  });
  it('stops the engine when the bridge closes', async () => {
    const { engine } = fakeEngine();
    const bridge = createDictationBridge({ engine, model, capability: () => 'cap' });
    bridge.close();
    expect(engine.close).toHaveBeenCalled();
  });
  it('rejects every client when the expected capability is empty', async () => {
    const { connect } = await setup(fakeEngine().engine, { capability: () => '' });
    await expect(opened(connect('capability=&session=s&language=he').ws)).rejects.toThrow('401');
  });
  it('rejects session ids with control characters', async () => {
    const { connect } = await setup(fakeEngine().engine);
    await expect(opened(connect('capability=cap&session=a%0Ab&language=he').ws)).rejects.toThrow(
      '400',
    );
  });
  it('reports status from the engine and model', async () => {
    const { bridge } = await setup(fakeEngine().engine);
    expect(await bridge.status()).toEqual({
      available: true,
      model: { present: true, bytes: 5 },
      engine: 'running',
    });
  });
  it('announces starting, forwards download progress, then recording; transcribes segments in order with context and finishes on stop', async () => {
    const { engine, calls } = fakeEngine();
    const { connect } = await setup(engine);
    const c = connect();
    await opened(c.ws);
    await c.until((m) => m.some((x) => x.type === 'state' && x.state === 'recording'));
    expect(c.messages).toEqual([
      { type: 'state', state: 'starting' },
      { type: 'state', state: 'downloading', received: 1, total: 2 },
      { type: 'state', state: 'recording' },
    ]);
    c.ws.send(frame(1));
    c.ws.send(frame(0));
    c.ws.send(frame(2));
    c.ws.send(frame(9));
    c.ws.send(JSON.stringify({ type: 'stop' }));
    expect(await c.closed).toBe(1000);
    expect(c.messages.slice(3)).toEqual([
      { type: 'segment', sequence: 1, text: 'seg1' },
      { type: 'segment', sequence: 2, text: 'seg2' },
      { type: 'segment', sequence: 3, text: 'seg9' },
      { type: 'state', state: 'finished' },
    ]);
    expect(calls.map((x) => x.first)).toEqual([1, 2, 9]);
    expect(calls[0]!.language).toBe('he');
    expect(calls[0]!.prompt).toBe(SEED_PROMPT.he);
    expect(calls[1]!.prompt).toBe('seg1');
    expect(calls[2]!.prompt).toBe('seg1 seg2');
    expect(engine.touch).toHaveBeenCalled();
  });
  it('sends a repetitive segment but keeps it out of the prompt for later requests', async () => {
    const texts: Record<number, string> = {
      1: 'שלום לכולם',
      2: 'בדיקה, בדיקה, בדיקה, בדיקה, בדיקה',
      3: 'מה שלומך',
      4: 'אחרון',
    };
    const { engine, calls } = fakeEngine({
      transcribe: async (s, o) => {
        calls.push({ first: s[0]!, ...o });
        return { text: texts[s[0]!]!, noSpeech: false };
      },
    });
    const { connect } = await setup(engine);
    const c = connect();
    await opened(c.ws);
    await c.until((m) => m.length === 3);
    c.ws.send(frame(1));
    c.ws.send(frame(2));
    c.ws.send(frame(3));
    c.ws.send(frame(4));
    c.ws.send(JSON.stringify({ type: 'stop' }));
    await c.closed;
    expect(c.messages.filter((m) => m.type === 'segment')).toEqual([
      { type: 'segment', sequence: 1, text: 'שלום לכולם' },
      { type: 'segment', sequence: 2, text: 'בדיקה, בדיקה, בדיקה,' },
      { type: 'segment', sequence: 3, text: 'מה שלומך' },
      { type: 'segment', sequence: 4, text: 'אחרון' },
    ]);
    expect(calls.map((x) => x.prompt)).toEqual([
      SEED_PROMPT.he,
      'שלום לכולם',
      undefined,
      'שלום לכולם מה שלומך',
    ]);
  });
  it('seeds with the recording language', async () => {
    const { engine, calls } = fakeEngine();
    const { connect } = await setup(engine);
    const c = connect('capability=cap&session=s1&language=en');
    await opened(c.ws);
    await c.until((m) => m.length === 3);
    c.ws.send(frame(1));
    c.ws.send(JSON.stringify({ type: 'stop' }));
    await c.closed;
    expect(calls[0]!.prompt).toBe(SEED_PROMPT.en);
  });
  it('drops filler and no-speech results without consuming a sequence number', async () => {
    const { engine } = fakeEngine({
      transcribe: async (s) =>
        s[0] === 1
          ? { text: 'תודה רבה.', noSpeech: false }
          : s[0] === 2
            ? { text: 'x', noSpeech: true }
            : { text: 'ok', noSpeech: false },
    });
    const { connect } = await setup(engine);
    const c = connect();
    await opened(c.ws);
    await c.until((m) => m.length === 3);
    c.ws.send(frame(1));
    c.ws.send(frame(2));
    c.ws.send(frame(3));
    c.ws.send(JSON.stringify({ type: 'stop' }));
    await c.closed;
    expect(c.messages.filter((m) => m.type === 'segment')).toEqual([
      { type: 'segment', sequence: 1, text: 'ok' },
    ]);
  });
  it('ignores odd-length binary frames and text that is not a stop', async () => {
    const { engine, calls } = fakeEngine();
    const { connect } = await setup(engine);
    const c = connect();
    await opened(c.ws);
    await c.until((m) => m.length === 3);
    c.ws.send(Buffer.concat([frame(1), Buffer.from([7])]));
    c.ws.send('not json');
    c.ws.send(JSON.stringify({ type: 'other' }));
    c.ws.send(frame(2));
    c.ws.send(JSON.stringify({ type: 'stop' }));
    await c.closed;
    expect(calls.map((x) => x.first)).toEqual([2]);
  });
  it('closes an abusive connection sending frames over the payload cap without crashing', async () => {
    const { engine } = fakeEngine();
    const { connect } = await setup(engine);
    const c = connect();
    await opened(c.ws);
    await c.until((m) => m.length === 3);
    c.ws.send(Buffer.alloc(MAX_AUDIO_MESSAGE_BYTES + 6 * 1024));
    expect(await c.closed).not.toBe(1000);
    const d = connect();
    await opened(d.ws);
    d.ws.close(); // the server is still alive
  });
  it('sends a segment-lost notice for one failure and engine-failed after three in a row', async () => {
    let n = 0;
    const { engine } = fakeEngine({
      transcribe: async () => {
        n++;
        throw new Error('http 500');
      },
    });
    const { connect } = await setup(engine);
    const c = connect();
    await opened(c.ws);
    await c.until((m) => m.length === 3);
    c.ws.send(frame(1));
    await c.until((m) => m.some((x) => x.type === 'notice'));
    expect(c.messages.at(-1)).toEqual({ type: 'notice', code: 'segment-lost' });
    c.ws.send(frame(2));
    c.ws.send(frame(3));
    expect(await c.closed).toBe(1011);
    expect(c.messages.at(-1)).toMatchObject({ type: 'error', code: 'engine-failed' });
    expect(n).toBe(MAX_CONSECUTIVE_FAILURES);
  });
  it('ends immediately with engine-failed when the engine reports a crash', async () => {
    const { engine } = fakeEngine({
      transcribe: async () => {
        throw new DictationFailure('engine-failed', 'gone');
      },
    });
    const { connect } = await setup(engine);
    const c = connect();
    await opened(c.ws);
    await c.until((m) => m.length === 3);
    c.ws.send(frame(1));
    expect(await c.closed).toBe(1011);
    expect(c.messages.at(-1)).toEqual({ type: 'error', code: 'engine-failed', message: 'gone' });
  });
  it('reports download-failed from ensureReady', async () => {
    const { engine } = fakeEngine({
      ensureReady: async () => {
        throw new DictationFailure('download-failed', 'Network error');
      },
    });
    const { connect } = await setup(engine);
    const c = connect();
    await opened(c.ws);
    expect(await c.closed).toBe(1011);
    expect(c.messages.at(-1)).toEqual({
      type: 'error',
      code: 'download-failed',
      message: 'Network error',
    });
  });
  it('reports engine-missing from ensureReady', async () => {
    const { engine } = fakeEngine({
      ensureReady: async () => {
        throw new DictationFailure('engine-missing', 'No engine');
      },
    });
    const { connect } = await setup(engine);
    const c = connect();
    await opened(c.ws);
    expect(await c.closed).toBe(1011);
    expect(c.messages.at(-1)).toEqual({
      type: 'error',
      code: 'engine-missing',
      message: 'No engine',
    });
  });
  it('lets an in-flight transcription finish when stop arrives, before finished', async () => {
    let release: (() => void) | undefined;
    const { engine } = fakeEngine({
      transcribe: () =>
        new Promise((r) => {
          release = () => r({ text: 'slow', noSpeech: false });
        }),
    });
    const { connect } = await setup(engine);
    const c = connect();
    await opened(c.ws);
    await c.until((m) => m.length === 3);
    c.ws.send(frame(1));
    await new Promise((r) => setTimeout(r, 20));
    c.ws.send(JSON.stringify({ type: 'stop' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(c.messages).toHaveLength(3);
    release?.();
    expect(await c.closed).toBe(1000);
    expect(c.messages.slice(3)).toEqual([
      { type: 'segment', sequence: 1, text: 'slow' },
      { type: 'state', state: 'finished' },
    ]);
  });
  it('transcribes audio sent before recording when stop arrives while the engine is still starting', async () => {
    let ready: (() => void) | undefined;
    const { engine, calls } = fakeEngine({
      ensureReady: () =>
        new Promise<void>((r) => {
          ready = r;
        }),
    });
    const { connect } = await setup(engine);
    const c = connect();
    await opened(c.ws);
    await c.until((m) => m.length === 1);
    c.ws.send(frame(1));
    c.ws.send(frame(2));
    c.ws.send(frame(9));
    c.ws.send(JSON.stringify({ type: 'stop' }));
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(0);
    ready?.();
    expect(await c.closed).toBe(1000);
    expect(c.messages).toEqual([
      { type: 'state', state: 'starting' },
      { type: 'state', state: 'recording' },
      { type: 'segment', sequence: 1, text: 'seg1' },
      { type: 'segment', sequence: 2, text: 'seg2' },
      { type: 'segment', sequence: 3, text: 'seg9' },
      { type: 'state', state: 'finished' },
    ]);
  });
  it('does not start the maximum-duration timer until recording begins', async () => {
    let ready: (() => void) | undefined;
    const { engine } = fakeEngine({
      ensureReady: () =>
        new Promise<void>((r) => {
          ready = r;
        }),
    });
    const { connect } = await setup(engine, { maxRecordingMs: 100 });
    const c = connect();
    await opened(c.ws);
    await new Promise((r) => setTimeout(r, 250));
    expect(c.messages).toEqual([{ type: 'state', state: 'starting' }]);
    ready?.();
    expect(await c.closed).toBe(1000);
    expect(c.messages.slice(1, 3)).toEqual([
      { type: 'state', state: 'recording' },
      { type: 'notice', code: 'max-duration' },
    ]);
  });
  it('stops by itself at the maximum duration with a notice, flushing the last segment', async () => {
    const { engine, calls } = fakeEngine();
    const { connect } = await setup(engine, { maxRecordingMs: 200 });
    const c = connect();
    await opened(c.ws);
    await c.until((m) => m.length === 3);
    c.ws.send(frame(9));
    expect(await c.closed).toBe(1000);
    expect(c.messages.slice(3)).toEqual([
      { type: 'notice', code: 'max-duration' },
      { type: 'segment', sequence: 1, text: 'seg9' },
      { type: 'state', state: 'finished' },
    ]);
    expect(calls).toHaveLength(1);
  });
  it('abandons pending work when the client disconnects and never writes to a closed socket', async () => {
    let release: (() => void) | undefined;
    const { engine } = fakeEngine({
      transcribe: () =>
        new Promise((r) => {
          release = () => r({ text: 'late', noSpeech: false });
        }),
    });
    const { connect } = await setup(engine);
    const c = connect();
    await opened(c.ws);
    await c.until((m) => m.length === 3);
    c.ws.send(frame(1));
    await new Promise((r) => setTimeout(r, 20));
    c.ws.terminate();
    await c.closed;
    release?.();
    await new Promise((r) => setTimeout(r, 20)); // no throw
    expect(c.messages.filter((m) => m.type === 'segment')).toHaveLength(0);
  });
});
