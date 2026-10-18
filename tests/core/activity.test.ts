import { describe, expect, it } from 'vitest';
import { applyActivityEvent, emptyActivity, summarizeToolCall } from '../../src/core/activity.js';
import { ACTIVITY_CALL_LIMIT } from '../../src/core/activity-contracts.js';

const call = (id: string, position: number, extra = {}) => ({
  kind: 'call' as const,
  call: { id, tool: 'Bash', summary: 'Run tests', input: 'npm test', position, depth: 0, ...extra },
});
describe('activity reducer', () => {
  it('adds a call once and attaches its result by id', () => {
    let s = applyActivityEvent(emptyActivity(), call('t1', 10));
    s = applyActivityEvent(s, call('t1', 10));
    s = applyActivityEvent(s, { kind: 'result', id: 't1', result: { text: 'ok', failed: false } });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.result).toEqual({ text: 'ok', failed: false });
  });
  it('ignores a result whose call is unknown and returns the same state', () => {
    const s = emptyActivity();
    expect(
      applyActivityEvent(s, { kind: 'result', id: 'x', result: { text: '', failed: true } }),
    ).toBe(s);
  });
  it('keeps calls ascending by position and bounded', () => {
    let s = emptyActivity();
    for (let i = ACTIVITY_CALL_LIMIT + 5; i > 0; i--) s = applyActivityEvent(s, call(`t${i}`, i));
    expect(s.calls).toHaveLength(ACTIVITY_CALL_LIMIT);
    expect(s.calls[0]!.position).toBeLessThan(s.calls.at(-1)!.position);
    expect(s.calls[0]!.id).toBe('t6');
  });
  it('counts running tasks and ends them with status, report and agentId', () => {
    let s = applyActivityEvent(emptyActivity(), {
      kind: 'task-start',
      task: {
        kind: 'subagent',
        id: 'a1',
        description: 'Review',
        position: 1,
        depth: 0,
        status: 'running',
      },
    });
    s = applyActivityEvent(s, {
      kind: 'task-start',
      task: {
        kind: 'background',
        id: 'b1',
        description: 'Serve',
        command: 'npm run dev',
        position: 2,
        depth: 0,
        status: 'running',
      },
    });
    expect(s.running).toBe(2);
    s = applyActivityEvent(s, {
      kind: 'task-end',
      id: 'a1',
      status: 'finished',
      report: 'Done',
      agentId: 'ag1',
      finishedAt: 'T',
    });
    expect(s.running).toBe(1);
    expect(s.tasks[0]).toMatchObject({
      status: 'finished',
      report: 'Done',
      agentId: 'ag1',
      finishedAt: 'T',
    });
  });
  it('ignores a task-end for an unknown task', () => {
    const s = emptyActivity();
    expect(applyActivityEvent(s, { kind: 'task-end', id: 'nope', status: 'finished' })).toBe(s);
  });
  it('keeps a launched async subagent running with its id and model, and marks output available', () => {
    let s = applyActivityEvent(emptyActivity(), {
      kind: 'task-start',
      task: {
        kind: 'subagent',
        id: 'a1',
        description: 'Review',
        position: 1,
        depth: 0,
        status: 'running',
      },
    });
    s = applyActivityEvent(s, {
      kind: 'task-launched',
      id: 'a1',
      agentId: 'ag1',
      model: 'opus',
      async: true,
    });
    expect(s.tasks[0]).toMatchObject({ status: 'running', agentId: 'ag1', model: 'opus' });
    s = applyActivityEvent(s, {
      kind: 'result',
      id: 'a1',
      result: { text: 'Async agent launched successfully.', failed: false },
    });
    expect(s.tasks[0]!.status).toBe('running');
    s = applyActivityEvent(s, {
      kind: 'task-start',
      task: {
        kind: 'background',
        id: 'b1',
        description: 'Serve',
        command: 'npm run dev',
        position: 2,
        depth: 0,
        status: 'running',
      },
    });
    s = applyActivityEvent(s, {
      kind: 'task-output',
      id: 'b1',
      taskId: 'bf1',
      outputPath: '/x/tasks/bf1.output',
    });
    expect(s.tasks[1]).toMatchObject({ outputAvailable: true });
    expect(JSON.stringify(s)).not.toContain('/x/tasks');
  });
  it('finishes a synchronous subagent on its result, with the result text as the report', () => {
    let s = applyActivityEvent(emptyActivity(), {
      kind: 'task-start',
      task: {
        kind: 'subagent',
        id: 'a2',
        description: 'Review',
        position: 1,
        depth: 0,
        status: 'running',
      },
    });
    s = applyActivityEvent(s, {
      kind: 'result',
      id: 'a2',
      result: { text: 'All good.', failed: false, timestamp: 'T' },
    });
    expect(s.tasks[0]).toMatchObject({ status: 'finished', report: 'All good.', finishedAt: 'T' });
    expect(s.running).toBe(0);
  });
  it('never finishes a background task on its result', () => {
    let s = applyActivityEvent(emptyActivity(), {
      kind: 'task-start',
      task: {
        kind: 'background',
        id: 'b2',
        description: 'Serve',
        command: 'npm run dev',
        position: 1,
        depth: 0,
        status: 'running',
      },
    });
    s = applyActivityEvent(s, {
      kind: 'result',
      id: 'b2',
      result: { text: 'Command running in background with ID: x', failed: false },
    });
    expect(s.tasks[0]!.status).toBe('running');
  });
  it('records gaps once, bounded to 20', () => {
    let s = applyActivityEvent(emptyActivity(), { kind: 'gap', reason: 'older' });
    s = applyActivityEvent(s, { kind: 'gap', reason: 'older' });
    expect(s.gaps).toEqual(['older']);
  });
});
describe('summarizeToolCall', () => {
  it('uses the Bash description, else the first command line', () => {
    expect(
      summarizeToolCall('Bash', { command: 'npm test\necho done', description: 'Run tests' }),
    ).toBe('Run tests');
    expect(summarizeToolCall('Bash', { command: 'npm test\necho done' })).toBe('npm test');
  });
  it('shows file tools relative to cwd', () => {
    expect(summarizeToolCall('Read', { file_path: '/repo/src/a.ts' }, '/repo')).toBe('src/a.ts');
    expect(summarizeToolCall('Edit', { file_path: '/elsewhere/b.ts' }, '/repo')).toBe(
      '/elsewhere/b.ts',
    );
    expect(summarizeToolCall('Grep', { pattern: 'foo', path: '/repo/src' }, '/repo')).toBe(
      'foo in src',
    );
  });
  it('names agents and skills', () => {
    expect(summarizeToolCall('Agent', { description: 'Review the fix', prompt: '...' })).toBe(
      'Review the fix',
    );
    expect(summarizeToolCall('Skill', { skill: 'superpowers:brainstorming' })).toBe(
      'superpowers:brainstorming',
    );
  });
  it('falls back to a bounded rendering for other tools', () => {
    expect(summarizeToolCall('WebFetch', { url: 'https://x.test/a' })).toBe('https://x.test/a');
    expect(summarizeToolCall('Unknown', { a: 'x'.repeat(500) }).length).toBeLessThanOrEqual(120);
  });
});
