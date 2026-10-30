import { setTimeout as delay } from 'node:timers/promises';
import type { Target } from '../core/contracts.js';
import { recordOf } from '../core/json-record.js';
import { MOVE_RESUME_CHECK_MS } from '../core/claude-move-policy.js';
import { claudeConfigDir, validateTarget } from '../agents/shared.js';
import { pidExists } from '../agents/claude/liveness.js';
import { readProcess, type ProcessInfo } from '../agents/claude/process-probe.js';
import {
  projectSessionRecords,
  readSessionRecord,
  sessionRecordPath,
  trustedProcStart,
} from '../agents/claude/session-records.js';
import {
  MOVE_ALREADY_MOVING_REASON,
  MOVE_ALREADY_WAITING_REASON,
  MOVE_CHANGED_REASON,
  MOVE_NOT_CLOSED_REASON,
  MOVE_RESUME_EXITED_REASON,
  MOVE_RESUME_OTHER_REASON,
  MOVE_RESUME_STILL_OPEN_REASON,
  MOVE_RESUME_UNCONFIRMED_REASON,
  MOVE_WAIT_ENDED_REASON,
  glossHoldsSession,
  glossOwnsSession,
  isSessionProcess,
  manualResume,
  moveReadiness,
  pickMoveCandidate,
  sameIdleProcess,
  type GlossLaunches,
  type MoveCandidate,
  type VerifiedRecord,
} from '../agents/claude/move.js';
import {
  launchOwners,
  type LaunchRecord,
  type PreparedResume,
  type SessionLauncher,
} from './session-launcher.js';

/** Spec 5.3: how long Gloss waits after SIGTERM for Claude to exit, in milliseconds. */
export const MOVE_CLOSE_TIMEOUT_MS = 10_000;
/** Step between checks that the closed process is gone, in milliseconds. */
const MOVE_CLOSE_POLL_MS = 100;
/** "Move when it finishes" re-reads the session record this often, in milliseconds. */
export const MOVE_WAIT_POLL_MS = 1000;
/**
 * Longest a "Move when it finishes" wait stays armed, in milliseconds (4 hours). A session left with a dialog open
 * would otherwise keep the wait, and its polling, alive for as long as Gloss runs.
 */
export const MOVE_WAIT_MAX_MS = 4 * 60 * 60 * 1000;
export { MOVE_RESUME_CHECK_MS };
/** Step between checks of a reopened session, in milliseconds. */
const MOVE_RESUME_POLL_MS = 250;
/** Bound on one `ps` read, in milliseconds; a slow answer reads as "not this process", so nothing is signalled. */
const MOVE_PROBE_TIMEOUT_MS = 2000;
/** Longest `procStart` a request may carry, in characters; `ps -o lstart=` prints 24. */
const MAX_PROC_START_CHARS = 64;
/**
 * A record that can't be read while its process still runs is retried for this many consecutive "Move when it
 * finishes" polls (a write caught half-way) before the wait ends.
 */
export const MOVE_WAIT_UNREADABLE_POLLS = 3;
/** pid 1 is launchd; no Claude session runs there, so it is never signalled. */
const MIN_SIGNALLED_PID = 2;

export interface MoveIdentity {
  pid: number;
  procStart: string;
}
export interface ClaudeMoveFailure {
  reason: string;
  manual?: { command: string; cdCommand: string };
}
export type ClaudeMoveStatus = (
  | { state: 'ready'; process: MoveIdentity }
  | { state: 'busy'; reason: string; process: MoveIdentity }
  | { state: 'waiting' }
  | { state: 'moving' }
  | { state: 'in-gloss' }
  | { state: 'unavailable'; reason: string }
) & { failure?: ClaudeMoveFailure };
export type ClaudeMoveRequest =
  { action: 'cancel' } | { action: 'move' | 'when-idle'; expected: MoveIdentity };
export interface ClaudeMoveService {
  status(target: Target): Promise<ClaudeMoveStatus>;
  act(target: Target, request: ClaudeMoveRequest): Promise<ClaudeMoveStatus>;
  close(): void;
}
/** Trusted host/test options only; never from a browser. */
export interface ClaudeMoveOptions {
  configDir?: string | undefined;
  /** Gloss's launches: what owns a session, the reopen itself, and the normal End for a reopen that went wrong. */
  launcher: Pick<SessionLauncher, 'list' | 'prepareResume' | 'resume' | 'end'>;
  /** Registered panels, to tell which launches own a session through their panel. */
  panels(): readonly { id: string; target: Target }[];
  /** Whether the launch's tmux session still runs. */
  paneAlive(launchId: string): Promise<boolean>;
  probe?: ((pid: number) => Promise<ProcessInfo | undefined>) | undefined;
  /** Sends the one signal this service ever sends. The type admits nothing else. */
  terminate?: ((pid: number, signal: 'SIGTERM') => void) | undefined;
  processExists?: ((pid: number) => boolean) | undefined;
  uid?: number | undefined;
  /** Monotonic milliseconds. */
  now?: (() => number) | undefined;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  /** Diagnostics that change nothing, such as a record Claude left behind. */
  log?: ((message: string) => void) | undefined;
}

/** Accepts exactly {"action":"cancel"} or {"action":"move"|"when-idle","pid","procStart"}; parsed JSON is untrusted. */
export function parseMoveRequest(value: unknown): ClaudeMoveRequest {
  const body = recordOf(value);
  const keys = body ? Object.keys(body).length : 0;
  if (body?.action === 'cancel' && keys === 1) return { action: 'cancel' };
  const { pid, procStart } = body ?? {};
  if (
    (body?.action === 'move' || body?.action === 'when-idle') &&
    keys === 3 &&
    typeof pid === 'number' &&
    Number.isSafeInteger(pid) &&
    pid >= MIN_SIGNALLED_PID &&
    typeof procStart === 'string' &&
    procStart.length > 0 &&
    procStart.length <= MAX_PROC_START_CHARS
  )
    return { action: body.action, expected: { pid, procStart } };
  throw new Error(
    'Expected {"action": "move" or "when-idle", "pid", "procStart"} or {"action": "cancel"}.',
  );
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Claude could not reopen the session.';
const sameIdentity = (record: VerifiedRecord, expected: MoveIdentity) =>
  record.pid === expected.pid && record.procStart === expected.procStart;
type CloseOutcome = { closed: true } | { closed: false; reason: string };
const notClosed = (reason: string): CloseOutcome => ({ closed: false, reason });
/** Work that continues after a move's response: the move is in flight until `check` settles. */
interface FollowUp {
  check: Promise<void>;
}

/**
 * Spec 5: closes an idle outside Claude session with SIGTERM and reopens it in Gloss's tmux. Never SIGKILL, never a
 * second signal, never a process of Gloss's own panes. One move or wait per session at a time.
 */
export function createClaudeMove(options: ClaudeMoveOptions): ClaudeMoveService {
  const config = claudeConfigDir(options.configDir);
  const stopAll = new AbortController();
  const probe = options.probe ?? ((pid) => readProcess(pid, stopAll.signal, MOVE_PROBE_TIMEOUT_MS));
  const terminate =
    options.terminate ??
    ((pid, signal) => {
      process.kill(pid, signal);
    });
  const exists = options.processExists ?? pidExists;
  const uid = 'uid' in options ? options.uid : process.getuid?.();
  const now = options.now ?? (() => performance.now());
  const sleep =
    options.sleep ??
    ((ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal }).catch(() => undefined));
  const log = options.log ?? ((message: string) => console.warn(message));
  const failures = new Map<string, ClaudeMoveFailure>();
  /** Sessions with a move in flight, from the press until the reopen returns. */
  const moving = new Set<string>();
  const waiters = new Map<string, AbortController>();
  const stopped = () => stopAll.signal.aborted;

  const liveProcess = (pid: number) => probe(pid).catch(() => undefined);
  /** C1: what Gloss itself holds, from its launches now. An unanswered pane check counts as a running pane. */
  async function glossLaunches(sessionRef: string): Promise<GlossLaunches> {
    const launches = options.launcher.list();
    const owners = await launchOwners(
      'claude',
      sessionRef,
      launches,
      options.panels(),
      (launchId) => options.paneAlive(launchId).catch(() => true),
    );
    return { owners, panePids: launches.map((launch) => launch.panePid) };
  }
  /** The session's records in the target's project, each with what `ps` reports for its pid. */
  async function matches(target: Target) {
    const records = await projectSessionRecords(config, target.sessionRef, target.projectId);
    return Promise.all(
      records.map(async (record) => ({ record, process: await liveProcess(record.pid) })),
    );
  }
  async function candidate(target: Target, gloss: GlossLaunches): Promise<MoveCandidate> {
    return pickMoveCandidate(await matches(target), uid, gloss);
  }
  async function status(target: Target): Promise<ClaudeMoveStatus> {
    validateTarget(target, 'claude');
    const ref = target.sessionRef;
    // A failure stays visible with every state, including after a reopen whose pane then closed.
    const failure = failures.get(ref);
    const noted = (value: ClaudeMoveStatus): ClaudeMoveStatus =>
      failure ? { ...value, failure } : value;
    if (waiters.has(ref)) return noted({ state: 'waiting' });
    const gloss = await glossLaunches(ref);
    // While the reopened session is being checked, the move is still in flight but the session already runs in Gloss.
    if (glossOwnsSession(gloss)) return noted({ state: 'in-gloss' });
    if (moving.has(ref)) return { state: 'moving' };
    const found = await candidate(target, gloss);
    if (found.kind === 'blocked') return noted({ state: 'unavailable', reason: found.reason });
    const process = { pid: found.record.pid, procStart: found.record.procStart };
    const readiness = moveReadiness(found.record);
    return noted(
      readiness.kind === 'ready'
        ? { state: 'ready', process }
        : { state: 'busy', reason: readiness.reason, process },
    );
  }
  function stopWaiting(ref: string) {
    waiters.get(ref)?.abort();
    waiters.delete(ref);
  }
  /** Ours is gone when nothing runs at its pid, or what runs there started at another time (a reused pid). */
  async function processGone(before: VerifiedRecord): Promise<boolean> {
    if (!exists(before.pid)) return true;
    const current = await liveProcess(before.pid);
    return current !== undefined && current.startedAt !== before.procStart;
  }
  /**
   * Spec 5.3 and C1: identifies the process again right before the signal (Gloss's launches, every record of the
   * session with `ps`, then this record re-read last), sends one SIGTERM and waits for the process to exit.
   */
  async function closeProcess(
    ref: string,
    target: Target,
    before: VerifiedRecord,
  ): Promise<CloseOutcome> {
    const gloss = await glossLaunches(ref);
    const found = await candidate(target, gloss);
    if (found.kind === 'blocked') return notClosed(found.reason);
    const live = await liveProcess(before.pid);
    const record = await readSessionRecord(sessionRecordPath(config, before.pid));
    if (
      !sameIdentity(found.record, before) ||
      !live ||
      live.pid !== before.pid ||
      before.pid < MIN_SIGNALLED_PID ||
      !isSessionProcess(before, live, uid) ||
      glossHoldsSession(live, gloss) ||
      !sameIdleProcess(before, record) ||
      record?.cwd !== before.cwd
    )
      return notClosed(MOVE_CHANGED_REASON);
    // The last check before the signal, with no await after it: Gloss quitting meanwhile sends nothing.
    if (stopped()) return notClosed(MOVE_CHANGED_REASON);
    try {
      terminate(before.pid, 'SIGTERM');
    } catch (error) {
      // ESRCH: it exited at this instant, and the wait below sees it gone. Anything else: nothing was sent.
      if (recordOf(error)?.code !== 'ESRCH') return notClosed(MOVE_NOT_CLOSED_REASON);
    }
    const deadline = now() + MOVE_CLOSE_TIMEOUT_MS;
    for (;;) {
      if (await processGone(before)) {
        await noteRecordLeft(before);
        return { closed: true };
      }
      if (now() >= deadline || stopped()) return notClosed(MOVE_NOT_CLOSED_REASON);
      await sleep(MOVE_CLOSE_POLL_MS);
    }
  }
  /** Ruling I1: the process being gone is enough; a record it left behind is only noted. */
  async function noteRecordLeft(before: VerifiedRecord) {
    const left = await readSessionRecord(sessionRecordPath(config, before.pid));
    if (left && trustedProcStart(left) === before.procStart)
      log(`Claude ${before.pid} exited on SIGTERM but left its session record behind.`);
  }
  /**
   * Gloss launched the pane, so its record is the pane's when it names the pane pid and that process is alive; no
   * `procStart` or `pidDomain` is needed. Only a trusted start time that `ps` contradicts marks a record an earlier
   * process left at a reused pid.
   */
  async function paneRecord(launch: LaunchRecord) {
    const record = await readSessionRecord(sessionRecordPath(config, launch.panePid));
    if (!record || record.pid !== launch.panePid || !exists(launch.panePid)) return undefined;
    const trusted = trustedProcStart(record);
    if (trusted === undefined) return record;
    const live = await liveProcess(launch.panePid);
    return live && live.startedAt !== trusted ? undefined : record;
  }
  /**
   * Decision 8 and ruling I2: after `resume` returned, the pane's own record must name this session. Another session
   * in the pane, or the pane closing, ends that launch through the launcher's normal End and reports the failure.
   */
  async function checkResume(ref: string, launch: LaunchRecord, folder: string) {
    const deadline = now() + MOVE_RESUME_CHECK_MS;
    /** Waits for `work` no longer than the check has left, so a hung tmux can't keep the move in flight. */
    const bounded = <T>(work: Promise<T>): Promise<{ value: T } | undefined> => {
      const timer = new AbortController();
      return Promise.race([
        work.then((value) => ({ value })),
        sleep(Math.max(0, deadline - now()), timer.signal).then(() => undefined),
      ]).finally(() => timer.abort());
    };
    const fail = async (reason: string) => {
      const manual = manualResume(ref, folder);
      failures.set(ref, { reason, manual });
      try {
        if (!(await bounded(options.launcher.end(launch.id))))
          throw new Error('End did not finish in time');
      } catch (error) {
        failures.set(ref, { reason: `${reason} ${MOVE_RESUME_STILL_OPEN_REASON}`, manual });
        log(`Ending a reopened Claude launch failed: ${errorText(error)}`);
      }
    };
    while (now() < deadline && !stopped()) {
      const record = await paneRecord(launch);
      if (stopped()) return;
      if (record) {
        if (record.sessionId !== ref) await fail(MOVE_RESUME_OTHER_REASON);
        return;
      }
      const pane = await bounded(options.paneAlive(launch.id).catch(() => true));
      if (stopped()) return;
      if (!pane) {
        // tmux didn't answer: the pane may be fine, so it is neither ended nor offered a second resume.
        failures.set(ref, { reason: MOVE_RESUME_UNCONFIRMED_REASON });
        return;
      }
      if (!pane.value) {
        await fail(MOVE_RESUME_EXITED_REASON);
        return;
      }
      await sleep(MOVE_RESUME_POLL_MS);
    }
  }
  /** I5: the reopen is prepared before anything is closed, and started only once the process is gone. */
  async function moveNow(target: Target, before: VerifiedRecord): Promise<FollowUp | undefined> {
    const ref = target.sessionRef;
    // I5: the folder is always the record's own.
    const folder = before.cwd;
    let prepared: PreparedResume;
    try {
      prepared = await options.launcher.prepareResume({ agent: 'claude', sessionRef: ref, folder });
    } catch (error) {
      // Nothing was closed: the session still runs in its terminal, so no manual command is offered.
      failures.set(ref, { reason: errorText(error) });
      return;
    }
    if (stopped()) return;
    const outcome = await closeProcess(ref, target, before);
    if (!outcome.closed) {
      failures.set(ref, { reason: outcome.reason });
      return;
    }
    let launch: LaunchRecord;
    try {
      launch = await options.launcher.resume(prepared);
    } catch (error) {
      failures.set(ref, { reason: errorText(error), manual: manualResume(ref, folder) });
      return;
    }
    return {
      check: checkResume(ref, launch, folder).catch((error: unknown) =>
        log(`Checking a reopened Claude session failed: ${errorText(error)}`),
      ),
    };
  }
  /**
   * Runs `work` as this session's one move; the caller has checked that none is in flight. The move stays in flight
   * until it resolves: through the reopen check when `work` hands one back.
   */
  async function asMove(ref: string, work: () => Promise<FollowUp | undefined>) {
    moving.add(ref);
    let followUp: FollowUp | undefined;
    try {
      followUp = await work();
    } catch (error) {
      failures.set(ref, { reason: errorText(error) });
    } finally {
      if (followUp) void followUp.check.finally(() => moving.delete(ref));
      else moving.delete(ref);
    }
  }
  function startWaiting(target: Target, record: VerifiedRecord) {
    const ref = target.sessionRef;
    const stop = new AbortController();
    waiters.set(ref, stop);
    const ended = () => stop.signal.aborted || stopped() || waiters.get(ref) !== stop;
    const endWait = () => {
      waiters.delete(ref);
      failures.set(ref, { reason: MOVE_WAIT_ENDED_REASON });
    };
    let unreadable = 0;
    const deadline = now() + MOVE_WAIT_MAX_MS;
    void (async () => {
      while (!ended()) {
        await sleep(MOVE_WAIT_POLL_MS);
        if (ended()) return;
        if (now() >= deadline || !exists(record.pid)) return endWait();
        const current = await readSessionRecord(sessionRecordPath(config, record.pid));
        // I3: re-checked after every await; a Cancel, a quit or a newer wait may have come meanwhile.
        if (ended()) return;
        if (!current) {
          if (++unreadable >= MOVE_WAIT_UNREADABLE_POLLS || !exists(record.pid)) endWait();
          continue;
        }
        unreadable = 0;
        if (
          current.pid !== record.pid ||
          trustedProcStart(current) !== record.procStart ||
          current.sessionId !== record.sessionId
        )
          return endWait();
        if (!sameIdleProcess(record, current)) continue;
        // The wait becomes the move in one step, so no other press can start one in between.
        waiters.delete(ref);
        if (moving.has(ref)) return;
        await asMove(ref, () => moveNow(target, { ...current, procStart: record.procStart }));
        return;
      }
    })();
  }
  /** I3: a press while a move or a wait exists for the session is refused, with the reason; it is not stored. */
  async function refused(target: Target, reason: string): Promise<ClaudeMoveStatus> {
    return { ...(await status(target)), failure: { reason } };
  }
  return {
    status,
    async act(target, request) {
      validateTarget(target, 'claude');
      if (stopped()) throw new Error('Gloss is closing');
      const ref = target.sessionRef;
      if (request.action === 'cancel') {
        stopWaiting(ref);
        return status(target);
      }
      if (moving.has(ref)) return refused(target, MOVE_ALREADY_MOVING_REASON);
      if (waiters.has(ref)) return refused(target, MOVE_ALREADY_WAITING_REASON);
      // Claimed before the first await: a concurrent press sees this move.
      await asMove(ref, async () => {
        failures.delete(ref);
        const gloss = await glossLaunches(ref);
        if (glossOwnsSession(gloss)) return;
        const found = await candidate(target, gloss);
        if (found.kind === 'blocked') return;
        if (!sameIdentity(found.record, request.expected)) {
          failures.set(ref, { reason: MOVE_CHANGED_REASON });
          return;
        }
        if (moveReadiness(found.record).kind === 'ready') return moveNow(target, found.record);
        if (request.action === 'when-idle') startWaiting(target, found.record);
        return undefined;
      });
      return status(target);
    },
    close() {
      stopAll.abort();
      for (const waiter of waiters.values()) waiter.abort();
      waiters.clear();
    },
  };
}
