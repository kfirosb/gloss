import { describe, expect, it } from 'vitest';
import {
  applyActivityEvent,
  emptyActivity,
  renderToolInput,
  summarizeToolCall,
} from '../../src/core/activity.js';
import {
  ACTIVITY_CALL_LIMIT,
  ACTIVITY_REPORT_CHARS,
  ACTIVITY_RESULT_CHARS,
  type ActivityTask,
} from '../../src/core/activity-contracts.js';

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
  it('attaches an async subagent report by agentId and resets a stale translation', () => {
    let s = applyActivityEvent(emptyActivity(), {
      kind: 'task-start',
      task: {
        kind: 'subagent',
        id: 'a3',
        description: 'Explore',
        position: 1,
        depth: 0,
        status: 'running',
      },
    });
    s = applyActivityEvent(s, { kind: 'task-launched', id: 'a3', agentId: 'ag3', async: true });
    s = applyActivityEvent(s, { kind: 'report', agentId: 'ag3', report: 'Found it.' });
    expect(s.tasks[0]).toMatchObject({ status: 'running', report: 'Found it.' });
    s = applyActivityEvent(s, { kind: 'task-end', id: 'a3', status: 'finished', finishedAt: 'T' });
    expect(s.tasks[0]).toMatchObject({ status: 'finished', report: 'Found it.' });
    const translated = {
      ...s,
      tasks: [
        { ...s.tasks[0]!, reportTranslation: { text: 'נמצא.', status: 'complete' as const } },
      ],
    };
    expect(
      applyActivityEvent(translated, { kind: 'report', agentId: 'ag3', report: 'Found it.' }),
    ).toBe(translated);
    const resumed = applyActivityEvent(translated, {
      kind: 'report',
      agentId: 'ag3',
      report: 'Second run.',
    });
    expect(resumed.tasks[0]!.report).toBe('Second run.');
    expect(resumed.tasks[0]!.reportTranslation).toBeUndefined();
    const unknown = applyActivityEvent(s, { kind: 'report', agentId: 'nope', report: 'x' });
    expect(unknown).toBe(s);
    const long = applyActivityEvent(s, {
      kind: 'report',
      agentId: 'ag3',
      report: 'y'.repeat(ACTIVITY_REPORT_CHARS + 5),
    });
    expect(long.tasks[0]!.report).toHaveLength(ACTIVITY_REPORT_CHARS);
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
  it('keeps at most 2000 characters of a row input and result text', () => {
    expect(ACTIVITY_RESULT_CHARS).toBe(2000);
    expect(renderToolInput('Bash', { command: 'x'.repeat(5000) })).toHaveLength(2000);
    expect(renderToolInput('Read', { file_path: 'y'.repeat(5000) }).length).toBe(2000);
    let s = applyActivityEvent(emptyActivity(), call('t1', 1, { input: 'z'.repeat(5000) }));
    s = applyActivityEvent(s, {
      kind: 'result',
      id: 't1',
      result: { text: 'r'.repeat(5000), failed: false },
    });
    expect(s.calls[0]!.input).toHaveLength(2000);
    expect(s.calls[0]!.result!.text).toHaveLength(2000);
  });
  it('keeps a synchronous subagent report beyond the row bound', () => {
    let s = applyActivityEvent(emptyActivity(), {
      kind: 'task-start',
      task: {
        kind: 'subagent',
        id: 'a4',
        description: 'R',
        position: 1,
        depth: 0,
        status: 'running',
      },
    });
    s = applyActivityEvent(s, {
      kind: 'result',
      id: 'a4',
      result: { text: 'w'.repeat(ACTIVITY_REPORT_CHARS + 5), failed: false },
    });
    expect(s.tasks[0]!.report).toHaveLength(ACTIVITY_REPORT_CHARS);
  });
  const running = (kind: ActivityTask['kind'], id: string): ActivityTask => ({
    kind,
    id,
    description: id,
    ...(kind === 'background' ? { command: 'npm run dev' } : {}),
    position: 1,
    depth: 0,
    status: 'running',
  });
  it('ends a background command that failed to start as failed', () => {
    let s = applyActivityEvent(emptyActivity(), {
      kind: 'task-start',
      task: running('background', 'b3'),
    });
    s = applyActivityEvent(s, {
      kind: 'result',
      id: 'b3',
      result: { text: 'Permission denied', failed: true, timestamp: 'T' },
    });
    expect(s.tasks[0]).toMatchObject({ status: 'failed', finishedAt: 'T' });
    expect(s.tasks[0]!.report).toBeUndefined();
    expect(s.running).toBe(0);
  });
  it('ends an async subagent whose launch result failed, and keeps it running otherwise', () => {
    let s = applyActivityEvent(emptyActivity(), {
      kind: 'task-start',
      task: running('subagent', 'a5'),
    });
    s = applyActivityEvent(s, { kind: 'task-launched', id: 'a5', agentId: 'ag5', async: true });
    const ok = applyActivityEvent(s, {
      kind: 'result',
      id: 'a5',
      result: { text: 'Async agent launched successfully.', failed: false },
    });
    expect(ok.tasks[0]!.status).toBe('running');
    s = applyActivityEvent(s, {
      kind: 'result',
      id: 'a5',
      result: { text: 'Agent type not found', failed: true, timestamp: 'T' },
    });
    expect(s.tasks[0]).toMatchObject({ status: 'failed', finishedAt: 'T' });
    expect(s.running).toBe(0);
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
