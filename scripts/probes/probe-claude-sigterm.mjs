// Spike for Move to Gloss (docs/superpowers/plans/2026-10-18-move-to-gloss.md, Task 1): does an idle Claude exit on
// SIGTERM, does sessions/<pid>.json go away, is procStart present and equal to `ps -o lstart=` (UTC, C locale), and
// does `claude --resume <id>` work right after and keep the history? Throwaway sessions only: a fake HOME under
// /private/var, a private tmux server inside it, a scratch project, Haiku, --permission-mode default, no MCP servers.
// ONE model turn in total, sent last so every turn-free step has already worked. It signals only processes it
// started: the pane's own pid, checked against the session record, the argv and the cwd before every signal.
// It reads ~/.claude.json (copied into the fake home) and links ~/Library/Keychains for the login; it never writes to
// the real home. Usage: node scripts/probes/probe-claude-sigterm.mjs <claude version> <fake home under /private/var>
// [--stopped-only]. --stopped-only runs just the turn-free stopped-process checks: tmux continues a stopped pane
// process at once, so a held SIGTERM is checked on a Claude that runs as a child of the pane's shell as well.
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, readdir, realpath, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const MESSAGE = 'Reply with the single word OK.';
/** Longer than Gloss's 10 s close budget, so a slow exit is measured instead of cut off. */
const EXIT_WAIT_MS = 15_000;
/** How long a stopped Claude is watched with a SIGTERM pending before SIGCONT. */
const STOPPED_WATCH_MS = 3_000;

const execFileAsync = promisify(execFile);
const [version, homeArgument, mode] = process.argv.slice(2);
const stoppedOnly = mode === '--stopped-only';
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !homeArgument)
  throw new Error(
    'Usage: probe-claude-sigterm.mjs <claude version> <fake home under /private/var>',
  );
const home = await realpath(homeArgument);
if (!home.startsWith('/private/var/'))
  throw new Error('The fake home must resolve under /private/var');
const claude = join(homedir(), '.local', 'share', 'claude', 'versions', version);
const tmux = '/opt/homebrew/bin/tmux';
const base = ['-u', '-S', join(home, 'sig.sock'), '-f', '/dev/null'];
const project = join(home, 'project-sigterm');
const sessionsDir = join(home, '.claude', 'sessions');
const env = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: home,
  LANG: 'en_US.UTF-8',
  TERM: 'xterm-256color',
  USER: process.env.USER ?? '',
};
const t = async (...args) => (await execFileAsync(tmux, [...base, ...args], { env })).stdout;
const ignoreExisting = (error) => {
  if (error.code !== 'EEXIST') throw error;
};

await mkdir(join(home, 'Library'), { recursive: true });
await symlink(join(homedir(), 'Library', 'Keychains'), join(home, 'Library', 'Keychains')).catch(
  ignoreExisting,
);
await copyFile(
  join(homedir(), '.claude.json'),
  join(home, '.claude.json'),
  constants.COPYFILE_EXCL,
).catch(ignoreExisting);
await mkdir(join(home, '.claude'), { recursive: true });
await mkdir(project, { recursive: true });
await chmod(home, 0o700);

let modelTurns = 0;
const report = { version, steps: [] };
const note = (step, data) => {
  report.steps.push({ step, ...data });
  console.log(step, JSON.stringify(data));
};
const plain = (pane) => t('capture-pane', '-p', '-t', pane);
const trustQuestion = (screen) => /trust this folder/.test(screen);
const promptLine = (screen) =>
  screen
    .split('\n')
    .filter((line) => line.startsWith('❯'))
    .at(-1) ?? '';
const inputBox = (screen) =>
  promptLine(screen) !== '' && !/esc to interrupt/.test(screen) && !trustQuestion(screen);
async function until(ready, label, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await ready();
    if (value) return value;
    if (Date.now() > end) throw new Error('Timed out waiting for ' + label);
    await sleep(100);
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
};
async function record(pid) {
  try {
    return JSON.parse(await readFile(join(sessionsDir, `${pid}.json`), 'utf8'));
  } catch {
    return undefined;
  }
}
const lstart = (pid) =>
  execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
  })
    .toString()
    .trim();
const panePid = async (name) =>
  Number((await t('display-message', '-p', '-t', `=${name}:`, '#{pane_pid}')).trim());
const parentPid = (pid) =>
  Number(
    execFileSync('/bin/ps', ['-p', String(pid), '-o', 'ppid='])
      .toString()
      .trim(),
  );
/** The pane process, or for a wrapped launch the pane shell's only child. */
async function claudePid(name, wrapped) {
  const pane = await panePid(name);
  if (!wrapped) return pane;
  const children = execFileSync('/usr/bin/pgrep', ['-P', String(pane)])
    .toString()
    .trim()
    .split('\n');
  if (children.length !== 1)
    throw new Error(`The ${name} pane shell has ${children.length} children`);
  return Number(children[0]);
}
/** Refuses to signal anything but the Claude this probe started in its own pane, in its own project. */
async function signalOwn(name, pid, signal) {
  const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='])
    .toString()
    .trim();
  const cwd = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    .toString()
    .split('\n')
    .find((line) => line.startsWith('n'))
    ?.slice(1);
  const pane = await panePid(name);
  if (pane !== pid && parentPid(pid) !== pane)
    throw new Error(`${pid} is not the pane process of ${name} or its child`);
  if (!command.startsWith(claude + ' ') || !command.includes('--model haiku'))
    throw new Error(`${pid} is not this probe's Claude`);
  if (cwd === undefined || (await realpath(cwd)) !== (await realpath(project)))
    throw new Error(`${pid} does not run in the scratch project`);
  process.kill(pid, signal);
}
async function transcript(id) {
  const root = join(home, '.claude', 'projects');
  const files = [];
  for (const dir of await readdir(root).catch(() => []))
    for (const file of await readdir(join(root, dir)).catch(() => []))
      if (file.endsWith('.jsonl')) files.push(join(root, dir, file));
  const own = files.filter((path) => path.endsWith(`/${id}.jsonl`));
  const lines =
    own.length === 1 ? (await readFile(own[0], 'utf8')).split('\n').filter(Boolean) : [];
  return {
    files: files.length,
    own: own.length,
    records: lines.length,
    types: lines.map((l) => JSON.parse(l).type),
  };
}
/** Field names and types only, plus the values this spike is about. */
const shape = (r) => ({
  fields: Object.fromEntries(Object.entries(r).map(([key, value]) => [key, typeof value])),
  status: r.status,
  waitingFor: r.waitingFor,
  entrypoint: r.entrypoint,
  procStart: r.procStart,
});
const spawn = (name, args, wrapped = false) =>
  t(
    'new-session',
    '-d',
    '-s',
    name,
    '-x',
    '200',
    '-y',
    '50',
    '-c',
    project,
    '--',
    ...(wrapped ? ['/bin/sh', '-c', '"$@"; exit 0', 'sh'] : []),
    '/usr/bin/env',
    '-i',
    ...Object.entries({ ...env, DISABLE_AUTOUPDATER: '1' }).map(([k, v]) => `${k}=${v}`),
    claude,
    ...args,
    '--model',
    'haiku',
    '--permission-mode',
    'default',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
  );
const selectedLine = (screen) => screen.split('\n').find((line) => /❯/.test(line)) ?? '';
async function start(name, args, wrapped = false) {
  await spawn(name, args, wrapped);
  const pane = `=${name}:`;
  const first = await until(async () => {
    const screen = await plain(pane);
    return inputBox(screen) || trustQuestion(screen) ? screen : undefined;
  }, name + ' startup');
  if (trustQuestion(first)) {
    // Move the selection to the trust answer (wherever the question opens) before confirming.
    for (
      let presses = 0;
      !/Yes, I trust this folder/.test(selectedLine(await plain(pane)));
      presses += 1
    ) {
      if (presses >= 3) throw new Error('Could not select the trust answer');
      await t('send-keys', '-t', pane, 'Down');
      await sleep(300);
    }
    await t('send-keys', '-t', pane, 'Enter');
  }
  await until(async () => inputBox(await plain(pane)), name + ' input box');
  const pid = await claudePid(name, wrapped);
  const own = await until(() => record(pid), name + ' session record', 20_000);
  if (own.pid !== pid) throw new Error('The record does not describe the pane process');
  return { name, pane, pid, own };
}
async function terminate(session, label) {
  const sent = performance.now();
  await signalOwn(session.name, session.pid, 'SIGTERM');
  let exitedMs;
  let recordGoneMs;
  while (
    performance.now() - sent < EXIT_WAIT_MS &&
    (exitedMs === undefined || recordGoneMs === undefined)
  ) {
    if (exitedMs === undefined && !alive(session.pid))
      exitedMs = Math.round(performance.now() - sent);
    if (recordGoneMs === undefined && !(await record(session.pid)))
      recordGoneMs = Math.round(performance.now() - sent);
    await sleep(20);
  }
  note(label, { exitedMs, recordGoneMs });
  return { exitedMs, recordGoneMs };
}
/** SIGSTOP, then SIGTERM: is the SIGTERM held until SIGCONT? */
async function stopThenTerminate(session, label) {
  await signalOwn(session.name, session.pid, 'SIGSTOP');
  await signalOwn(session.name, session.pid, 'SIGTERM');
  await sleep(STOPPED_WATCH_MS);
  note(label, { aliveAfter3s: alive(session.pid), recordAfter3s: !!(await record(session.pid)) });
  const continued = performance.now();
  if (alive(session.pid)) await signalOwn(session.name, session.pid, 'SIGCONT');
  await until(async () => !alive(session.pid), session.name + ' exit after SIGCONT', EXIT_WAIT_MS);
  note(label + '-after-sigcont', {
    exitMs: Math.round(performance.now() - continued),
    recordGone: !(await record(session.pid)),
    paneLives: await paneLives(session.name),
  });
}
const paneLives = (name) =>
  t('has-session', '-t', `=${name}`).then(
    () => true,
    () => false,
  );

try {
  probe: {
    // B first, no model turn: a fresh launch in a pane, and a stopped process with a SIGTERM pending (the manual
    // check's timeout recipe).
    const b = randomUUID();
    const second = await start('b', ['--session-id', b]);
    note('fresh-launch', {
      record: shape(second.own),
      sessionIdIsRequested: second.own.sessionId === b,
      transcript: await transcript(b),
    });
    await stopThenTerminate(second, 'sigterm-while-stopped');
    const c = await start('c', ['--session-id', randomUUID()], true);
    await stopThenTerminate(c, 'sigterm-while-stopped-child');
    if (stoppedOnly) break probe;

    // Resumes that cannot work: B never had a turn (no transcript), and an id nobody used.
    for (const [label, id] of [
      ['resume-no-transcript', b],
      ['resume-unknown-id', randomUUID()],
    ]) {
      await spawn(label, ['--resume', id]);
      const begun = performance.now();
      let last = '';
      let box = false;
      while (performance.now() - begun < EXIT_WAIT_MS) {
        const screen = await plain(`=${label}:`).catch(() => undefined);
        if (screen === undefined) break;
        last = screen;
        if (inputBox(screen)) {
          box = true;
          break;
        }
        await sleep(100);
      }
      const pid = box ? await panePid(label) : undefined;
      const opened = pid
        ? await until(() => record(pid), label + ' record', 5_000).catch(() => undefined)
        : undefined;
      note(label, {
        paneClosedMs: box ? undefined : Math.round(performance.now() - begun),
        paneLivesAfterWatch: await paneLives(label),
        inputBox: box,
        openedSessionId: opened?.sessionId === id ? 'same' : opened ? 'other' : 'none',
        openedRecordFile: !!opened,
        lastScreen: last.trim().split('\n').slice(-8).join('\n'),
      });
    }

    // A: the only model turn; then SIGTERM while idle; then resume.
    const a = randomUUID();
    const first = await start('a', ['--session-id', a]);
    if (first.own.sessionId !== a) throw new Error('The record names another session');
    execFileSync(tmux, [...base, 'load-buffer', '-b', 'spike', '-'], { env, input: MESSAGE });
    await t('paste-buffer', '-p', '-r', '-d', '-b', 'spike', '-t', first.pane);
    await sleep(300);
    await t('send-keys', '-t', first.pane, 'Enter');
    modelTurns += 1;
    await until(
      async () =>
        (await record(first.pid))?.status === 'idle' &&
        (await transcript(a)).types.includes('assistant'),
      'the answer',
      120_000,
    );
    const idle = await record(first.pid);
    const ps = lstart(first.pid);
    note('record-idle', {
      ...shape(idle),
      psLstartUtc: ps,
      procStartMatchesPs: idle.procStart === ps,
    });
    note('transcript-before', await transcript(a));
    const closed = await terminate(first, 'sigterm-idle');
    note('pane-after-sigterm', { paneLives: await paneLives('a') });
    note('transcript-after-sigterm', await transcript(a));
    if (closed.exitedMs === undefined)
      throw new Error('STOP 1: Claude did not exit within 15 s of SIGTERM');
    const resumedAt = performance.now();
    const resumed = await start('r', ['--resume', a]);
    note('resume', {
      msToRecord: Math.round(performance.now() - resumedAt),
      record: shape(resumed.own),
      sessionIdKept: resumed.own.sessionId === a,
      historyShown: (await plain(resumed.pane)).includes(MESSAGE),
    });
    note('transcript-after-resume', await transcript(a));
    await terminate(resumed, 'sigterm-resumed');
  }
} finally {
  report.modelTurns = modelTurns;
  console.log(JSON.stringify(report, null, 2));
  await t('kill-server').catch(() => undefined);
}
