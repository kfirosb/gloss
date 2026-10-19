import { describe, expect, it } from 'vitest';
import type { ActivityCall, ActivityEvent } from '../../src/core/activity-contracts.js';
import { emptyActivity } from '../../src/core/activity-reducer.js';
import {
  ACTIVITY_STREAM_LIMIT,
  StreamSlots,
  foldStreamEvents,
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
  const recorder = () => {
    const states: boolean[] = [];
    return { states, set: (open: boolean) => states.push(open) };
  };
  it('holds at most two activity streams open at once', () => {
    expect(ACTIVITY_STREAM_LIMIT).toBe(2);
  });
  it('closes the oldest open stream when one more opens, and reopens it when another closes', () => {
    const slots = new StreamSlots(2);
    const a = recorder();
    const b = recorder();
    const c = recorder();
    slots.claim(a.set);
    const releaseB = slots.claim(b.set);
    expect([a.states, b.states]).toEqual([[true], [true]]);
    const releaseC = slots.claim(c.set);
    expect([a.states, b.states, c.states]).toEqual([[true, false], [true], [true]]);
    releaseB();
    expect(a.states).toEqual([true, false, true]);
    releaseC();
    expect(a.states).toEqual([true, false, true]);
  });
  it('pauses the same oldest stream when the newest is closed and claimed again at once', () => {
    const slots = new StreamSlots(2);
    const a = recorder();
    const b = recorder();
    slots.claim(a.set);
    slots.claim(b.set);
    const c = recorder();
    slots.claim(c.set)();
    slots.claim(c.set);
    expect(a.states.at(-1)).toBe(false);
    expect(b.states).toEqual([true]);
  });
  it('forgets a paused stream that closes before it reopens', () => {
    const slots = new StreamSlots(1);
    const a = recorder();
    const b = recorder();
    const releaseA = slots.claim(a.set);
    const releaseB = slots.claim(b.set);
    expect(a.states).toEqual([true, false]);
    releaseA();
    releaseB();
    expect(a.states).toEqual([true, false]);
    const c = recorder();
    slots.claim(c.set);
    expect(c.states).toEqual([true]);
  });
});
