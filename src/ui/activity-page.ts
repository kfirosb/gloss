import type { ActivityCall, ActivityTask } from '../core/activity-contracts.js';
import type { CodingState } from '../core/contracts.js';

/** How many recent main-session calls the live page lists before "show earlier". */
export const ACTIVITY_LAST_ACTIONS = 5;
/** How long a newly arrived call stays highlighted, in milliseconds. */
export const ACTIVITY_NEW_ROW_MS = 2000;

export interface ActivityArrival {
  id: string;
  at: number;
}

export function clock(timestamp?: string): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
export function duration(from?: string, to?: string | number): string {
  if (!from || to === undefined) return '';
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const newestFirst = <T extends { position: number }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => b.position - a.position);

/** The caller passes main-session (depth 0) calls; newest first, capped unless showAll. */
export function lastActions(calls: readonly ActivityCall[], showAll: boolean): ActivityCall[] {
  const ordered = newestFirst(calls);
  return showAll ? ordered : ordered.slice(0, ACTIVITY_LAST_ACTIONS);
}

export function earlierCount(calls: readonly ActivityCall[]): number {
  return Math.max(0, calls.length - ACTIVITY_LAST_ACTIONS);
}

export function groupTasks(tasks: readonly ActivityTask[]): {
  subagents: ActivityTask[];
  commands: ActivityTask[];
  finished: ActivityTask[];
} {
  const ordered = newestFirst(tasks);
  const running = ordered.filter((entry) => entry.status === 'running');
  return {
    subagents: running.filter((entry) => entry.kind === 'subagent'),
    commands: running.filter((entry) => entry.kind === 'background'),
    finished: ordered.filter((entry) => entry.status !== 'running'),
  };
}

export function historySummary(finished: readonly ActivityTask[]): string {
  const subagents = finished.filter((entry) => entry.kind === 'subagent').length;
  const commands = finished.length - subagents;
  const parts = [
    subagents > 0 ? `${subagents} finished ${subagents === 1 ? 'subagent' : 'subagents'}` : '',
    commands > 0 ? `${commands} finished ${commands === 1 ? 'command' : 'commands'}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'nothing finished yet';
}

export function mainStatus(
  codingState: CodingState,
  running: number,
): 'working' | 'idle' | 'disconnected' {
  if (codingState === 'disconnected') return 'disconnected';
  const busy =
    codingState === 'working' ||
    codingState === 'approval-required' ||
    codingState === 'dialog-open';
  return busy || running > 0 ? 'working' : 'idle';
}

function newestCall(calls: readonly ActivityCall[]): ActivityCall | undefined {
  return calls.reduce<ActivityCall | undefined>(
    (newest, entry) => (!newest || entry.position > newest.position ? entry : newest),
    undefined,
  );
}

export function sinceLastAction(calls: readonly ActivityCall[], now: number): string {
  const text = duration(newestCall(calls)?.timestamp, now);
  return text ? `${text} since last action` : '';
}

export function newestArrival(
  previous: ActivityArrival | undefined,
  calls: readonly ActivityCall[],
  now: number,
): ActivityArrival | undefined {
  const newest = newestCall(calls);
  if (!newest) return undefined;
  return previous?.id === newest.id ? previous : { id: newest.id, at: now };
}

export function isHighlighted(
  arrival: ActivityArrival | undefined,
  call: ActivityCall,
  now: number,
): boolean {
  return arrival?.id === call.id && now - arrival.at < ACTIVITY_NEW_ROW_MS;
}

/**
 * Terminal escapes a background command writes: CSI (colours, cursor moves, erase), OSC ended by
 * BEL or ST (titles, links), DCS/SOS/PM/APC strings ended by ST, and short escapes such as
 * `ESC ( B`. An unfinished CSI, OSC or string is never read as a short escape: inside the text
 * (an OSC that meets a newline) only its `ESC` goes, in the control pass; at the end it all goes.
 */
const TERMINAL_ESCAPE =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b\n]*(?:\u0007|\u001b\\)|[PX^_][^\u001b\n]*\u001b\\|(?![[\]PX^_])[ -/]*[0-~])/g;
/** The start of an escape the text ends inside, as when a live chunk stops mid-sequence. */
const UNFINISHED_ESCAPE =
  /\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b\n]*\u001b?|[PX^_][^\u001b\n]*\u001b?|[ -/]*)$/;
/** C0 controls except tab and newline (carriage returns are resolved first), DEL and C1 controls. */
const CONTROLS = '\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f';
const CONTROL = new RegExp(`[${CONTROLS}]`, 'g');
const HAS_CONTROL = new RegExp(`[${CONTROLS}]`);

/** A line as a terminal leaves it after `\r` overwrites: the text after the last carriage return. */
function overwritten(line: string): string {
  const text = line.replace(/\r+$/, '');
  return text.slice(text.lastIndexOf('\r') + 1);
}

/**
 * Background output as plain text: escape sequences removed, carriage-return progress reduced to
 * its latest text, and other control characters dropped. The caller passes the joined raw text,
 * so a sequence split across chunks or pages reads whole once both parts are present.
 */
export function readableOutput(text: string): string {
  if (!HAS_CONTROL.test(text)) return text;
  const stripped = text.replace(TERMINAL_ESCAPE, '').replace(UNFINISHED_ESCAPE, '');
  const lines = stripped.includes('\r')
    ? stripped.split('\n').map(overwritten).join('\n')
    : stripped;
  return lines.replace(CONTROL, '');
}
