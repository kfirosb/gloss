// tests/runtime/dictation-engine.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDictationEngine, whisperCandidates, type EngineProcess } from '../../src/runtime/dictation/engine.js';
import type { ModelStore } from '../../src/runtime/dictation/model.js';

const model = (overrides: Partial<ModelStore> = {}): ModelStore => ({ path: '/m/model.bin', present: async () => ({ present: true, bytes: 1 }), ensure: async () => '/m/model.bin', invalidate: vi.fn(), cancel: vi.fn(), ...overrides });
function fakeSpawn() {
  const procs: { args: string[]; exit: (code: number | null) => void; killed: boolean; stderr: (text: string) => void }[] = [];
  const spawn = (_binary: string, args: string[]): EngineProcess => {
    let onExit: (code: number | null) => void = () => undefined; let onStderr: (text: string) => void = () => undefined;
    const entry = { args, exit: (code: number | null) => onExit(code), killed: false, stderr: (text: string) => onStderr(text) };
    procs.push(entry);
    return { pid: procs.length, kill: () => { entry.killed = true; onExit(null); }, onExit: cb => { onExit = cb; }, onStderr: cb => { onStderr = cb; } };
  };
  return { spawn, procs };
}
/** Ready after `readyAfter` polls; records inference requests and answers with `reply`. */
function fakeFetch(opts: { readyAfter?: number; reply?: (form: FormData) => unknown; fail?: boolean } = {}) {
  const requests: FormData[] = []; let polls = 0;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!init?.method || init.method === 'GET') { polls++; return new Response(polls > (opts.readyAfter ?? 0) ? 'ok' : null, { status: polls > (opts.readyAfter ?? 0) ? 200 : 503 }); }
    if (opts.fail) return new Response('boom', { status: 500 });
    const form = init.body as FormData; requests.push(form);
    return new Response(JSON.stringify(opts.reply?.(form) ?? { text: ' שלום ', segments: [{ no_speech_prob: 0.1 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: f, requests, polls: () => polls, url: () => '' };
}
beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());

describe('whisperCandidates', () => {
  it('prefers the explicit env path, then resources, then the repo vendor dir', () => {
    const c = whisperCandidates({ LANGUAGE_ASSISTANT_WHISPER: '/bundle/bin/whisper-server' }, '/App/Resources');
    expect(c[0]).toBe('/bundle/bin/whisper-server'); expect(c[1]).toBe('/App/Resources/bin/whisper-server'); expect(c[2]).toMatch(/vendor\/whisper\/bin\/whisper-server$/);
    expect(whisperCandidates({ LANGUAGE_ASSISTANT_WHISPER: 'relative/path' }, undefined)).toHaveLength(1);
  });
  it('resolves the vendor binary at the repository root from source and from the build', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..'); const vendor = join(repoRoot, 'vendor', 'whisper', 'bin', 'whisper-server');
    expect(whisperCandidates({}, undefined)).toEqual([vendor]);
    expect(whisperCandidates({}, undefined, join(repoRoot, 'src', 'runtime', 'dictation'))).toEqual([vendor]);
    expect(whisperCandidates({}, undefined, join(repoRoot, 'dist', 'server', 'runtime', 'dictation'))).toEqual([vendor]);
  });
  it('omits the vendor candidate when no language-assistant package.json is found', () => {
    expect(whisperCandidates({}, '/App/Resources', '/')).toEqual(['/App/Resources/bin/whisper-server']);
  });
});

describe('createDictationEngine', () => {
  it('reports engine-missing without a binary and never spawns', async () => {
    const { spawn, procs } = fakeSpawn();
    const engine = createDictationEngine({ binary: undefined, model: model(), spawn, fetch: fakeFetch().fetch, freePort: async () => 1 });
    expect(engine.available()).toEqual({ available: false, reason: 'engine-missing' });
    await expect(engine.ensureReady(() => undefined)).rejects.toMatchObject({ code: 'engine-missing' });
    expect(procs).toHaveLength(0);
  });
  it('downloads the model, spawns once on loopback, polls readiness and transcribes in order with language and prompt', async () => {
    const { spawn, procs } = fakeSpawn(); const net = fakeFetch({ readyAfter: 2 });
    const progress = vi.fn(); const ensure = vi.fn(async (p: (r: number, t: number | null) => void) => { p(5, 10); return '/m/model.bin'; });
    const engine = createDictationEngine({ binary: '/bin/whisper-server', model: model({ ensure }), spawn, fetch: net.fetch, freePort: async () => 43210, pollMs: 100, threads: 4 });
    const ready = engine.ensureReady(progress);
    await vi.advanceTimersByTimeAsync(350); await ready;
    expect(progress).toHaveBeenCalledWith(5, 10);
    expect(procs).toHaveLength(1); expect(procs[0]!.args).toEqual(['--host', '127.0.0.1', '--port', '43210', '-m', '/m/model.bin', '-t', '4']);
    expect(engine.state()).toBe('running');
    await engine.ensureReady(progress); expect(procs).toHaveLength(1); // reused
    const a = engine.transcribe(Int16Array.from([1, 2, 3]), { language: 'he', prompt: 'קודם' });
    const b = engine.transcribe(Int16Array.from([4]), { language: 'en' });
    expect(await a).toEqual({ text: ' שלום ', noSpeech: false }); await b;
    expect(net.requests).toHaveLength(2);
    expect(net.requests[0]!.get('language')).toBe('he'); expect(net.requests[0]!.get('prompt')).toBe('קודם'); expect(net.requests[0]!.get('response_format')).toBe('verbose_json'); expect(net.requests[0]!.get('no_language_probabilities')).toBe('true');
    expect((net.requests[0]!.get('file') as File).size).toBe(44 + 6);
    expect(net.requests[1]!.get('language')).toBe('en'); expect(net.requests[1]!.has('prompt')).toBe(false);
  });
  it('flags no-speech when every segment is improbable', async () => {
    const { spawn } = fakeSpawn(); const net = fakeFetch({ reply: () => ({ text: 'תודה', segments: [{ no_speech_prob: 0.9 }, { no_speech_prob: 0.7 }] }) });
    const engine = createDictationEngine({ binary: '/b', model: model(), spawn, fetch: net.fetch, freePort: async () => 1, pollMs: 10 });
    const ready = engine.ensureReady(() => undefined); await vi.advanceTimersByTimeAsync(50); await ready;
    expect(await engine.transcribe(Int16Array.from([1]), { language: 'he' })).toEqual({ text: 'תודה', noSpeech: true });
  });
  it('fails start after the timeout, kills the child and invalidates the model', async () => {
    const { spawn, procs } = fakeSpawn(); const net = fakeFetch({ readyAfter: 1000 }); const m = model();
    const engine = createDictationEngine({ binary: '/b', model: m, spawn, fetch: net.fetch, freePort: async () => 1, pollMs: 100, startTimeoutMs: 1000 });
    const ready = engine.ensureReady(() => undefined); const outcome = ready.catch(e => e);
    await vi.advanceTimersByTimeAsync(1500);
    expect((await outcome).code).toBe('engine-failed'); expect(procs[0]!.killed).toBe(true); expect(m.invalidate).toHaveBeenCalled(); expect(engine.state()).toBe('stopped');
  });
  it('logs the last stderr lines (bounded) only when start times out', async () => {
    const { spawn, procs } = fakeSpawn(); const net = fakeFetch({ readyAfter: 1000 }); const log = vi.fn();
    const engine = createDictationEngine({ binary: '/b', model: model(), spawn, fetch: net.fetch, freePort: async () => 1, pollMs: 100, startTimeoutMs: 1000, log });
    const outcome = engine.ensureReady(() => undefined).catch(e => e);
    await vi.advanceTimersByTimeAsync(0);
    procs[0]!.stderr(Array.from({ length: 30 }, (_, i) => 'line ' + i).join('\n') + '\nload'); procs[0]!.stderr('ing model failed\n');
    expect(log.mock.calls.flat().filter(l => String(l).startsWith('dictation-engine stderr:'))).toEqual([]);
    await vi.advanceTimersByTimeAsync(1500); await outcome;
    const lines = log.mock.calls.flat().filter(l => String(l).startsWith('dictation-engine stderr:'));
    expect(lines).toHaveLength(20); expect(lines[0]).toBe('dictation-engine stderr: line 11'); expect(lines.at(-1)).toBe('dictation-engine stderr: loading model failed');
  });
  it('logs stderr on an unexpected exit but never on a clean idle exit', async () => {
    const { spawn, procs } = fakeSpawn(); const log = vi.fn();
    const engine = createDictationEngine({ binary: '/b', model: model(), spawn, fetch: fakeFetch().fetch, freePort: async () => 1, pollMs: 10, idleMs: 1000, log });
    const ready = engine.ensureReady(() => undefined); await vi.advanceTimersByTimeAsync(0); procs[0]!.stderr('whisper_init: ok\n'); await vi.advanceTimersByTimeAsync(20); await ready;
    await vi.advanceTimersByTimeAsync(1100); expect(procs[0]!.killed).toBe(true);
    expect(log.mock.calls.flat().some(l => String(l).startsWith('dictation-engine stderr:'))).toBe(false);
    const again = engine.ensureReady(() => undefined); await vi.advanceTimersByTimeAsync(20); await again;
    procs[1]!.stderr('ggml_metal: out of memory\n'); procs[1]!.exit(134);
    expect(log).toHaveBeenCalledWith('dictation-engine stderr: ggml_metal: out of memory');
    expect(log.mock.calls.flat().filter(l => String(l).startsWith('dictation-engine stderr:'))).toEqual(['dictation-engine stderr: ggml_metal: out of memory']);
  });
  it('reports engine-failed when the child exits during a request and starts fresh afterwards', async () => {
    const { spawn, procs } = fakeSpawn();
    let release: (() => void) | undefined;
    const f = (async (_i: unknown, init?: RequestInit) => { if (init?.method === 'GET') return new Response('ok', { status: 200 }); await new Promise<void>(r => { release = r; }); return new Response('{}', { status: 200 }); }) as typeof fetch;
    const engine = createDictationEngine({ binary: '/b', model: model(), spawn, fetch: f, freePort: async () => 1, pollMs: 10 });
    const ready = engine.ensureReady(() => undefined); await vi.advanceTimersByTimeAsync(20); await ready;
    const pending = engine.transcribe(Int16Array.from([1]), { language: 'he' }).catch(e => e);
    await vi.advanceTimersByTimeAsync(0); procs[0]!.exit(1); release?.();
    expect((await pending).code).toBe('engine-failed'); expect(engine.state()).toBe('stopped');
    const again = engine.ensureReady(() => undefined); await vi.advanceTimersByTimeAsync(20); await again; expect(procs).toHaveLength(2);
  });
  it('treats a non-200 inference response as a plain error, not a crash', async () => {
    const { spawn } = fakeSpawn(); const net = fakeFetch({ fail: true });
    const engine = createDictationEngine({ binary: '/b', model: model(), spawn, fetch: net.fetch, freePort: async () => 1, pollMs: 10 });
    const ready = engine.ensureReady(() => undefined); await vi.advanceTimersByTimeAsync(20); await ready;
    const error = await engine.transcribe(Int16Array.from([1]), { language: 'he' }).catch(e => e);
    expect(error).toBeInstanceOf(Error); expect(error.code).toBeUndefined(); expect(engine.state()).toBe('running');
  });
  it('exits after the idle period and touch() postpones it', async () => {
    const { spawn, procs } = fakeSpawn(); const net = fakeFetch();
    const engine = createDictationEngine({ binary: '/b', model: model(), spawn, fetch: net.fetch, freePort: async () => 1, pollMs: 10, idleMs: 1000 });
    const ready = engine.ensureReady(() => undefined); await vi.advanceTimersByTimeAsync(20); await ready;
    await vi.advanceTimersByTimeAsync(800); engine.touch(); await vi.advanceTimersByTimeAsync(800);
    expect(procs[0]!.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(300); expect(procs[0]!.killed).toBe(true); expect(engine.state()).toBe('stopped');
  });
  it('close() kills a running engine and cancelDownload() forwards to the store', async () => {
    const { spawn, procs } = fakeSpawn(); const net = fakeFetch(); const m = model();
    const engine = createDictationEngine({ binary: '/b', model: m, spawn, fetch: net.fetch, freePort: async () => 1, pollMs: 10 });
    const ready = engine.ensureReady(() => undefined); await vi.advanceTimersByTimeAsync(20); await ready;
    engine.cancelDownload(); expect(m.cancel).toHaveBeenCalled();
    engine.close(); expect(procs[0]!.killed).toBe(true);
  });
  it('close() during the model download aborts the pending start without spawning, and a fresh start works', async () => {
    const { spawn, procs } = fakeSpawn(); const net = fakeFetch();
    let release: (() => void) | undefined;
    const ensure = vi.fn(async () => { await new Promise<void>(r => { release = r; }); return '/m/model.bin'; });
    const engine = createDictationEngine({ binary: '/b', model: model({ ensure }), spawn, fetch: net.fetch, freePort: async () => 1, pollMs: 10 });
    const first = engine.ensureReady(() => undefined).catch(e => e);
    await vi.advanceTimersByTimeAsync(0); engine.close(); release?.();
    expect((await first).code).toBe('engine-failed');
    expect(procs).toHaveLength(0); expect(engine.state()).toBe('stopped');
    const again = engine.ensureReady(() => undefined); await vi.advanceTimersByTimeAsync(0); release?.(); await vi.advanceTimersByTimeAsync(20); await again;
    expect(procs).toHaveLength(1); expect(engine.state()).toBe('running');
  });
  it('does not idle-kill the engine while an inference started near the end of the idle window is in flight', async () => {
    const { spawn, procs } = fakeSpawn();
    let release: (() => void) | undefined;
    const f = (async (_i: unknown, init?: RequestInit) => { if (init?.method === 'GET') return new Response('ok', { status: 200 }); await new Promise<void>(r => { release = r; }); return new Response(JSON.stringify({ text: 'hi', segments: [] }), { status: 200 }); }) as typeof fetch;
    const engine = createDictationEngine({ binary: '/b', model: model(), spawn, fetch: f, freePort: async () => 1, pollMs: 10, idleMs: 1000 });
    const ready = engine.ensureReady(() => undefined); await vi.advanceTimersByTimeAsync(20); await ready;
    await vi.advanceTimersByTimeAsync(900);
    const pending = engine.transcribe(Int16Array.from([1]), { language: 'he' });
    await vi.advanceTimersByTimeAsync(500);
    expect(procs[0]!.killed).toBe(false);
    release?.(); expect(await pending).toEqual({ text: 'hi', noSpeech: false });
  });
});
