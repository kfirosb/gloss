import { describe, expect, it } from 'vitest';
import type { ActivityCall, ActivityEvent } from '../../src/core/activity-contracts.js';
import { emptyActivity } from '../../src/core/activity-reducer.js';
import {
  StreamSlots,
  foldStreamEvents,
  recallStream,
  rememberStream,
} from '../../src/ui/use-activity-streams.js';

const call = (id: string, position: number): ActivityCall => ({
  id,
  tool: 'Read',
  summary: 'src/ui/live-view.ts',
  input: '{"file_path":"src/ui/live-view.ts"}',
  position,
  depth: 1,
});
const callEvent = (id: string, position: number): ActivityEvent => ({
  kind: 'call',
  call: call(id, position),
});

describe('subagent stream fold', () => {
  it('folds an event from the current stream into its state', () => {
    const current = { key: 's1:a1', state: emptyActivity() };
    const next = foldStreamEvents('s1:a1', current, 's1:a1', callEvent('c1', 10));
    expect(next.key).toBe('s1:a1');
    expect(next.state.calls.map((c) => c.id)).toEqual(['c1']);
  });

  it('drops a late event from a previous session or task', () => {
    const current = { key: 's2:a1', state: emptyActivity() };
    expect(foldStreamEvents('s2:a1', current, 's1:a1', callEvent('late', 5))).toBe(current);
  });

  it('starts from an empty activity when the key changes', () => {
    const previous = foldStreamEvents(
      's1:a1',
      { key: 's1:a1', state: emptyActivity() },
      's1:a1',
      callEvent('c1', 10),
    );
    const unknownResult: ActivityEvent = {
      kind: 'result',
      id: 'missing',
      result: { text: 'ok', failed: false },
    };
    expect(foldStreamEvents('s2:a1', previous, 's2:a1', unknownResult)).toEqual({
      key: 's2:a1',
      state: emptyActivity(),
    });
    const folded = foldStreamEvents('s2:a1', previous, 's2:a1', callEvent('c2', 3));
    expect(folded.state.calls.map((c) => c.id)).toEqual(['c2']);
  });
});

describe('activity stream slots', () => {
  const slots = () => new StreamSlots(3);
  const claim = (s: StreamSlots, priority: 1 | 2 | 3) => {
    const states: boolean[] = [];
    const held = s.claim((o) => states.push(o), priority);
    return {
      states,
      release: held.release,
      prioritize: held.prioritize,
      open: () => states.at(-1) === true,
    };
  };
  it('holds at most three streams open at once', () => {
    const s = slots();
    const a = claim(s, 2),
      b = claim(s, 2),
      c = claim(s, 2),
      d = claim(s, 2);
    expect([a, b, c].every((x) => x.open())).toBe(true);
    expect(d.open()).toBe(false);
  });
  it('an equal-priority claim waits instead of preempting', () => {
    const s = slots();
    const a = claim(s, 2);
    claim(s, 2);
    claim(s, 2);
    const d = claim(s, 2);
    expect(a.open()).toBe(true);
    expect(d.states).toEqual([false]);
  });
  it('a more important claim preempts the least important, oldest holder', () => {
    const s = slots();
    const strip1 = claim(s, 3),
      strip2 = claim(s, 3),
      sub = claim(s, 2);
    const clicked = claim(s, 1);
    expect(clicked.open()).toBe(true);
    expect(strip1.open()).toBe(false);
    expect(strip2.open()).toBe(true);
    expect(sub.open()).toBe(true);
  });
  it('on release the most important waiting claim opens, newest first', () => {
    const s = slots();
    const a = claim(s, 1),
      b = claim(s, 1),
      c = claim(s, 1);
    const w3 = claim(s, 3),
      w2old = claim(s, 2),
      w2new = claim(s, 2);
    a.release();
    expect(w2new.open()).toBe(true);
    expect(w2old.open()).toBe(false);
    expect(w3.open()).toBe(false);
    b.release();
    expect(w2old.open()).toBe(true);
    c.release();
    expect(w3.open()).toBe(true);
  });
  it('a holder is never moved by a claim it outranks or equals', () => {
    const s = slots();
    const a = claim(s, 2),
      b = claim(s, 2),
      c = claim(s, 2);
    claim(s, 3);
    claim(s, 2);
    expect([a, b, c].map((x) => x.states)).toEqual([[true], [true], [true]]);
  });
  it('forgets a waiting claim released before it opened', () => {
    const s = slots();
    claim(s, 1);
    claim(s, 1);
    const c = claim(s, 1);
    const w = claim(s, 2);
    w.release();
    c.release();
    expect(w.states).toEqual([false]);
  });
  it('a preempted holder reopens when a slot frees, and nothing else moves', () => {
    const s = slots();
    const strip1 = claim(s, 3),
      strip2 = claim(s, 3),
      strip3 = claim(s, 3);
    const clicked = claim(s, 1);
    expect(strip1.states).toEqual([true, false]);
    clicked.release();
    expect(strip1.states).toEqual([true, false, true]);
    expect(strip2.states).toEqual([true]);
    expect(strip3.states).toEqual([true]);
  });
  it('a development-mode release and re-claim under full equal-priority slots pauses again', () => {
    const s = slots();
    const holders = [claim(s, 2), claim(s, 2), claim(s, 2)];
    const first = claim(s, 2);
    expect(first.states).toEqual([false]);
    first.release();
    const again = claim(s, 2);
    expect(again.states).toEqual([false]);
    expect(holders.map((x) => x.states)).toEqual([[true], [true], [true]]);
    holders[0]?.release();
    expect(again.open()).toBe(true);
  });
  it('a waiting claim raised to expanded preempts the least important holder', () => {
    const s = slots();
    const sub = claim(s, 2),
      strip1 = claim(s, 3),
      strip2 = claim(s, 3);
    const strip3 = claim(s, 3);
    expect(strip3.states).toEqual([false]);
    strip3.prioritize(1);
    expect(strip3.open()).toBe(true);
    expect(strip1.states).toEqual([true, false]);
    expect(strip2.states).toEqual([true]);
    expect(sub.states).toEqual([true]);
  });
  it('a holder changing priority keeps its slot and its connection', () => {
    const s = slots();
    const strip = claim(s, 3);
    claim(s, 2);
    claim(s, 2);
    strip.prioritize(1);
    strip.prioritize(3);
    expect(strip.states).toEqual([true]);
    const clicked = claim(s, 1);
    expect(clicked.open()).toBe(true);
    expect(strip.states).toEqual([true, false]);
  });
});

describe('seen subagent actions', () => {
  const state = (id: string) => ({ ...emptyActivity(), calls: [call(id, 10)] });
  it('recalls what was remembered under the same key', () => {
    rememberStream('cache-s:a1', state('c1'));
    expect(recallStream('cache-s:a1')?.calls.map((c) => c.id)).toEqual(['c1']);
  });
  it('knows nothing about an unseen key', () => {
    expect(recallStream('cache-s:never')).toBeUndefined();
  });
  it('keeps the newest fifty and drops the oldest', () => {
    for (let index = 0; index < 51; index++) rememberStream(`evict:${index}`, state(`c${index}`));
    expect(recallStream('evict:0')).toBeUndefined();
    expect(recallStream('evict:1')?.calls[0]?.id).toBe('c1');
    expect(recallStream('evict:50')?.calls[0]?.id).toBe('c50');
  });
});
