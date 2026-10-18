export type ActivityStatus = 'running' | 'finished' | 'failed';
export interface ActivityCall {
  id: string; // tool_use block id
  tool: string; // 'Bash', 'Read', 'Agent', ...
  summary: string; // one line, see summarizeToolCall
  input: string; // bounded rendering of the full input
  position: number; // transcript byte offset of the tool_use record, orders the timeline
  timestamp?: string;
  background?: true;
  depth: number; // 0 in the main session, meta.spawnDepth in a subagent file
  result?: { text: string; failed: boolean; timestamp?: string };
}
export interface ActivityTask {
  kind: 'subagent' | 'background';
  id: string; // the starting tool_use id (the client's handle for streams)
  description: string;
  position: number;
  depth: number;
  status: ActivityStatus;
  startedAt?: string;
  finishedAt?: string;
  command?: string; // background
  agentType?: string; // subagent
  model?: string; // subagent
  agentId?: string; // subagent, once known
  report?: string; // subagent final report
  reportTranslation?: { text: string; status: 'pending' | 'complete' | 'error' };
  outputAvailable?: boolean; // background: the server could validate the output path
  /** Reducer-internal: a launched async subagent keeps running past its tool result. */
  async?: true;
}
export type ActivityEvent =
  | { kind: 'call'; call: ActivityCall }
  | { kind: 'result'; id: string; result: NonNullable<ActivityCall['result']> }
  | { kind: 'task-start'; task: ActivityTask }
  | {
      kind: 'task-end';
      id: string;
      status: Exclude<ActivityStatus, 'running'>;
      finishedAt?: string;
      report?: string;
      agentId?: string;
      model?: string;
    }
  | { kind: 'task-launched'; id: string; agentId: string; model?: string; async: boolean } // subagent identified; async ones keep running past their result
  | { kind: 'report'; agentId: string; report: string } // an async subagent's final report, matched by agentId
  | { kind: 'task-output'; id: string; taskId: string; outputPath: string } // background output file named; the reducer keeps only outputAvailable
  | { kind: 'gap'; reason: string };
export interface ActivitySnapshot {
  calls: ActivityCall[]; // ascending by position
  tasks: ActivityTask[]; // ascending by position
  running: number;
  gaps: string[];
}
export const ACTIVITY_CALL_LIMIT = 2000;
export const ACTIVITY_TASK_LIMIT = 200;
export const ACTIVITY_RESULT_CHARS = 20_000;
