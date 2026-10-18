import { describe, expect, it } from 'vitest';
import { parseClaudeActivity, parseTaskNotification } from '../../src/agents/claude/activity.js';
import { parseClaudeRecord } from '../../src/agents/claude/index.js';

const assistant = (blocks: unknown[], extra = {}) => ({
  type: 'assistant',
  uuid: 'a1',
  sessionId: 's',
  cwd: '/repo',
  timestamp: '2026-10-18T10:00:00Z',
  message: { id: 'm1', role: 'assistant', stop_reason: 'tool_use', content: blocks },
  ...extra,
});
const user = (blocks: unknown[] | string, extra = {}) => ({
  type: 'user',
  uuid: 'u1',
  sessionId: 's',
  cwd: '/repo',
  timestamp: '2026-10-18T10:00:05Z',
  message: { role: 'user', content: blocks },
  ...extra,
});
describe('parseClaudeActivity', () => {
  it('emits a call per tool_use block with a summary and bounded input', () => {
    const events = parseClaudeActivity(
      assistant([
        { type: 'text', text: 'Running' },
        {
          type: 'tool_use',
          id: 't1',
          name: 'Bash',
          input: { command: 'npm test', description: 'Run tests' },
        },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/repo/src/a.ts' } },
      ]),
      40,
    );
    expect(events).toEqual([
      {
        kind: 'call',
        call: {
          id: 't1',
          tool: 'Bash',
          summary: 'Run tests',
          input: 'npm test',
          position: 40,
          timestamp: '2026-10-18T10:00:00Z',
          depth: 0,
        },
      },
      {
        kind: 'call',
        call: {
          id: 't2',
          tool: 'Read',
          summary: 'src/a.ts',
          input: expect.stringContaining('a.ts'),
          position: 40,
          timestamp: '2026-10-18T10:00:00Z',
          depth: 0,
        },
      },
    ]);
  });
  it('emits one call per tool_use block even when records share a message id', () => {
    const first = parseClaudeActivity(
      assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
      1,
    );
    const second = parseClaudeActivity(
      assistant([{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'pwd' } }], {
        uuid: 'a2',
      }),
      2,
    );
    expect([...first, ...second].map((e) => e.kind === 'call' && e.call.id)).toEqual(['t1', 't2']);
  });
  it('emits a result per tool_result with is_error as failed', () => {
    const events = parseClaudeActivity(
      user([
        { type: 'tool_result', tool_use_id: 't1', content: 'Exit code 1\nboom', is_error: true },
        { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'line' }] },
      ]),
      90,
    );
    expect(events).toEqual([
      {
        kind: 'result',
        id: 't1',
        result: { text: 'Exit code 1\nboom', failed: true, timestamp: '2026-10-18T10:00:05Z' },
      },
      {
        kind: 'result',
        id: 't2',
        result: { text: 'line', failed: false, timestamp: '2026-10-18T10:00:05Z' },
      },
    ]);
  });
  it('starts a background task from run_in_background and its result text', () => {
    const start = parseClaudeActivity(
      assistant([
        {
          type: 'tool_use',
          id: 'b1',
          name: 'Bash',
          input: {
            command: 'npm run dev',
            description: 'Start the dev server',
            run_in_background: true,
          },
        },
      ]),
      1,
    );
    expect(start).toEqual([
      { kind: 'call', call: expect.objectContaining({ id: 'b1', background: true }) },
      {
        kind: 'task-start',
        task: {
          kind: 'background',
          id: 'b1',
          description: 'Start the dev server',
          command: 'npm run dev',
          position: 1,
          depth: 0,
          status: 'running',
          startedAt: '2026-10-18T10:00:00Z',
        },
      },
    ]);
    const result = parseClaudeActivity(
      user(
        [
          {
            type: 'tool_result',
            tool_use_id: 'b1',
            content:
              'Command running in background with ID: bf190ajoy. Output is being written to: /private/tmp/claude-501/-repo/s/tasks/bf190ajoy.output. You will be notified when it completes',
          },
        ],
        {
          toolUseResult: {
            stdout: '',
            stderr: '',
            interrupted: false,
            backgroundTaskId: 'bf190ajoy',
          },
        },
      ),
      2,
    );
    expect(result).toEqual([
      { kind: 'result', id: 'b1', result: expect.objectContaining({ failed: false }) },
      {
        kind: 'task-output',
        id: 'b1',
        taskId: 'bf190ajoy',
        outputPath: '/private/tmp/claude-501/-repo/s/tasks/bf190ajoy.output',
      },
    ]);
  });
  it('starts a subagent from an Agent call; a synchronous result is a plain result plus its identity', () => {
    const start = parseClaudeActivity(
      assistant([
        {
          type: 'tool_use',
          id: 'a1',
          name: 'Agent',
          input: {
            description: 'Review the fix',
            subagent_type: 'general-purpose',
            prompt: 'Look',
          },
        },
      ]),
      5,
    );
    expect(start[1]).toEqual({
      kind: 'task-start',
      task: {
        kind: 'subagent',
        id: 'a1',
        description: 'Review the fix',
        agentType: 'general-purpose',
        position: 5,
        depth: 0,
        status: 'running',
        startedAt: '2026-10-18T10:00:00Z',
      },
    });
    const end = parseClaudeActivity(
      user(
        [
          {
            type: 'tool_result',
            tool_use_id: 'a1',
            content: [{ type: 'text', text: 'All good.' }],
          },
        ],
        {
          toolUseResult: { status: 'completed', agentId: 'ag1', resolvedModel: 'claude-opus-5-5' },
        },
      ),
      6,
    );
    // Identity first, so the reducer knows the task is synchronous before the result finishes it.
    expect(end).toEqual([
      { kind: 'task-launched', id: 'a1', agentId: 'ag1', model: 'claude-opus-5-5', async: false },
      {
        kind: 'result',
        id: 'a1',
        result: { text: 'All good.', failed: false, timestamp: '2026-10-18T10:00:05Z' },
      },
    ]);
  });
  it('marks an async agent launch so the reducer keeps it running after the result', () => {
    const launched = parseClaudeActivity(
      user(
        [{ type: 'tool_result', tool_use_id: 'a1', content: 'Async agent launched successfully.' }],
        {
          toolUseResult: {
            isAsync: true,
            status: 'async_launched',
            agentId: 'ag1',
            resolvedModel: 'claude-opus-5-5',
          },
        },
      ),
      6,
    );
    expect(launched).toEqual([
      { kind: 'task-launched', id: 'a1', agentId: 'ag1', model: 'claude-opus-5-5', async: true },
      { kind: 'result', id: 'a1', result: expect.objectContaining({ failed: false }) },
    ]);
  });
  it('ends a task from a task-notification and ignores one it cannot read', () => {
    const text =
      '<task-notification>\n<task-id>ag1</task-id>\n<tool-use-id>a1</tool-use-id>\n<output-file>/tmp/x/tasks/ag1.output</output-file>\n<status>completed</status>\n<summary>Agent "Review" finished</summary>\n</task-notification>';
    expect(parseTaskNotification(text)).toEqual({
      taskId: 'ag1',
      toolUseId: 'a1',
      outputFile: '/tmp/x/tasks/ag1.output',
      status: 'completed',
      summary: 'Agent "Review" finished',
    });
    expect(parseClaudeActivity(user(text), 7)).toEqual([
      { kind: 'task-end', id: 'a1', status: 'finished', finishedAt: '2026-10-18T10:00:05Z' },
    ]);
    expect(parseClaudeActivity(user('<task-notification>garbage'), 8)).toEqual([]);
  });
  it('maps a failed notification status to failed', () => {
    const text =
      '<task-notification>\n<task-id>b9</task-id>\n<tool-use-id>b1</tool-use-id>\n<status>failed</status>\n</task-notification>';
    expect(parseClaudeActivity(user(text), 9)[0]).toMatchObject({
      kind: 'task-end',
      id: 'b1',
      status: 'failed',
    });
  });
  it('emits nothing for records without tool blocks and passes depth through', () => {
    expect(parseClaudeActivity(user('plain text'), 1)).toEqual([]);
    expect(
      parseClaudeActivity(
        assistant([{ type: 'text', text: 'hi' }], {
          message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] },
        }),
        1,
      ),
    ).toEqual([]);
    const [call] = parseClaudeActivity(
      assistant([{ type: 'tool_use', id: 't9', name: 'Glob', input: { pattern: '*.ts' } }]),
      3,
      2,
    );
    expect(call).toMatchObject({ kind: 'call', call: { depth: 2 } });
  });
});
describe('parseClaudeActivity sidechain records', () => {
  it('skips them in the main transcript and parses them when reading a subagent transcript', () => {
    const record = assistant(
      [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
      { isSidechain: true },
    );
    expect(parseClaudeActivity(record, 1)).toEqual([]);
    expect(parseClaudeActivity(record, 1, 1)).toEqual([
      { kind: 'call', call: expect.objectContaining({ id: 't1', depth: 1 }) },
    ]);
  });
});
describe('parseClaudeRecord carries activity without changing messages', () => {
  it('returns activity beside an unchanged (absent) message for a tool_use record', () => {
    const parsed = parseClaudeRecord(
      assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
      10,
      's',
    );
    expect(parsed.message).toBeUndefined();
    expect(parsed.activity).toHaveLength(1);
  });
  it('keeps a plain end_turn reply exactly as before', () => {
    const record = {
      type: 'assistant',
      uuid: 'a2',
      sessionId: 's',
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Done' }],
      },
    };
    expect(parseClaudeRecord(record, 10, 's')).toEqual({
      message: { sourceId: 'a2', revision: 11, role: 'assistant', text: 'Done', complete: true },
    });
  });
});
