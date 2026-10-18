import path from 'node:path';
import {
  ACTIVITY_CALL_LIMIT,
  ACTIVITY_RESULT_CHARS,
  ACTIVITY_TASK_LIMIT,
  type ActivityEvent,
  type ActivitySnapshot,
  type ActivityTask,
} from './activity-contracts.js';
import type { JsonRecord } from './json-record.js';

const SUMMARY_CHARS = 120;
const GAP_LIMIT = 20;
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function emptyActivity(): ActivitySnapshot {
  return { calls: [], tasks: [], running: 0, gaps: [] };
}

/** Insert keeping ascending position (after equal positions), then drop the oldest beyond the limit. */
function insertByPosition<T extends { position: number }>(items: T[], item: T, limit: number): T[] {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (items[mid]!.position <= item.position) low = mid + 1;
    else high = mid;
  }
  const next = [...items.slice(0, low), item, ...items.slice(low)];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

const countRunning = (tasks: ActivityTask[]): number =>
  tasks.filter((task) => task.status === 'running').length;

function withTasks(state: ActivitySnapshot, tasks: ActivityTask[]): ActivitySnapshot {
  return { ...state, tasks, running: countRunning(tasks) };
}

function updateTask(
  state: ActivitySnapshot,
  id: string,
  update: (task: ActivityTask) => ActivityTask | undefined,
): ActivitySnapshot {
  const index = state.tasks.findIndex((task) => task.id === id);
  const current = state.tasks[index];
  if (!current) return state;
  const updated = update(current);
  if (!updated) return state;
  const tasks = [...state.tasks];
  tasks[index] = updated;
  return withTasks(state, tasks);
}

export function applyActivityEvent(
  state: ActivitySnapshot,
  event: ActivityEvent,
): ActivitySnapshot {
  switch (event.kind) {
    case 'call': {
      if (state.calls.some((call) => call.id === event.call.id)) return state;
      return {
        ...state,
        calls: insertByPosition(state.calls, event.call, ACTIVITY_CALL_LIMIT),
      };
    }
    case 'result': {
      const result = { ...event.result, text: event.result.text.slice(0, ACTIVITY_RESULT_CHARS) };
      const index = state.calls.findIndex((call) => call.id === event.id);
      const existing = state.calls[index];
      let next = state;
      if (existing) {
        const calls = [...state.calls];
        calls[index] = { ...existing, result };
        next = { ...state, calls };
      }
      return updateTask(next, event.id, (task) => {
        if (task.kind !== 'subagent' || task.status !== 'running' || task.async) return undefined;
        return {
          ...task,
          status: result.failed ? 'failed' : 'finished',
          report: result.text,
          ...(result.timestamp ? { finishedAt: result.timestamp } : {}),
        };
      });
    }
    case 'task-start': {
      if (state.tasks.some((task) => task.id === event.task.id)) return state;
      return withTasks(state, insertByPosition(state.tasks, event.task, ACTIVITY_TASK_LIMIT));
    }
    case 'task-end':
      return updateTask(state, event.id, (task) => ({
        ...task,
        status: event.status,
        ...(event.finishedAt ? { finishedAt: event.finishedAt } : {}),
        ...(event.report !== undefined ? { report: event.report } : {}),
        ...(event.agentId ? { agentId: event.agentId } : {}),
        ...(event.model ? { model: event.model } : {}),
      }));
    case 'task-launched':
      return updateTask(state, event.id, (task) =>
        task.kind !== 'subagent'
          ? undefined
          : {
              ...task,
              agentId: event.agentId,
              ...(event.model ? { model: event.model } : {}),
              ...(event.async ? { async: true as const } : {}),
            },
      );
    case 'task-output':
      return updateTask(state, event.id, (task) =>
        task.kind !== 'background' || task.outputAvailable
          ? undefined
          : { ...task, outputAvailable: true },
      );
    case 'gap': {
      if (state.gaps.includes(event.reason)) return state;
      return { ...state, gaps: [...state.gaps, event.reason].slice(-GAP_LIMIT) };
    }
  }
}

const cut = (text: string): string => text.slice(0, SUMMARY_CHARS);

const stringField = (input: JsonRecord, key: string): string | undefined => {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
};

function relativeToCwd(file: string, cwd?: string): string {
  if (!cwd) return file;
  const relative = path.relative(cwd, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
}

function fallbackSummary(input: JsonRecord): string {
  const first = Object.values(input).find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );
  return first ?? JSON.stringify(input);
}

export function summarizeToolCall(tool: string, input: JsonRecord, cwd?: string): string {
  const summary = (): string => {
    if (tool === 'Bash') {
      const description = stringField(input, 'description');
      if (description) return description;
      const command = stringField(input, 'command') ?? '';
      return command.split('\n').find((line) => line.trim()) ?? '';
    }
    if (FILE_TOOLS.has(tool)) {
      const file = stringField(input, 'file_path');
      if (file) return relativeToCwd(file, cwd);
    }
    if (tool === 'Grep') {
      const pattern = stringField(input, 'pattern');
      if (pattern) {
        const where = stringField(input, 'path');
        return where ? `${pattern} in ${relativeToCwd(where, cwd)}` : pattern;
      }
    }
    const direct: Record<string, string> = {
      Glob: 'pattern',
      Agent: 'description',
      Skill: 'skill',
      WebFetch: 'url',
      WebSearch: 'query',
    };
    const key = direct[tool];
    const value = key ? stringField(input, key) : undefined;
    return value ?? fallbackSummary(input);
  };
  return cut(summary());
}

export function renderToolInput(tool: string, input: JsonRecord): string {
  if (tool === 'Bash' && typeof input.command === 'string') {
    return input.command.slice(0, ACTIVITY_RESULT_CHARS);
  }
  return (JSON.stringify(input, null, 2) ?? '').slice(0, ACTIVITY_RESULT_CHARS);
}
