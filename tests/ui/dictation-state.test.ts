import { describe, expect, it } from 'vitest';
import { appendDictation, dictationLabel, initialDictationState, reduceDictation, STOP_TIMEOUT_MS, type DictationUiState } from '../../src/ui/dictation-state.js';
import { REFERENCE_MARK } from '../../src/ui/session-client.js';
import { DICTATION_REASON_TEXT, FINISH_TIMEOUT_MS } from '../../src/core/dictation-contracts.js';

const run = (events: Parameters<typeof reduceDictation>[1][], start: DictationUiState = initialDictationState) => events.reduce((acc, e) => { const r = reduceDictation(acc.state, e); return { state: r.state, effects: [...acc.effects, ...r.effects] }; }, { state: start, effects: [] as ReturnType<typeof reduceDictation>['effects'] });
const recording = () => run([{ type: 'press', now: 1000 }, { type: 'mic-ready' }, { type: 'server', message: { type: 'state', state: 'recording' } }]).state;

describe('appendDictation', () => {
  it('adds exactly one space between existing text and the segment', () => {
    expect(appendDictation('', 'שלום')).toBe('שלום'); expect(appendDictation('שלום', 'עולם')).toBe('שלום עולם');
    expect(appendDictation('שלום ', 'עולם')).toBe('שלום עולם'); expect(appendDictation('שלום\n', 'עולם')).toBe('שלום\nעולם');
    expect(appendDictation('see ' + REFERENCE_MARK + '@File 1 ', 'עולם')).toBe('see ' + REFERENCE_MARK + '@File 1 עולם');
  });
});
describe('reduceDictation', () => {
  it('walks idle → request mic → open socket and capture → recording', () => {
    const r = run([{ type: 'press', now: 1000 }]); expect(r.state.phase).toBe('starting'); expect(r.effects).toEqual([{ type: 'request-mic' }]);
    const s = run([{ type: 'mic-ready' }], r.state); expect(s.effects).toEqual([{ type: 'open-socket' }, { type: 'start-stream' }]);
    const t = run([{ type: 'server', message: { type: 'state', state: 'downloading', received: 10, total: 100 } }], s.state);
    expect(t.state).toMatchObject({ phase: 'downloading', received: 10, total: 100 });
    const u = run([{ type: 'server', message: { type: 'state', state: 'starting' } }, { type: 'server', message: { type: 'state', state: 'recording' } }], t.state);
    expect(u.state.phase).toBe('recording'); expect(u.state.startedAt).toBe(1000); expect(u.effects).toEqual([]);
  });
  it('cancelling a download releases the microphone so the next press starts afresh', () => {
    const d = run([{ type: 'press', now: 1 }, { type: 'mic-ready' }, { type: 'server', message: { type: 'state', state: 'downloading', received: 0, total: 10 } }]);
    expect(d.effects).toContainEqual({ type: 'start-stream' });
    const c = reduceDictation(d.state, { type: 'press', now: 2 }); expect(c.effects).toContainEqual({ type: 'stop-stream' });
    const again = run([{ type: 'press', now: 3 }, { type: 'mic-ready' }], c.state); expect(again.state.phase).toBe('starting'); expect(again.effects).toEqual([{ type: 'request-mic' }, { type: 'open-socket' }, { type: 'start-stream' }]);
  });
  it('captures while the engine starts: recording after starting only changes the phase', () => {
    const s = run([{ type: 'press', now: 1000 }, { type: 'mic-ready' }, { type: 'server', message: { type: 'state', state: 'starting' } }]);
    expect(s.state.phase).toBe('starting'); expect(s.effects.filter(e => e.type === 'start-stream')).toHaveLength(1);
    const r = reduceDictation(s.state, { type: 'server', message: { type: 'state', state: 'recording' } });
    expect(r.state.phase).toBe('recording'); expect(r.effects).toEqual([]);
  });
  it('appends segments in order and ignores replays', () => {
    const r = run([{ type: 'server', message: { type: 'segment', sequence: 1, text: 'a' } }, { type: 'server', message: { type: 'segment', sequence: 1, text: 'a' } }, { type: 'server', message: { type: 'segment', sequence: 2, text: 'b' } }], recording());
    expect(r.effects).toEqual([{ type: 'append-text', text: 'a' }, { type: 'append-text', text: 'b' }]); expect(r.state.lastSequence).toBe(2);
  });
  it('denied microphone becomes unavailable with the settings hint', () => {
    const r = run([{ type: 'press', now: 1 }, { type: 'mic-denied' }]); expect(r.state.phase).toBe('unavailable'); expect(r.state.reason).toMatch(/System Settings/);
    expect(reduceDictation(r.state, { type: 'press', now: 2 }).effects).toEqual([]);
  });
  it('press while downloading cancels; press or Escape while recording stops and finishes', () => {
    const d = run([{ type: 'press', now: 1 }, { type: 'mic-ready' }, { type: 'server', message: { type: 'state', state: 'downloading', received: 0, total: null } }]);
    const c = reduceDictation(d.state, { type: 'press', now: 2 }); expect(c.state.phase).toBe('idle'); expect(c.effects).toEqual([{ type: 'cancel-download' }, { type: 'close-socket' }, { type: 'stop-stream' }]);
    const p = reduceDictation(recording(), { type: 'press', now: 3 }); expect(p.state.phase).toBe('finishing'); expect(p.effects).toEqual([{ type: 'send-stop' }, { type: 'stop-stream' }, { type: 'start-finish-timer', ms: STOP_TIMEOUT_MS }]);
    const e = reduceDictation(recording(), { type: 'escape' }); expect(e.state.phase).toBe('finishing'); expect(e.state.sendAfterFinish).toBe(false);
    const f = reduceDictation(p.state, { type: 'server', message: { type: 'state', state: 'finished' } }); expect(f.state.phase).toBe('idle'); expect(f.effects).toEqual([{ type: 'clear-finish-timer' }, { type: 'close-socket' }]);
  });
  it('send while recording waits for finished, then sends; the 5 s fallback sends anyway', () => {
    const s = reduceDictation(recording(), { type: 'send-requested' });
    expect(s.state).toMatchObject({ phase: 'finishing', sendAfterFinish: true }); expect(s.effects).toEqual([{ type: 'send-stop' }, { type: 'stop-stream' }, { type: 'start-finish-timer', ms: FINISH_TIMEOUT_MS }]);
    const late = reduceDictation(s.state, { type: 'server', message: { type: 'segment', sequence: 1, text: 'last' } }); expect(late.effects).toEqual([{ type: 'append-text', text: 'last' }]);
    const f = reduceDictation(late.state, { type: 'server', message: { type: 'state', state: 'finished' } });
    expect(f.state.phase).toBe('idle'); expect(f.effects).toEqual([{ type: 'clear-finish-timer' }, { type: 'close-socket' }, { type: 'send-now' }]);
    const t = reduceDictation(s.state, { type: 'finish-timeout' }); expect(t.state.phase).toBe('idle'); expect(t.effects).toEqual([{ type: 'close-socket' }, { type: 'send-now' }]);
    expect(reduceDictation(initialDictationState, { type: 'send-requested' }).effects).toEqual([{ type: 'send-now' }]);
  });
  it('a plain stop has its own timeout that never sends; a send-initiated stop times out into sending', () => {
    const e = reduceDictation(recording(), { type: 'escape' }); expect(e.effects).toEqual([{ type: 'send-stop' }, { type: 'stop-stream' }, { type: 'start-finish-timer', ms: STOP_TIMEOUT_MS }]);
    const t = reduceDictation(e.state, { type: 'finish-timeout' }); expect(t.state.phase).toBe('idle'); expect(t.effects).toEqual([{ type: 'close-socket' }]);
    const s = reduceDictation(recording(), { type: 'send-requested' });
    const u = reduceDictation(s.state, { type: 'finish-timeout' }); expect(u.state.phase).toBe('idle'); expect(u.effects).toEqual([{ type: 'close-socket' }, { type: 'send-now' }]);
    const later = reduceDictation(e.state, { type: 'send-requested' }); expect(later.state.sendAfterFinish).toBe(true); expect(later.effects).toEqual([{ type: 'start-finish-timer', ms: FINISH_TIMEOUT_MS }]);
  });
  it('server errors stop the stream and show a message; retry returns to idle', () => {
    const e = reduceDictation(recording(), { type: 'server', message: { type: 'error', code: 'engine-failed', message: 'Speech engine did not start' } });
    expect(e.state).toMatchObject({ phase: 'error', message: 'Speech engine did not start' }); expect(e.effects).toEqual([{ type: 'stop-stream' }]);
    expect(reduceDictation(e.state, { type: 'retry' }).state.phase).toBe('idle');
    const m = reduceDictation(recording(), { type: 'server', message: { type: 'error', code: 'engine-missing', message: DICTATION_REASON_TEXT['engine-missing'] } }); expect(m.state.phase).toBe('unavailable');
  });
  it('an unclean close mid-recording is connection-lost and still honours a pending send', () => {
    const r = reduceDictation(recording(), { type: 'socket-closed', clean: false }); expect(r.state).toMatchObject({ phase: 'error', message: expect.stringMatching(/connection/i) });
    const pending = reduceDictation(recording(), { type: 'send-requested' }).state;
    expect(reduceDictation(pending, { type: 'socket-closed', clean: false }).effects).toContainEqual({ type: 'send-now' });
    expect(reduceDictation(initialDictationState, { type: 'socket-closed', clean: true }).state.phase).toBe('idle');
  });
  it('notices are shown and dismissed; max-duration moves to finishing and stops the stream', () => {
    const n = reduceDictation(recording(), { type: 'server', message: { type: 'notice', code: 'segment-lost' } }); expect(n.state.notice).toMatch(/segment/i);
    expect(reduceDictation(n.state, { type: 'dismiss-notice' }).state.notice).toBeUndefined();
    const m = reduceDictation(recording(), { type: 'server', message: { type: 'notice', code: 'max-duration' } });
    expect(m.state.phase).toBe('finishing'); expect(m.state.notice).toMatch(/10 minutes/); expect(m.state.sendAfterFinish).toBe(false); expect(m.effects).toEqual([{ type: 'stop-stream' }, { type: 'start-finish-timer', ms: STOP_TIMEOUT_MS }]);
  });
  it('the 10-minute cap ends cleanly: notice → last segment → finished → clean close is idle, not connection-lost', () => {
    const r = run([{ type: 'server', message: { type: 'notice', code: 'max-duration' } }, { type: 'server', message: { type: 'segment', sequence: 1, text: 'tail' } }, { type: 'server', message: { type: 'state', state: 'finished' } }, { type: 'socket-closed', clean: true }], recording());
    expect(r.state.phase).toBe('idle'); expect(r.state.message).toBeUndefined(); expect(r.state.notice).toMatch(/10 minutes/);
    const types = r.effects.map(e => e.type); expect(types).toContain('append-text'); expect(types.indexOf('close-socket')).toBeGreaterThan(types.indexOf('append-text'));
  });
  it('finished is accepted from any active phase and honours a pending send', () => {
    const f = reduceDictation(recording(), { type: 'server', message: { type: 'state', state: 'finished' } }); expect(f.state.phase).toBe('idle'); expect(f.effects).toEqual([{ type: 'stop-stream' }, { type: 'close-socket' }]);
    const pending = { ...recording(), sendAfterFinish: true };
    expect(reduceDictation(pending, { type: 'server', message: { type: 'state', state: 'finished' } }).effects).toEqual([{ type: 'clear-finish-timer' }, { type: 'stop-stream' }, { type: 'close-socket' }, { type: 'send-now' }]);
  });
  it('status gates availability and a session change abandons the recording without sending', () => {
    expect(reduceDictation(initialDictationState, { type: 'status', status: { available: false, reason: 'engine-missing', model: { present: false }, engine: 'stopped' } }).state).toMatchObject({ phase: 'unavailable', reason: DICTATION_REASON_TEXT['engine-missing'] });
    expect(reduceDictation(initialDictationState, { type: 'status-failed' }).state.phase).toBe('unavailable');
    const pending = reduceDictation(recording(), { type: 'send-requested' }).state;
    const s = reduceDictation(pending, { type: 'session-changed' }); expect(s.state.phase).toBe('idle'); expect(s.effects).toEqual([{ type: 'close-socket' }, { type: 'stop-stream' }]);
  });
  it('labels every phase, with indeterminate progress when the total is unknown', () => {
    expect(dictationLabel(initialDictationState, 'he').title).toBe('Dictate in Hebrew'); expect(dictationLabel(initialDictationState, 'en').title).toBe('Dictate in English');
    expect(dictationLabel({ ...initialDictationState, phase: 'downloading', received: 50 * 1024 * 1024, total: 100 * 1024 * 1024 }, 'he')).toEqual({ title: 'Downloading the speech model, you can talk now, click to cancel', progress: '50%' });
    expect(dictationLabel({ ...initialDictationState, phase: 'starting' }, 'he').title).toBe('Starting the speech engine, you can talk now');
    expect(dictationLabel({ ...initialDictationState, phase: 'downloading', received: 50 * 1024 * 1024, total: null }, 'he').progress).toBe('50 MB');
    expect(dictationLabel({ ...initialDictationState, phase: 'recording' }, 'he').title).toBe('Stop dictation');
    expect(dictationLabel({ ...initialDictationState, phase: 'unavailable', reason: 'x' }, 'he').title).toBe('Dictation unavailable: x');
  });
});
