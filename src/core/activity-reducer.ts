// Browser-safe: the UI folds live subagent streams with this reducer, so it must not import Node modules.
import {
  ACTIVITY_CALL_LIMIT,
  ACTIVITY_REPORT_CHARS,
  ACTIVITY_RESULT_CHARS,
  ACTIVITY_TASK_LIMIT,
  type ActivityEvent,
  type ActivitySnapshot,
  type ActivityTask,
} from './activity-contracts.js';

const GAP_LIMIT = 20;

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
      const call = { ...event.call, input: event.call.input.slice(0, ACTIVITY_RESULT_CHARS) };
      return { ...state, calls: insertByPosition(state.calls, call, ACTIVITY_CALL_LIMIT) };
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
      const finishedAt = event.result.timestamp ? { finishedAt: event.result.timestamp } : {};
      return updateTask(next, event.id, (task) => {
        if (task.status !== 'running') return undefined;
        // A background command or an async subagent keeps running past a successful launch result;
        // a failed one (denied, invalid input) never started, so nothing else will end it.
        if (task.kind === 'background')
          return event.result.failed ? { ...task, status: 'failed', ...finishedAt } : undefined;
        if (task.async && !event.result.failed) return undefined;
        return {
          ...task,
          status: event.result.failed ? 'failed' : 'finished',
          report: event.result.text.slice(0, ACTIVITY_REPORT_CHARS),
          ...finishedAt,
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
    case 'report': {
      const report = event.report.slice(0, ACTIVITY_REPORT_CHARS);
      const index = state.tasks.findIndex(
        (task) => task.kind === 'subagent' && task.agentId === event.agentId,
      );
      if (index < 0 || state.tasks[index]!.report === report) return state;
      // A resumed agent hands back a new report; its old translation no longer applies.
      const { reportTranslation: _stale, ...task } = state.tasks[index]!;
      const tasks = [...state.tasks];
      tasks[index] = { ...task, report };
      return withTasks(state, tasks);
    }
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
