import { describe, expect, it } from 'vitest';
import type { ActivityCall, ActivityEvent } from '../../src/core/activity-contracts.js';
import { emptyActivity } from '../../src/core/activity-reducer.js';
import { foldStreamEvents } from '../../src/ui/use-activity-streams.js';

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
