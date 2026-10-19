import { describe, expect, it } from 'vitest';
import type { ActivityCall, ActivityTask } from '../../src/core/activity-contracts.js';
import {
  earlierCount,
  groupTasks,
  historySummary,
  isHighlighted,
  lastActions,
  mainStatus,
  newestArrival,
  sinceLastAction,
} from '../../src/ui/activity-page.js';

const task = (over: Partial<ActivityTask> & Pick<ActivityTask, 'id' | 'kind'>): ActivityTask => ({
  description: '',
  position: 0,
  depth: 0,
  status: 'running',
  ...over,
});
const call = (over: Partial<ActivityCall> & Pick<ActivityCall, 'id' | 'tool'>): ActivityCall => ({
  summary: '',
  input: '',
  position: 0,
  depth: 0,
  timestamp: '2026-10-18T14:02:00.000Z',
  ...over,
});
const calls = (count: number): ActivityCall[] =>
  Array.from({ length: count }, (_, index) =>
    call({ id: `c${index}`, tool: 'Read', position: index * 10 }),
  );

describe('lastActions and earlierCount', () => {
  it('returns the five newest first, or all when showAll', () => {
    expect(lastActions(calls(8), false).map((entry) => entry.id)).toEqual([
      'c7',
      'c6',
      'c5',
      'c4',
      'c3',
    ]);
    expect(lastActions(calls(8), true)).toHaveLength(8);
  });
  it('counts the calls beyond the last five', () => {
    expect(earlierCount(calls(5))).toBe(0);
    expect(earlierCount(calls(8))).toBe(3);
  });
});

describe('groupTasks', () => {
  it('splits running subagents, running commands and finished, newest first', () => {
    const grouped = groupTasks([
      task({ id: 's1', kind: 'subagent', position: 1 }),
      task({ id: 's2', kind: 'subagent', position: 5 }),
      task({ id: 'b1', kind: 'background', position: 2 }),
      task({ id: 'b2', kind: 'background', position: 4 }),
      task({ id: 'f1', kind: 'subagent', position: 3, status: 'finished' }),
      task({ id: 'f2', kind: 'background', position: 6, status: 'failed' }),
    ]);
    expect(grouped.subagents.map((entry) => entry.id)).toEqual(['s2', 's1']);
    expect(grouped.commands.map((entry) => entry.id)).toEqual(['b2', 'b1']);
    expect(grouped.finished.map((entry) => entry.id)).toEqual(['f2', 'f1']);
  });
});

describe('historySummary', () => {
  const done = (id: string, kind: ActivityTask['kind']) => task({ id, kind, status: 'finished' });
  it('describes what finished', () => {
    expect(historySummary([])).toBe('nothing finished yet');
    expect(historySummary([done('a', 'subagent')])).toBe('1 finished subagent');
    expect(
      historySummary([done('a', 'subagent'), done('b', 'subagent'), done('c', 'background')]),
    ).toBe('2 finished subagents, 1 finished command');
    expect(historySummary([done('c', 'background')])).toBe('1 finished command');
  });
});

describe('mainStatus', () => {
  it('derives working, idle or disconnected', () => {
    expect(mainStatus('idle', 0)).toBe('idle');
    expect(mainStatus('idle', 1)).toBe('working');
    expect(mainStatus('working', 0)).toBe('working');
    expect(mainStatus('approval-required', 0)).toBe('working');
    expect(mainStatus('dialog-open', 0)).toBe('working');
    expect(mainStatus('disconnected', 2)).toBe('disconnected');
  });
});

describe('sinceLastAction', () => {
  const now = Date.parse('2026-10-18T14:02:12.000Z');
  it('is empty without calls and formats the gap otherwise', () => {
    expect(sinceLastAction([], now)).toBe('');
    expect(sinceLastAction(calls(1), now)).toBe('12s since last action');
  });
});

describe('newestArrival', () => {
  const first = call({ id: 'a', tool: 'Read', position: 1 });
  const second = call({ id: 'b', tool: 'Read', position: 2 });
  it('tracks when the newest call was first seen', () => {
    const seen = newestArrival(undefined, [first], 1000);
    expect(seen).toEqual({ id: 'a', at: 1000 });
    expect(newestArrival(seen, [first], 5000)).toEqual({ id: 'a', at: 1000 });
    expect(newestArrival(seen, [first, second], 6000)).toEqual({ id: 'b', at: 6000 });
    expect(newestArrival(undefined, [], 1)).toBeUndefined();
  });
  it('highlights only the arrival, only briefly', () => {
    const arrival = { id: 'a', at: 1000 };
    expect(isHighlighted(arrival, first, 2999)).toBe(true);
    expect(isHighlighted(arrival, first, 3000)).toBe(false);
    expect(isHighlighted(arrival, second, 1500)).toBe(false);
    expect(isHighlighted(undefined, first, 1500)).toBe(false);
  });
});
