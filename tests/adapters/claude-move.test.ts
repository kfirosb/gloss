import { expect, it } from 'vitest';
import {
  MOVE_AMBIGUOUS_REASON,
  MOVE_DESKTOP_REASON,
  MOVE_DIALOG_REASON,
  MOVE_IN_GLOSS_REASON,
  MOVE_NOT_CLOSED_REASON,
  MOVE_NOT_RUNNING_REASON,
  MOVE_UNVERIFIED_REASON,
  MOVE_WORKING_REASON,
  glossHoldsSession,
  isSessionProcess,
  manualResume,
  moveReadiness,
  pickMoveCandidate,
  sameIdleProcess,
  type GlossLaunches,
  type MoveMatch,
  type VerifiedRecord,
} from '../../src/agents/claude/move.js';
import type { ClaudeSessionRecord } from '../../src/agents/claude/session-records.js';
import type { ProcessInfo } from '../../src/agents/claude/process-probe.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const START = 'Sat Oct 18 10:00:00 2026';
const record: VerifiedRecord = {
  sessionId: SESSION,
  cwd: '/project',
  pid: 4242,
  version: '2.1.302',
  status: 'idle',
  entrypoint: 'cli',
  procStart: START,
  pidDomain: 'darwin',
};
const live: ProcessInfo = {
  pid: 4242,
  ppid: 1,
  uid: 501,
  startedAt: START,
  command: '/Users/x/.local/share/claude/versions/2.1.302',
};
const noGloss: GlossLaunches = { owners: [], panePids: [] };

it('is ready only when idle; a dialog or approval is busy with its own reason', () => {
  expect(moveReadiness({ status: 'idle' })).toEqual({ kind: 'ready' });
  expect(moveReadiness({ status: 'busy' })).toEqual({ kind: 'busy', reason: MOVE_WORKING_REASON });
  // The first record after `--resume` has no status yet: never movable.
  expect(moveReadiness({})).toEqual({ kind: 'busy', reason: MOVE_WORKING_REASON });
  expect(moveReadiness({ status: 'idle', waitingFor: 'dialog open' })).toEqual({
    kind: 'busy',
    reason: MOVE_DIALOG_REASON,
  });
  expect(moveReadiness({ status: 'waiting' })).toEqual({
    kind: 'busy',
    reason: MOVE_DIALOG_REASON,
  });
  expect(moveReadiness({ status: 'approval-required' })).toEqual({
    kind: 'busy',
    reason: MOVE_DIALOG_REASON,
  });
  // Claude Desktop is never movable, even when idle.
  expect(moveReadiness({ status: 'idle', entrypoint: 'claude-desktop' })).toEqual({
    kind: 'busy',
    reason: MOVE_DESKTOP_REASON,
  });
  expect(MOVE_WORKING_REASON).toBe('Claude is working; it can be moved when it finishes');
  expect(MOVE_NOT_CLOSED_REASON).toBe(
    "The session wasn't closed; close it in the terminal and press again",
  );
});

it('accepts only the live process with the record’s pid, uid, start time and a Claude executable', () => {
  expect(isSessionProcess(record, live, 501)).toBe(true);
  expect(isSessionProcess(record, { ...live, command: 'claude' }, 501)).toBe(true);
  expect(isSessionProcess(record, { ...live, command: '/opt/npm/bin/claude.exe' }, 501)).toBe(true);
  expect(isSessionProcess(record, undefined, 501)).toBe(false);
  expect(isSessionProcess(record, live, undefined)).toBe(false);
  expect(isSessionProcess(record, { ...live, startedAt: 'Sat Oct 18 11:00:00 2026' }, 501)).toBe(
    false,
  );
  expect(isSessionProcess(record, { ...live, uid: 0 }, 501)).toBe(false);
  expect(isSessionProcess(record, { ...live, pid: 4243 }, 501)).toBe(false);
  expect(isSessionProcess(record, { ...live, command: '/bin/zsh' }, 501)).toBe(false);
  expect(isSessionProcess({ ...record, procStart: undefined }, live, 501)).toBe(false);
  // A start time from another process table cannot tell a reused pid apart.
  expect(isSessionProcess({ ...record, pidDomain: undefined }, live, 501)).toBe(false);
  expect(isSessionProcess({ ...record, pidDomain: 'linux' }, live, 501)).toBe(false);
});

it('requires the same pid, start time, session and idle on the re-read', () => {
  expect(sameIdleProcess(record, { ...record })).toBe(true);
  expect(sameIdleProcess(record, undefined)).toBe(false);
  expect(sameIdleProcess(record, { ...record, procStart: 'Sat Oct 18 11:00:00 2026' })).toBe(false);
  expect(sameIdleProcess(record, { ...record, pidDomain: undefined })).toBe(false);
  expect(sameIdleProcess(record, { ...record, pid: 4243 })).toBe(false);
  expect(
    sameIdleProcess(record, { ...record, sessionId: '22222222-2222-4222-8222-222222222222' }),
  ).toBe(false);
  expect(sameIdleProcess(record, { ...record, status: 'busy' })).toBe(false);
  expect(sameIdleProcess(record, { ...record, status: undefined })).toBe(false);
  expect(sameIdleProcess(record, { ...record, waitingFor: 'dialog open' })).toBe(false);
});

/** `ps` for the record's pid: the Claude process running it now. */
const running = (r: ClaudeSessionRecord): ProcessInfo => ({ ...live, pid: r.pid });
const pick = (matches: readonly MoveMatch[], gloss: GlossLaunches = noGloss) =>
  pickMoveCandidate(matches, 501, gloss);

it('picks exactly one live terminal process, never a Desktop session, never an unverifiable one', () => {
  const other: ClaudeSessionRecord = { ...record, pid: 5000 };
  const unverified: ClaudeSessionRecord = { ...other, pidDomain: undefined };
  const mine = { record, process: running(record) };
  expect(pick([mine])).toEqual({ kind: 'found', record });
  expect(pick([mine, { record: other, process: undefined }])).toEqual({ kind: 'found', record });
  // A reused pid: Claude runs there, but it started after the record's process.
  expect(
    pick([
      mine,
      { record: other, process: { ...running(other), startedAt: 'Sat Oct 18 11:00:00 2026' } },
    ]),
  ).toEqual({ kind: 'found', record });
  // Another user's process, or no uid known, is not this session's.
  expect(pick([mine, { record: other, process: { ...running(other), uid: 0 } }])).toEqual({
    kind: 'found',
    record,
  });
  expect(pickMoveCandidate([mine], undefined, noGloss)).toEqual({
    kind: 'blocked',
    reason: MOVE_NOT_RUNNING_REASON,
  });
  const desktop = { ...record, entrypoint: 'claude-desktop' };
  expect(pick([{ record: desktop, process: running(desktop) }])).toEqual({
    kind: 'blocked',
    reason: MOVE_DESKTOP_REASON,
  });
  // A Desktop record beside a live terminal one blocks the whole session.
  expect(pick([mine, { record: { ...desktop, pid: 6000 }, process: undefined }])).toEqual({
    kind: 'blocked',
    reason: MOVE_DESKTOP_REASON,
  });
  const sdk = { ...record, entrypoint: 'sdk-ts' };
  expect(pick([{ record: sdk, process: running(sdk) }])).toEqual({
    kind: 'blocked',
    reason: MOVE_NOT_RUNNING_REASON,
  });
  expect(pick([mine, { record: other, process: running(other) }])).toEqual({
    kind: 'blocked',
    reason: MOVE_AMBIGUOUS_REASON,
  });
  // A live process Gloss can't verify still writes to the session: closing the other one is not a move.
  expect(pick([mine, { record: unverified, process: running(unverified) }])).toEqual({
    kind: 'blocked',
    reason: MOVE_AMBIGUOUS_REASON,
  });
  expect(pick([{ record: unverified, process: running(unverified) }])).toEqual({
    kind: 'blocked',
    reason: MOVE_UNVERIFIED_REASON,
  });
  // A dead record without a start time is just gone.
  expect(pick([{ record: { ...record, procStart: undefined }, process: undefined }])).toEqual({
    kind: 'blocked',
    reason: MOVE_NOT_RUNNING_REASON,
  });
  expect(pick([])).toEqual({ kind: 'blocked', reason: MOVE_NOT_RUNNING_REASON });
});

it('never picks a session a Gloss launch owns, nor a process of a Gloss pane', () => {
  const matches = [{ record, process: running(record) }];
  const inGloss = { kind: 'blocked', reason: MOVE_IN_GLOSS_REASON };
  // Two live launches own the session (ambiguous to claudeLaunchFor): still Gloss's.
  const twoLive: GlossLaunches = {
    owners: [
      { state: 'running', paneAlive: true },
      { state: 'unidentified', paneAlive: true },
    ],
    panePids: [7000, 7001],
  };
  expect(pick(matches, twoLive)).toEqual(inGloss);
  // A launch still starting owns it too.
  expect(
    pick(matches, { owners: [{ state: 'starting', paneAlive: false }], panePids: [] }),
  ).toEqual(inGloss);
  // A launch marked ended whose pane still runs.
  const endedAlive: GlossLaunches = {
    owners: [{ state: 'ended', paneAlive: true }],
    panePids: [7000],
  };
  expect(pick(matches, endedAlive)).toEqual(inGloss);
  // A Gloss-launched pane runs this very process, whatever the launch says it owns.
  const ownPane: GlossLaunches = { owners: [], panePids: [7000, record.pid] };
  expect(pick(matches, ownPane)).toEqual(inGloss);
  expect(glossHoldsSession(running(record), ownPane)).toBe(true);
  // A Claude typed by hand into a Gloss shell pane: its parent is the pane.
  const shellPane: GlossLaunches = { owners: [], panePids: [7000] };
  const typed = [{ record, process: { ...running(record), ppid: 7000 } }];
  expect(pick(typed, shellPane)).toEqual(inGloss);
  expect(glossHoldsSession({ pid: record.pid, ppid: 7000 }, shellPane)).toBe(true);
  // An ended launch whose pane is gone, with a pane pid of its own, does not hold the session.
  const endedGone: GlossLaunches = {
    owners: [{ state: 'ended', paneAlive: false }],
    panePids: [7000],
  };
  expect(glossHoldsSession(running(record), endedGone)).toBe(false);
  expect(pick(matches, endedGone)).toEqual({ kind: 'found', record });
  // An ended launch whose recorded pane pid is the record's pid: never signal it.
  const endedSamePid: GlossLaunches = {
    owners: [{ state: 'ended', paneAlive: false }],
    panePids: [record.pid],
  };
  expect(glossHoldsSession(running(record), endedSamePid)).toBe(true);
  expect(pick(matches, endedSamePid)).toEqual(inGloss);
});

it('shows the manual resume command with the folder quoted', () => {
  expect(manualResume(SESSION, "/Users/me/it's")).toEqual({
    command: `claude --resume ${SESSION}`,
    cdCommand: `cd '/Users/me/it'"'"'s' && claude --resume ${SESSION}`,
  });
});
