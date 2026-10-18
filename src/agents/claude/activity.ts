import type { ActivityCall, ActivityEvent } from '../../core/activity-contracts.js';
import { renderToolInput, summarizeToolCall } from '../../core/activity.js';
import { recordOf, textBlocks, type JsonRecord } from '../../core/json-record.js';

/** The tool result Claude writes when a Bash call is started in the background. */
export const BACKGROUND_START =
  /^Command running in background with ID: (\S+)\. Output is being written to: (.+?)\.?(?:\s|$)/;
const TASK_NOTIFICATION = '<task-notification>';
const NOTIFICATION_TAGS = ['task-id', 'tool-use-id', 'output-file', 'status', 'summary'] as const;

export interface TaskNotification {
  taskId: string;
  toolUseId: string;
  outputFile?: string;
  status: 'completed' | 'failed' | string;
  summary?: string;
}

/** Reads the simple `<tag>value</tag>` pairs of a task notification; undefined when identity is missing. */
export function parseTaskNotification(text: string): TaskNotification | undefined {
  if (!text.startsWith(TASK_NOTIFICATION)) return undefined;
  const field = (tag: (typeof NOTIFICATION_TAGS)[number]): string | undefined =>
    new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1]?.trim() || undefined;
  const taskId = field('task-id');
  const toolUseId = field('tool-use-id');
  const status = field('status');
  if (!taskId || !toolUseId || !status) return undefined;
  const outputFile = field('output-file');
  const summary = field('summary');
  return {
    taskId,
    toolUseId,
    ...(outputFile ? { outputFile } : {}),
    status,
    ...(summary ? { summary } : {}),
  };
}

function callEvents(
  block: JsonRecord,
  record: JsonRecord,
  offset: number,
  depth: number,
): ActivityEvent[] {
  if (typeof block.id !== 'string' || typeof block.name !== 'string') return [];
  const input = recordOf(block.input) ?? {};
  const cwd = typeof record.cwd === 'string' ? record.cwd : undefined;
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : undefined;
  const background = block.name === 'Bash' && input.run_in_background === true;
  const summary = summarizeToolCall(block.name, input, cwd);
  const call: ActivityCall = {
    id: block.id,
    tool: block.name,
    summary,
    input: renderToolInput(block.name, input),
    position: offset,
    ...(timestamp ? { timestamp } : {}),
    ...(background ? { background: true as const } : {}),
    depth,
  };
  const events: ActivityEvent[] = [{ kind: 'call', call }];
  const taskBase = {
    id: block.id,
    description: summary,
    position: offset,
    depth,
    status: 'running' as const,
    ...(timestamp ? { startedAt: timestamp } : {}),
  };
  if (block.name === 'Agent') {
    const agentType = typeof input.subagent_type === 'string' ? input.subagent_type : undefined;
    events.push({
      kind: 'task-start',
      task: { kind: 'subagent', ...taskBase, ...(agentType ? { agentType } : {}) },
    });
  } else if (background) {
    const command = typeof input.command === 'string' ? input.command : undefined;
    events.push({
      kind: 'task-start',
      task: { kind: 'background', ...taskBase, ...(command ? { command } : {}) },
    });
  }
  return events;
}

function resultEvents(blocks: JsonRecord[], record: JsonRecord): ActivityEvent[] {
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : undefined;
  const meta = recordOf(record.toolUseResult);
  const events: ActivityEvent[] = [];
  // toolUseResult describes the record's single result; attach it to the first block only.
  let metaUsed = false;
  for (const block of blocks) {
    if (typeof block.tool_use_id !== 'string') continue;
    const id = block.tool_use_id;
    const text =
      typeof block.content === 'string' ? block.content : textBlocks(block.content).join('\n');
    const own = metaUsed ? undefined : meta;
    metaUsed = true;
    // Identity precedes the result so the reducer knows whether the task is synchronous.
    if (own && typeof own.agentId === 'string') {
      events.push({
        kind: 'task-launched',
        id,
        agentId: own.agentId,
        ...(typeof own.resolvedModel === 'string' ? { model: own.resolvedModel } : {}),
        async: own.status === 'async_launched',
      });
    }
    events.push({
      kind: 'result',
      id,
      result: { text, failed: block.is_error === true, ...(timestamp ? { timestamp } : {}) },
    });
    const [, taskId, outputPath] =
      (own && typeof own.backgroundTaskId === 'string' ? BACKGROUND_START.exec(text) : null) ?? [];
    if (taskId && outputPath && taskId === own?.backgroundTaskId) {
      events.push({ kind: 'task-output', id, taskId, outputPath });
    }
  }
  return events;
}

/** Tool activity carried by one Claude transcript record; pure and never throws on malformed input. */
export function parseClaudeActivity(
  record: JsonRecord,
  offset: number,
  depth = 0,
): ActivityEvent[] {
  if (record.isSidechain === true) return [];
  const message = recordOf(record.message);
  if (!message) return [];
  const body = message.content;
  if (record.type === 'assistant') {
    if (!Array.isArray(body)) return [];
    return body.flatMap((entry: unknown) => {
      const block = recordOf(entry);
      return block?.type === 'tool_use' ? callEvents(block, record, offset, depth) : [];
    });
  }
  if (record.type !== 'user') return [];
  if (typeof body === 'string') return notificationEvents(body, record);
  if (!Array.isArray(body)) return [];
  const results = body.flatMap((entry: unknown) => {
    const block = recordOf(entry);
    return block?.type === 'tool_result' ? [block] : [];
  });
  return results.length ? resultEvents(results, record) : [];
}

function notificationEvents(text: string, record: JsonRecord): ActivityEvent[] {
  const notification = parseTaskNotification(text);
  if (!notification) return [];
  const finishedAt = typeof record.timestamp === 'string' ? record.timestamp : undefined;
  return [
    {
      kind: 'task-end',
      id: notification.toolUseId,
      status: notification.status === 'completed' ? 'finished' : 'failed',
      ...(finishedAt ? { finishedAt } : {}),
    },
  ];
}
