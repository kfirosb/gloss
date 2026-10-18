import { shellQuote } from '../../core/command-text.js';
import type { LaunchState } from '../../core/session-contracts.js';
import { claudeActivity } from './activity.js';
import { isClaudeExecutable, type ProcessInfo } from './process-probe.js';
import { isTerminalRecord, trustedProcStart, type ClaudeSessionRecord } from './session-records.js';

// Spec 5, verbatim where the spec gives the words (ASCII apostrophes as in the spec).
export const MOVE_WORKING_REASON = 'Claude is working; it can be moved when it finishes';
export const MOVE_NOT_CLOSED_REASON =
  "The session wasn't closed; close it in the terminal and press again";
// Gloss's own words where the spec is silent (plan Decisions 1-8).
export const MOVE_DIALOG_REASON =
  'Claude is waiting for an answer in its terminal; it can be moved when that’s answered';
export const MOVE_DESKTOP_REASON = 'Claude Desktop sessions can’t be moved to Gloss.';
export const MOVE_NOT_RUNNING_REASON = 'This Claude session isn’t running in a terminal now.';
export const MOVE_AMBIGUOUS_REASON =
  'More than one Claude process has this session open. Close the others, then try again.';
export const MOVE_UNVERIFIED_REASON =
  'Gloss can’t confirm which process runs this session, so it won’t close it.';
export const MOVE_IN_GLOSS_REASON = 'This session already runs in Gloss.';
export const MOVE_CHANGED_REASON =
  'The session changed in its terminal before Gloss closed it. Nothing was closed; press again.';
export const MOVE_WAIT_ENDED_REASON =
  'The session closed or restarted before it finished, so Gloss didn’t move it.';
export const MOVE_RESUME_EXITED_REASON = 'Claude closed as soon as Gloss reopened the session.';
export const MOVE_RESUME_OTHER_REASON = 'Claude opened a different session instead of this one.';

/** A record whose process can be identified across pid reuse. */
export type VerifiedRecord = ClaudeSessionRecord & { procStart: string };
export type MoveReadiness = { kind: 'ready' } | { kind: 'busy'; reason: string };
export type MoveCandidate =
  { kind: 'found'; record: VerifiedRecord } | { kind: 'blocked'; reason: string };
/**
 * Gloss's own launches, as far as a move must avoid them: the Claude launches owning the session (directly or
 * through its panel), with whether each one's tmux pane still runs, and the pane pid of every launch in any state.
 */
export interface GlossLaunches {
  owners: readonly { state: LaunchState; paneAlive: boolean }[];
  panePids: readonly number[];
}

/**
 * Spec 5.1: only an idle record may be moved; Gloss can't see an outside screen, so a dialog is read from the record.
 * A Claude Desktop session is never movable, whatever its status.
 */
export function moveReadiness(
  record: Pick<ClaudeSessionRecord, 'status' | 'waitingFor' | 'entrypoint'>,
): MoveReadiness {
  if (record.entrypoint === 'claude-desktop') return { kind: 'busy', reason: MOVE_DESKTOP_REASON };
  const activity = claudeActivity(record.status, record.waitingFor);
  if (activity === 'idle') return { kind: 'ready' };
  return {
    kind: 'busy',
    reason: activity === 'working' ? MOVE_WORKING_REASON : MOVE_DIALOG_REASON,
  };
}
/**
 * A Claude process of this user runs at the record's pid, and started when the record says it did if the record's
 * start time can be trusted. Without a trusted start time a reused pid can't be told apart, so this alone is not
 * enough to signal the process.
 */
function runsRecord(
  record: Pick<ClaudeSessionRecord, 'pid' | 'procStart' | 'pidDomain' | 'version'>,
  live: ProcessInfo | undefined,
  uid: number | undefined,
): live is ProcessInfo {
  const procStart = trustedProcStart(record);
  return (
    !!live &&
    uid !== undefined &&
    live.pid === record.pid &&
    live.uid === uid &&
    (procStart === undefined || live.startedAt === procStart) &&
    isClaudeExecutable(live.command, record.version)
  );
}
/** The live process is the one the record describes: same pid and trusted start time, this user's, running Claude. */
export function isSessionProcess(
  record: Pick<ClaudeSessionRecord, 'pid' | 'procStart' | 'pidDomain' | 'version'>,
  live: ProcessInfo | undefined,
  uid: number | undefined,
): boolean {
  return trustedProcStart(record) !== undefined && runsRecord(record, live, uid);
}
/** Spec 5.3: the re-read record still describes the same idle process. */
export function sameIdleProcess(
  before: VerifiedRecord,
  after: ClaudeSessionRecord | undefined,
): boolean {
  return (
    !!after &&
    after.pid === before.pid &&
    trustedProcStart(after) === before.procStart &&
    after.sessionId === before.sessionId &&
    moveReadiness(after).kind === 'ready'
  );
}
/**
 * Whether Gloss itself holds the session or the process: a live owning launch, an ended one whose pane still runs,
 * or any launch's pane being that very process or its parent (a Claude typed into a Gloss shell). Gloss must never
 * close a process of its own panes.
 */
export function glossHoldsSession(
  process: Pick<ProcessInfo, 'pid' | 'ppid'>,
  gloss: GlossLaunches,
): boolean {
  return (
    glossOwnsSession(gloss) ||
    gloss.panePids.includes(process.pid) ||
    gloss.panePids.includes(process.ppid)
  );
}
/** A launch that is not ended owns the session, and so does an ended one whose pane still runs. */
function glossOwnsSession(gloss: GlossLaunches): boolean {
  return gloss.owners.some((launch) => launch.state !== 'ended' || launch.paneAlive);
}
/** One record for the session, with what `ps` reports for its pid now (undefined when nothing runs there). */
export interface MoveMatch {
  record: ClaudeSessionRecord;
  process: ProcessInfo | undefined;
}
/**
 * The one outside process to move among this session's records in its project, for the user `uid`. Every live
 * terminal process counts: one Gloss can't verify blocks the move, since closing another would leave it writing.
 */
export function pickMoveCandidate(
  matches: readonly MoveMatch[],
  uid: number | undefined,
  gloss: GlossLaunches,
): MoveCandidate {
  if (glossOwnsSession(gloss)) return { kind: 'blocked', reason: MOVE_IN_GLOSS_REASON };
  if (matches.some(({ record }) => record.entrypoint === 'claude-desktop'))
    return { kind: 'blocked', reason: MOVE_DESKTOP_REASON };
  const live = matches.flatMap(({ record, process }) =>
    isTerminalRecord(record) && runsRecord(record, process, uid) ? [{ record, process }] : [],
  );
  if (live.some(({ process }) => glossHoldsSession(process, gloss)))
    return { kind: 'blocked', reason: MOVE_IN_GLOSS_REASON };
  const verified = live.flatMap(({ record }) => {
    const procStart = trustedProcStart(record);
    return procStart ? [{ ...record, procStart }] : [];
  });
  if (verified.length < live.length)
    return {
      kind: 'blocked',
      reason: verified.length ? MOVE_AMBIGUOUS_REASON : MOVE_UNVERIFIED_REASON,
    };
  const [only, ...more] = verified;
  if (more.length) return { kind: 'blocked', reason: MOVE_AMBIGUOUS_REASON };
  if (only) return { kind: 'found', record: only };
  return { kind: 'blocked', reason: MOVE_NOT_RUNNING_REASON };
}
/** Spec 5.6: what the user runs when Gloss could not reopen the session. `sessionRef` is a validated UUID. */
export function manualResume(sessionRef: string, folder: string) {
  const command = `claude --resume ${sessionRef}`;
  return { command, cdCommand: `cd ${shellQuote(folder)} && ${command}` };
}
