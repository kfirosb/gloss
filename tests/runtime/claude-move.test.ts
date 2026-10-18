import { afterEach, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Target } from '../../src/core/contracts.js';
import type { ProcessInfo } from '../../src/agents/claude/process-probe.js';
import {
  MOVE_ALREADY_MOVING_REASON,
  MOVE_ALREADY_WAITING_REASON,
  MOVE_CHANGED_REASON,
  MOVE_DESKTOP_REASON,
  MOVE_DIALOG_REASON,
  MOVE_IN_GLOSS_REASON,
  MOVE_NOT_CLOSED_REASON,
  MOVE_NOT_RUNNING_REASON,
  MOVE_RESUME_EXITED_REASON,
  MOVE_RESUME_OTHER_REASON,
  MOVE_RESUME_STILL_OPEN_REASON,
  MOVE_RESUME_UNCONFIRMED_REASON,
  MOVE_UNVERIFIED_REASON,
  MOVE_WAIT_ENDED_REASON,
  MOVE_WORKING_REASON,
} from '../../src/agents/claude/move.js';
import {
  MOVE_CLOSE_TIMEOUT_MS,
  MOVE_RESUME_CHECK_MS,
  MOVE_WAIT_POLL_MS,
  MOVE_WAIT_UNREADABLE_POLLS,
  createClaudeMove,
  parseMoveRequest,
  type ClaudeMoveOptions,
  type ClaudeMoveService,
} from '../../src/runtime/claude-move.js';
import type { LaunchRecord, PreparedResume } from '../../src/runtime/session-launcher.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const START = 'Sat Oct 18 10:00:00 2026';
const LATER = 'Sat Oct 18 11:00:00 2026';
const PANE_START = 'Sat Oct 18 12:00:00 2026';
const CLAUDE = '/Users/x/.local/share/claude/versions/2.1.302';
/** The outside Claude's pid, the pid of the pane Gloss reopens it in, and that tmux server's pid. */
const OUTSIDE_PID = 100;
const PANE_PID = 900;
const TMUX_PID = 800;
const dirs: string[] = [];
const services: ClaudeMoveService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const claudeAt = (pid: number, startedAt: string, ppid = 1): ProcessInfo => ({
  pid,
  ppid,
  uid: 501,
  startedAt,
  command: CLAUDE,
});
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

async function setup(
  options: {
    record?: Record<string, unknown>;
    onTerm?: 'exit' | 'ignore' | 'keep-record';
    prepare?: 'throws';
    resume?:
      | 'ok'
      | 'throws'
      | 'pane-closes'
      | 'other-session'
      | 'stale-record'
      | 'no-domain'
      | 'record-later';
    endFails?: boolean;
    /** tmux never answers: the pane check or End never settles. */
    paneHangs?: boolean;
    endHangs?: boolean;
    /** `kill` fails with this code after it is logged; ESRCH means the process was already gone. */
    termThrows?: 'ESRCH' | 'EPERM';
    launches?: LaunchRecord[];
    alivePanes?: string[];
    outsideParent?: number;
  } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-move-')));
  dirs.push(root);
  const config = join(root, '.claude');
  const project = join(root, 'project');
  const link = join(root, 'link');
  await mkdir(join(config, 'sessions'), { recursive: true });
  await mkdir(project);
  // The target names the project through a symlink; the move must use the record's own folder.
  await symlink(project, link);
  const recordPath = (pid: number) => join(config, 'sessions', `${pid}.json`);
  // Written whole and renamed into place, so a poll never reads a half-written record.
  const write = async (pid: number, fields: Record<string, unknown> = {}) => {
    const partial = `${recordPath(pid)}.partial`;
    await writeFile(
      partial,
      JSON.stringify({
        sessionId: SESSION,
        cwd: project,
        pid,
        version: '2.1.302',
        procStart: START,
        pidDomain: 'darwin',
        status: 'idle',
        entrypoint: 'cli',
        ...fields,
      }),
    );
    await rename(partial, recordPath(pid));
  };
  await write(OUTSIDE_PID, options.record);
  const live = new Map<number, ProcessInfo>([
    [OUTSIDE_PID, claudeAt(OUTSIDE_PID, START, options.outsideParent)],
  ]);
  let clock = 0;
  /** Every call that crosses the service's boundary, in order. */
  const events: string[] = [];
  const signals: [number, string][] = [];
  const signalledAt: number[] = [];
  const prepares: { sessionRef: string; folder: string }[] = [];
  const resumes: { sessionRef: string; folder: string }[] = [];
  const ends: string[] = [];
  const logs: string[] = [];
  const launches: LaunchRecord[] = [...(options.launches ?? [])];
  const alivePanes = new Set(options.alivePanes ?? []);
  const hooks: {
    onPrepare?: () => void | Promise<void>;
    /** Runs before each injected sleep resolves; `ms` tells which loop is sleeping. */
    onSleep?: (ms: number) => void | Promise<void>;
    onProbe?: (pid: number) => void;
  } = {};
  const never = new Promise<never>(() => {});
  const launch: LaunchRecord = {
    id: 'L',
    agent: 'claude',
    folder: project,
    panePid: PANE_PID,
    sessionRef: SESSION,
    state: 'running',
    createdAt: 1,
  };
  const launcher: ClaudeMoveOptions['launcher'] = {
    list: () => launches.map((l) => ({ ...l })),
    async prepareResume(input) {
      events.push('prepare');
      prepares.push(input);
      await hooks.onPrepare?.();
      if (options.prepare === 'throws') throw new Error('Choose a project folder');
      const prepared: PreparedResume = Object.freeze({
        sessionRef: input.sessionRef,
        cwd: input.folder,
        argv: Object.freeze(['/bin/claude', '--resume', input.sessionRef]),
      });
      return prepared;
    },
    async resume(prepared) {
      events.push('resume');
      resumes.push({ sessionRef: prepared.sessionRef, folder: prepared.cwd });
      if (options.resume === 'throws') throw new Error('tmux command failed');
      launches.push(launch);
      alivePanes.add(launch.id);
      const pane = claudeAt(PANE_PID, PANE_START, TMUX_PID);
      if (options.resume === 'pane-closes') alivePanes.delete(launch.id);
      else if (options.resume === 'other-session') {
        live.set(PANE_PID, pane);
        // Without pidDomain or procStart: Gloss launched this pane, so its record is trusted anyway.
        await write(PANE_PID, {
          sessionId: OTHER,
          procStart: undefined,
          pidDomain: undefined,
          status: undefined,
        });
      } else if (options.resume === 'stale-record') {
        // A record an earlier process left at this pid: its start time is not the pane's.
        live.set(PANE_PID, pane);
        await write(PANE_PID, { sessionId: OTHER, procStart: LATER });
      } else if (options.resume === 'no-domain') {
        live.set(PANE_PID, pane);
        await write(PANE_PID, { procStart: undefined, pidDomain: undefined, status: undefined });
      } else if (options.resume === 'record-later') {
        // The pane runs, and its record is written when the test says so.
        live.set(PANE_PID, pane);
      } else {
        live.set(PANE_PID, pane);
        // Task 1: the first record after `--resume` carries no status yet.
        await write(PANE_PID, { procStart: PANE_START, status: undefined });
      }
      return { ...launch };
    },
    async end(launchId) {
      events.push('end');
      ends.push(launchId);
      if (options.endFails) throw new Error('Session is still running');
      if (options.endHangs) await never;
      const ended = launches.find((l) => l.id === launchId);
      if (ended) ended.state = 'ended';
      alivePanes.delete(launchId);
      live.delete(PANE_PID);
    },
  };
  const service = createClaudeMove({
    configDir: config,
    uid: 501,
    launcher,
    panels: () => [],
    paneAlive: async (launchId) => (options.paneHangs ? never : alivePanes.has(launchId)),
    probe: async (pid) => {
      hooks.onProbe?.(pid);
      return live.get(pid);
    },
    processExists: (pid) => live.has(pid),
    terminate: (pid, signal) => {
      events.push(signal);
      signals.push([pid, signal]);
      signalledAt.push(clock);
      if (options.termThrows === 'EPERM')
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      if (options.onTerm === 'ignore') return;
      live.delete(pid);
      if (options.onTerm !== 'keep-record') rmSync(recordPath(pid), { force: true });
      if (options.termThrows === 'ESRCH')
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    },
    now: () => clock,
    // A bounded wait that its work beat is aborted, and then no time passes.
    sleep: async (ms, signal) => {
      await hooks.onSleep?.(ms);
      await tick();
      if (!signal?.aborted) clock += ms;
    },
    log: (message) => logs.push(message),
  });
  services.push(service);
  const target: Target = { agent: 'claude', sessionRef: SESSION, projectId: link };
  const expected = { pid: OUTSIDE_PID, procStart: START };
  return {
    service,
    target,
    expected,
    events,
    signals,
    signalledAt,
    prepares,
    resumes,
    ends,
    logs,
    hooks,
    launches,
    recordDir: join(config, 'sessions'),
    write,
    live,
    project,
    now: () => clock,
  };
}
const manual = (folder: string) => ({
  command: `claude --resume ${SESSION}`,
  cdCommand: `cd '${folder}' && claude --resume ${SESSION}`,
});

it('moves an idle outside session: prepare, one SIGTERM, then resume in the record folder; it then runs in Gloss', async () => {
  const f = await setup();
  expect(await f.service.status(f.target)).toEqual({ state: 'ready', process: f.expected });
  expect(await f.service.act(f.target, { action: 'move', expected: f.expected })).toEqual({
    state: 'in-gloss',
  });
  expect(f.signals).toEqual([[OUTSIDE_PID, 'SIGTERM']]);
  // The reopen is checked before anything is closed, and started only after the process is gone.
  expect(f.events).toEqual(['prepare', 'SIGTERM', 'resume']);
  expect(f.prepares).toEqual([{ sessionRef: SESSION, folder: f.project }]);
  expect(f.resumes).toEqual([{ sessionRef: SESSION, folder: f.project }]);
  // The resumed record has no status yet (Task 1); the same session with a live Claude is a good reopen.
  for (let i = 0; i < 20; i++) await tick();
  expect(f.ends).toEqual([]);
  expect(await f.service.status(f.target)).toEqual({ state: 'in-gloss' });
  expect(f.logs).toEqual([]);
});

it('does not close a working session or one with a dialog open', async () => {
  for (const [record, reason] of [
    [{ status: 'busy' }, MOVE_WORKING_REASON],
    [{ status: 'idle', waitingFor: 'dialog open' }, MOVE_DIALOG_REASON],
  ] as const) {
    const f = await setup({ record });
    const busy = { state: 'busy', reason, process: f.expected };
    expect(await f.service.status(f.target)).toEqual(busy);
    expect(await f.service.act(f.target, { action: 'move', expected: f.expected })).toEqual(busy);
    expect(f.signals).toEqual([]);
    expect(f.prepares).toEqual([]);
  }
});

it('a restarted session is never signalled: the confirmed identity must still match', async () => {
  const f = await setup();
  await f.write(OUTSIDE_PID, { procStart: LATER });
  f.live.set(OUTSIDE_PID, claudeAt(OUTSIDE_PID, LATER));
  expect(await f.service.act(f.target, { action: 'move', expected: f.expected })).toMatchObject({
    state: 'ready',
    failure: { reason: MOVE_CHANGED_REASON },
  });
  expect(f.signals).toEqual([]);
});

it('re-checks the process right before SIGTERM: a session that turned busy or restarted is not signalled', async () => {
  const busy = await setup();
  busy.hooks.onPrepare = () => busy.write(OUTSIDE_PID, { status: 'busy' });
  expect(
    (await busy.service.act(busy.target, { action: 'move', expected: busy.expected })).failure,
  ).toEqual({ reason: MOVE_CHANGED_REASON });
  const restarted = await setup();
  restarted.hooks.onPrepare = () => {
    restarted.live.set(OUTSIDE_PID, claudeAt(OUTSIDE_PID, LATER));
  };
  expect(
    (
      await restarted.service.act(restarted.target, {
        action: 'move',
        expected: restarted.expected,
      })
    ).failure,
  ).toEqual({ reason: MOVE_NOT_RUNNING_REASON });
  expect([...busy.signals, ...restarted.signals]).toEqual([]);
  expect([...busy.resumes, ...restarted.resumes]).toEqual([]);
});

it('a reused pid is not live, and a record without a trusted procStart is not movable', async () => {
  const reused = await setup();
  reused.live.set(OUTSIDE_PID, claudeAt(OUTSIDE_PID, LATER));
  expect(await reused.service.status(reused.target)).toEqual({
    state: 'unavailable',
    reason: MOVE_NOT_RUNNING_REASON,
  });
  const unverified = await setup({ record: { procStart: undefined } });
  expect(await unverified.service.status(unverified.target)).toEqual({
    state: 'unavailable',
    reason: MOVE_UNVERIFIED_REASON,
  });
  const otherDomain = await setup({ record: { pidDomain: 'linux' } });
  expect(await otherDomain.service.status(otherDomain.target)).toEqual({
    state: 'unavailable',
    reason: MOVE_UNVERIFIED_REASON,
  });
  for (const f of [reused, unverified, otherDomain])
    await f.service.act(f.target, { action: 'move', expected: f.expected });
  expect([...reused.signals, ...unverified.signals, ...otherDomain.signals]).toEqual([]);
});

it('never moves a Claude Desktop session', async () => {
  const f = await setup({ record: { entrypoint: 'claude-desktop' } });
  expect(await f.service.status(f.target)).toEqual({
    state: 'unavailable',
    reason: MOVE_DESKTOP_REASON,
  });
  await f.service.act(f.target, { action: 'move', expected: f.expected });
  expect(f.signals).toEqual([]);
});

it('never signals a process of Gloss: an owning launch, its ended launch with a live pane, a pane or a pane child', async () => {
  const owned = (state: LaunchRecord['state']): LaunchRecord => ({
    id: 'G',
    agent: 'claude',
    folder: '/elsewhere',
    panePid: 555,
    sessionRef: SESSION,
    state,
    createdAt: 1,
  });
  const shell = (panePid: number): LaunchRecord => ({
    id: 'S',
    agent: 'shell',
    folder: '/elsewhere',
    panePid,
    state: 'ended',
    createdAt: 1,
  });
  const running = await setup({ launches: [owned('running')] });
  expect(await running.service.status(running.target)).toEqual({ state: 'in-gloss' });
  const adoptable = await setup({ launches: [owned('ended')], alivePanes: ['G'] });
  expect(await adoptable.service.status(adoptable.target)).toEqual({ state: 'in-gloss' });
  const pane = await setup({ launches: [shell(OUTSIDE_PID)] });
  expect(await pane.service.status(pane.target)).toEqual({
    state: 'unavailable',
    reason: MOVE_IN_GLOSS_REASON,
  });
  const child = await setup({ launches: [shell(700)], outsideParent: 700 });
  expect(await child.service.status(child.target)).toEqual({
    state: 'unavailable',
    reason: MOVE_IN_GLOSS_REASON,
  });
  const all = [running, adoptable, pane, child];
  for (const f of all) await f.service.act(f.target, { action: 'move', expected: f.expected });
  expect(all.flatMap((f) => f.signals)).toEqual([]);
  expect(all.flatMap((f) => f.prepares)).toEqual([]);
});

it('re-checks Gloss ownership right before SIGTERM: a launch adopted meanwhile blocks the signal', async () => {
  const f = await setup({ alivePanes: ['G'] });
  f.hooks.onPrepare = () => {
    f.launches.push({
      id: 'G',
      agent: 'claude',
      folder: f.project,
      panePid: 555,
      sessionRef: SESSION,
      state: 'ended',
      createdAt: 1,
    });
  };
  const after = await f.service.act(f.target, { action: 'move', expected: f.expected });
  expect(after).toEqual({ state: 'in-gloss', failure: { reason: MOVE_IN_GLOSS_REASON } });
  expect(f.signals).toEqual([]);
  expect(f.resumes).toEqual([]);
});

it('closes nothing when the reopen cannot be prepared, and shows the error', async () => {
  const f = await setup({ prepare: 'throws' });
  expect(await f.service.act(f.target, { action: 'move', expected: f.expected })).toEqual({
    state: 'ready',
    process: f.expected,
    // The session still runs in its terminal, so no manual resume command is offered.
    failure: { reason: 'Choose a project folder' },
  });
  expect(f.signals).toEqual([]);
  expect(f.resumes).toEqual([]);
});

it('gives up after the close timeout when Claude ignores SIGTERM; nothing else changes', async () => {
  const f = await setup({ onTerm: 'ignore' });
  const after = await f.service.act(f.target, { action: 'move', expected: f.expected });
  expect(after.failure).toEqual({ reason: MOVE_NOT_CLOSED_REASON });
  // Exactly one signal, and it was SIGTERM: Gloss never escalates and never retries.
  expect(f.signals).toEqual([[OUTSIDE_PID, 'SIGTERM']]);
  expect(f.now() - (f.signalledAt[0] ?? 0)).toBeGreaterThanOrEqual(MOVE_CLOSE_TIMEOUT_MS);
  expect(f.resumes).toEqual([]);
});

it('a Claude that exits but leaves its record behind has closed: the move goes on, the record is logged', async () => {
  const f = await setup({ onTerm: 'keep-record' });
  expect(await f.service.act(f.target, { action: 'move', expected: f.expected })).toEqual({
    state: 'in-gloss',
  });
  expect(f.signals).toEqual([[OUTSIDE_PID, 'SIGTERM']]);
  expect(f.resumes).toEqual([{ sessionRef: SESSION, folder: f.project }]);
  expect(f.logs).toEqual([expect.stringContaining('left its session record')]);
});

it('shows the error and the manual command when the session cannot be reopened', async () => {
  const thrown = await setup({ resume: 'throws' });
  expect(
    (await thrown.service.act(thrown.target, { action: 'move', expected: thrown.expected }))
      .failure,
  ).toEqual({ reason: 'tmux command failed', manual: manual(thrown.project) });
  expect(thrown.signals).toEqual([[OUTSIDE_PID, 'SIGTERM']]);
  expect(thrown.ends).toEqual([]);
});

it('ends a reopened launch that exits at once or opens another session, through the launcher, and shows the manual command', async () => {
  for (const [resume, reason] of [
    ['pane-closes', MOVE_RESUME_EXITED_REASON],
    ['other-session', MOVE_RESUME_OTHER_REASON],
  ] as const) {
    const f = await setup({ resume });
    await f.service.act(f.target, { action: 'move', expected: f.expected });
    await vi.waitFor(async () =>
      expect((await f.service.status(f.target)).failure).toEqual({
        reason,
        manual: manual(f.project),
      }),
    );
    await vi.waitFor(() => expect(f.ends).toEqual(['L']));
    expect(f.signals).toEqual([[OUTSIDE_PID, 'SIGTERM']]);
    expect(f.resumes).toHaveLength(1);
  }
});

it('a reopened pane whose record has no pidDomain or procStart counts as reopened', async () => {
  const f = await setup({ resume: 'no-domain' });
  expect(await f.service.act(f.target, { action: 'move', expected: f.expected })).toEqual({
    state: 'in-gloss',
  });
  // The check ends at the first read; a later press is no longer refused as in flight.
  await vi.waitFor(async () =>
    expect(await f.service.act(f.target, { action: 'move', expected: f.expected })).toEqual({
      state: 'in-gloss',
    }),
  );
  expect(f.ends).toEqual([]);
  expect(f.signals).toEqual([[OUTSIDE_PID, 'SIGTERM']]);
});

it('the move stays in flight until the reopen check resolves: a press meanwhile is refused', async () => {
  const f = await setup({ resume: 'record-later' });
  expect(await f.service.act(f.target, { action: 'move', expected: f.expected })).toEqual({
    state: 'in-gloss',
  });
  await vi.waitFor(() => expect(f.now()).toBeGreaterThan(0));
  expect(await f.service.act(f.target, { action: 'move', expected: f.expected })).toEqual({
    state: 'in-gloss',
    failure: { reason: MOVE_ALREADY_MOVING_REASON },
  });
  await f.write(PANE_PID, { procStart: PANE_START, status: undefined });
  await vi.waitFor(async () =>
    expect(await f.service.act(f.target, { action: 'move', expected: f.expected })).toEqual({
      state: 'in-gloss',
    }),
  );
  expect(f.signals).toEqual([[OUTSIDE_PID, 'SIGTERM']]);
  expect(f.prepares).toHaveLength(1);
  expect(f.resumes).toHaveLength(1);
  expect(f.ends).toEqual([]);
});

it('when ending a wrong reopen fails, the failure says its terminal is still open, and the error is logged', async () => {
  const f = await setup({ resume: 'other-session', endFails: true });
  await f.service.act(f.target, { action: 'move', expected: f.expected });
  await vi.waitFor(() =>
    expect(f.logs).toEqual([expect.stringContaining('Session is still running')]),
  );
  expect((await f.service.status(f.target)).failure).toEqual({
    reason: `${MOVE_RESUME_OTHER_REASON} ${MOVE_RESUME_STILL_OPEN_REASON}`,
    manual: manual(f.project),
  });
  expect(f.ends).toEqual(['L']);
  expect(f.signals).toEqual([[OUTSIDE_PID, 'SIGTERM']]);
});

it('a stale record at the pane pid from an earlier process is not taken for another session', async () => {
  const f = await setup({ resume: 'stale-record' });
  await f.service.act(f.target, { action: 'move', expected: f.expected });
  const resumedAt = f.now();
  await vi.waitFor(() => expect(f.now()).toBeGreaterThanOrEqual(resumedAt + MOVE_RESUME_CHECK_MS));
  for (let i = 0; i < 5; i++) await tick();
  expect(f.ends).toEqual([]);
  expect(f.signals).toEqual([[OUTSIDE_PID, 'SIGTERM']]);
  expect(await f.service.status(f.target)).toEqual({ state: 'in-gloss' });
});

it('Gloss quitting during the last re-read before SIGTERM sends nothing', async () => {
  const f = await setup();
  let armed = false;
  let probes = 0;
  f.hooks.onPrepare = () => {
    armed = true;
  };
  // After prepare: the candidate's ps, then the pid's own ps; the record re-read follows the second.
  f.hooks.onProbe = () => {
    if (armed && ++probes === 2) f.service.close();
  };
  await f.service.act(f.target, { action: 'move', expected: f.expected });
  // Closed at the second probe; the status the press returns probes once more.
  expect(probes).toBe(3);
  expect(f.signals).toEqual([]);
  expect(f.resumes).toEqual([]);
});

it('a tmux that never answers during the reopen check ends the move as failed; a later press is accepted', async () => {
  for (const variant of [
    { resume: 'record-later', paneHangs: true },
    { resume: 'other-session', endHangs: true },
  ] as const) {
    const f = await setup(variant);
    await f.service.act(f.target, { action: 'move', expected: f.expected });
    await vi.waitFor(async () =>
      expect((await f.service.status(f.target)).failure).toEqual(
        variant.resume === 'record-later'
          ? { reason: MOVE_RESUME_UNCONFIRMED_REASON }
          : {
              reason: `${MOVE_RESUME_OTHER_REASON} ${MOVE_RESUME_STILL_OPEN_REASON}`,
              manual: manual(f.project),
            },
      ),
    );
    // No longer in flight: the press is answered, not refused as already moving.
    await vi.waitFor(async () =>
      expect(
        (await f.service.act(f.target, { action: 'move', expected: f.expected })).failure?.reason,
      ).not.toBe(MOVE_ALREADY_MOVING_REASON),
    );
    expect(f.signals).toEqual([[OUTSIDE_PID, 'SIGTERM']]);
    expect(f.resumes).toHaveLength(1);
  }
});

it('a kill that finds the process already gone (ESRCH) goes on to reopen', async () => {
  const f = await setup({ termThrows: 'ESRCH' });
  expect(await f.service.act(f.target, { action: 'move', expected: f.expected })).toEqual({
    state: 'in-gloss',
  });
  expect(f.signals).toEqual([[OUTSIDE_PID, 'SIGTERM']]);
  expect(f.resumes).toHaveLength(1);
});

it('a kill refused for another reason (EPERM) closes nothing and reopens nothing', async () => {
  const f = await setup({ termThrows: 'EPERM' });
  expect((await f.service.act(f.target, { action: 'move', expected: f.expected })).failure).toEqual(
    { reason: MOVE_NOT_CLOSED_REASON },
  );
  expect(f.signals).toEqual([[OUTSIDE_PID, 'SIGTERM']]);
  expect(f.resumes).toEqual([]);
});

it('"Move when it finishes" waits for idle, then moves once', async () => {
  const f = await setup({ record: { status: 'busy' } });
  expect(await f.service.act(f.target, { action: 'when-idle', expected: f.expected })).toEqual({
    state: 'waiting',
  });
  await vi.waitFor(() => expect(f.now()).toBeGreaterThanOrEqual(3 * MOVE_WAIT_POLL_MS));
  expect(f.signals).toEqual([]);
  await f.write(OUTSIDE_PID, { status: 'idle' });
  await vi.waitFor(() => expect(f.resumes).toHaveLength(1));
  expect(f.signals).toEqual([[OUTSIDE_PID, 'SIGTERM']]);
  expect(await f.service.status(f.target)).toEqual({ state: 'in-gloss' });
});

it('one move per session: a Move while waiting or moving is refused, and Cancel ends the wait', async () => {
  const f = await setup({ record: { status: 'busy' } });
  await f.service.act(f.target, { action: 'when-idle', expected: f.expected });
  for (const action of ['move', 'when-idle'] as const)
    expect(await f.service.act(f.target, { action, expected: f.expected })).toEqual({
      state: 'waiting',
      failure: { reason: MOVE_ALREADY_WAITING_REASON },
    });
  expect(await f.service.act(f.target, { action: 'cancel' })).toMatchObject({ state: 'busy' });
  await f.write(OUTSIDE_PID, { status: 'idle' });
  // A cancelled wait polls no more, so its clock stops; real ticks give it the chance to misbehave.
  for (let i = 0; i < 20; i++) await tick();
  expect(f.signals).toEqual([]);
  // After Cancel a new Move runs normally.
  expect(await f.service.act(f.target, { action: 'move', expected: f.expected })).toEqual({
    state: 'in-gloss',
  });
  expect(f.signals).toEqual([[OUTSIDE_PID, 'SIGTERM']]);
});

it('a wait that turns idle while a Move is already running does not move again', async () => {
  const f = await setup({ record: { status: 'busy' } });
  await f.service.act(f.target, { action: 'when-idle', expected: f.expected });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.hooks.onPrepare = () => held;
  await f.write(OUTSIDE_PID, { status: 'idle' });
  await vi.waitFor(() => expect(f.prepares).toHaveLength(1));
  // The wait became the move; a second press is refused while it runs.
  expect(await f.service.act(f.target, { action: 'move', expected: f.expected })).toEqual({
    state: 'moving',
    failure: { reason: MOVE_ALREADY_MOVING_REASON },
  });
  release();
  await vi.waitFor(() => expect(f.resumes).toHaveLength(1));
  expect(f.signals).toEqual([[OUTSIDE_PID, 'SIGTERM']]);
  expect(f.prepares).toHaveLength(1);
});

it('"Move when it finishes" retries a record caught half-written while its process runs', async () => {
  const torn = await setup({ record: { status: 'busy' } });
  let waits = 0;
  torn.hooks.onSleep = async (ms) => {
    if (ms !== MOVE_WAIT_POLL_MS) return;
    waits++;
    // Unreadable for two polls, one fewer than the limit, then idle.
    if (waits === 1) await writeFile(join(torn.recordDir, `${OUTSIDE_PID}.json`), '{"sessionId":');
    if (waits === 3) await torn.write(OUTSIDE_PID, { status: 'idle' });
  };
  await torn.service.act(torn.target, { action: 'when-idle', expected: torn.expected });
  await vi.waitFor(() => expect(torn.resumes).toHaveLength(1));
  expect(torn.signals).toEqual([[OUTSIDE_PID, 'SIGTERM']]);

  const unreadable = await setup({ record: { status: 'busy' } });
  let polls = 0;
  unreadable.hooks.onSleep = async (ms) => {
    if (ms !== MOVE_WAIT_POLL_MS) return;
    if (++polls === 1)
      await writeFile(join(unreadable.recordDir, `${OUTSIDE_PID}.json`), 'not json');
  };
  await unreadable.service.act(unreadable.target, {
    action: 'when-idle',
    expected: unreadable.expected,
  });
  await vi.waitFor(async () =>
    expect((await unreadable.service.status(unreadable.target)).failure).toEqual({
      reason: MOVE_WAIT_ENDED_REASON,
    }),
  );
  expect(polls).toBe(MOVE_WAIT_UNREADABLE_POLLS);
  expect(unreadable.signals).toEqual([]);
});

it('"Move when it finishes" ends at once on a record for another session, or when the process is gone', async () => {
  const other = await setup({ record: { status: 'busy' } });
  let polls = 0;
  other.hooks.onSleep = async (ms) => {
    if (ms === MOVE_WAIT_POLL_MS && ++polls === 1)
      await other.write(OUTSIDE_PID, { sessionId: OTHER, status: 'idle' });
  };
  await other.service.act(other.target, { action: 'when-idle', expected: other.expected });
  await vi.waitFor(async () =>
    expect((await other.service.status(other.target)).failure).toEqual({
      reason: MOVE_WAIT_ENDED_REASON,
    }),
  );
  expect(polls).toBe(1);
  const gone = await setup({ record: { status: 'busy' } });
  await gone.service.act(gone.target, { action: 'when-idle', expected: gone.expected });
  // Its record stays behind (ruling I1); the process is what counts.
  gone.live.delete(OUTSIDE_PID);
  await vi.waitFor(async () =>
    expect((await gone.service.status(gone.target)).failure).toEqual({
      reason: MOVE_WAIT_ENDED_REASON,
    }),
  );
  expect([...other.signals, ...gone.signals]).toEqual([]);
});

it('"Move when it finishes" ends without signalling when the session restarts, is cancelled, or Gloss quits', async () => {
  const restarted = await setup({ record: { status: 'busy' } });
  await restarted.service.act(restarted.target, {
    action: 'when-idle',
    expected: restarted.expected,
  });
  await restarted.write(OUTSIDE_PID, { status: 'idle', procStart: LATER });
  restarted.live.set(OUTSIDE_PID, claudeAt(OUTSIDE_PID, LATER));
  await vi.waitFor(async () =>
    expect((await restarted.service.status(restarted.target)).failure).toEqual({
      reason: MOVE_WAIT_ENDED_REASON,
    }),
  );
  const cancelled = await setup({ record: { status: 'busy' } });
  await cancelled.service.act(cancelled.target, {
    action: 'when-idle',
    expected: cancelled.expected,
  });
  expect(await cancelled.service.act(cancelled.target, { action: 'cancel' })).toMatchObject({
    state: 'busy',
  });
  await cancelled.write(OUTSIDE_PID, { status: 'idle' });
  const quit = await setup({ record: { status: 'busy' } });
  await quit.service.act(quit.target, { action: 'when-idle', expected: quit.expected });
  quit.service.close();
  await quit.write(OUTSIDE_PID, { status: 'idle' });
  // Fixed waits only prove that nothing happened; the injected clock runs each poll in about a millisecond.
  for (let i = 0; i < 20; i++) await tick();
  expect([...restarted.signals, ...cancelled.signals, ...quit.signals]).toEqual([]);
  expect([...restarted.prepares, ...cancelled.prepares, ...quit.prepares]).toEqual([]);
});

it('two concurrent moves send one SIGTERM and start one launch', async () => {
  const f = await setup();
  const results = await Promise.all([
    f.service.act(f.target, { action: 'move', expected: f.expected }),
    f.service.act(f.target, { action: 'move', expected: f.expected }),
  ]);
  expect(f.signals).toEqual([[OUTSIDE_PID, 'SIGTERM']]);
  expect(f.prepares).toHaveLength(1);
  expect(f.resumes).toHaveLength(1);
  expect(results.map((r) => r.state).sort()).toEqual(['in-gloss', 'moving']);
});

it('parses only exact move requests', () => {
  expect(parseMoveRequest({ action: 'cancel' })).toEqual({ action: 'cancel' });
  expect(parseMoveRequest({ action: 'move', pid: 100, procStart: START })).toEqual({
    action: 'move',
    expected: { pid: 100, procStart: START },
  });
  expect(parseMoveRequest({ action: 'when-idle', pid: 100, procStart: START })).toEqual({
    action: 'when-idle',
    expected: { pid: 100, procStart: START },
  });
  for (const bad of [
    {},
    null,
    'move',
    { action: 'move' },
    { action: 'move', pid: 100, procStart: START, signal: 'SIGKILL' },
    { action: 'move', pid: -1, procStart: START },
    { action: 'move', pid: 0, procStart: START },
    { action: 'move', pid: 1, procStart: START },
    { action: 'move', pid: 1.5, procStart: START },
    { action: 'move', pid: '100', procStart: START },
    { action: 'when-idle', pid: 100, procStart: '' },
    { action: 'when-idle', pid: 100, procStart: 'x'.repeat(65) },
    { action: 'cancel', pid: 100 },
    { action: 'kill', pid: 100, procStart: START },
    ['move'],
  ])
    expect(() => parseMoveRequest(bad)).toThrow();
});
