import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSessionRecord,
  readSessionRecords,
  sessionRecordPath,
  trustedProcStart,
} from '../../src/agents/claude/session-records.js';
import { isClaudeExecutable, readProcess } from '../../src/agents/claude/process-probe.js';
import type { ProcessOptions, ProcessRunner } from '../../src/runtime/process-runner.js';
import { shellQuote } from '../../src/core/command-text.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function config() {
  const dir = await mkdtemp(join(tmpdir(), 'claude-records-'));
  dirs.push(dir);
  await mkdir(join(dir, 'sessions'));
  return dir;
}
const base = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  cwd: '/project',
  pid: 4242,
  version: '2.1.302',
  status: 'idle',
};

it('reads procStart as a string and drops a malformed one', async () => {
  const dir = await config();
  await writeFile(
    sessionRecordPath(dir, 4242),
    JSON.stringify({ ...base, procStart: 'Sat Oct 18 10:00:00 2026' }),
  );
  await writeFile(
    sessionRecordPath(dir, 4243),
    JSON.stringify({ ...base, pid: 4243, procStart: 17 }),
  );
  expect(await readSessionRecord(sessionRecordPath(dir, 4242))).toMatchObject({
    pid: 4242,
    procStart: 'Sat Oct 18 10:00:00 2026',
  });
  const malformed = await readSessionRecord(sessionRecordPath(dir, 4243));
  expect(malformed?.pid).toBe(4243);
  expect(malformed?.procStart).toBeUndefined();
  expect((await readSessionRecords(dir)).map((r) => r.pid).sort()).toEqual([4242, 4243]);
  expect(await readSessionRecord(sessionRecordPath(dir, 1))).toBeUndefined();
});

it('reads the first record after --resume, which has no status or update times yet', async () => {
  const dir = await config();
  const { status: _status, ...resumed } = base;
  await writeFile(
    sessionRecordPath(dir, 4242),
    JSON.stringify({ ...resumed, procStart: 'Sat Oct 18 10:00:00 2026', pidDomain: 'darwin' }),
  );
  const record = await readSessionRecord(sessionRecordPath(dir, 4242));
  expect(record).toMatchObject({ pid: 4242, pidDomain: 'darwin' });
  expect(record?.status).toBeUndefined();
  expect(record?.updatedAt).toBeUndefined();
});

it('trusts procStart only from a record whose pid is a macOS pid', () => {
  const procStart = 'Sat Oct 18 10:00:00 2026';
  expect(trustedProcStart({ ...base, procStart, pidDomain: 'darwin' })).toBe(procStart);
  expect(trustedProcStart({ ...base, procStart, pidDomain: 'linux' })).toBeUndefined();
  expect(trustedProcStart({ ...base, procStart })).toBeUndefined();
  expect(trustedProcStart({ ...base, pidDomain: 'darwin' })).toBeUndefined();
});

it('names a Claude executable by claude, claude.exe or the session version, by its basename', () => {
  expect(isClaudeExecutable('/usr/local/bin/claude', '2.1.302')).toBe(true);
  expect(isClaudeExecutable('claude.exe', '2.1.302')).toBe(true);
  expect(isClaudeExecutable('/Users/x/.local/share/claude/versions/2.1.302', '2.1.302')).toBe(true);
  expect(isClaudeExecutable('/Users/x/.local/share/claude/versions/2.1.301', '2.1.302')).toBe(
    false,
  );
  expect(isClaudeExecutable('/usr/local/bin/node', '2.1.302')).toBe(false);
});

it('reads one process with ps in UTC and the C locale, and rejects anything but one well-formed line', async () => {
  const calls: { args: string[]; options: ProcessOptions | undefined }[] = [];
  const runner = (lines: string[], code = 0): ProcessRunner =>
    async function* (_executable, args, _input, _signal, options) {
      calls.push({ args, options });
      for (const line of lines) yield { type: 'line', line };
      yield { type: 'exit', outcome: { code, signal: null, reason: 'exited', diagnostics: '' } };
    };
  const signal = new AbortController().signal;
  expect(
    await readProcess(
      4242,
      signal,
      2500,
      runner([
        ' 4242     1   501 Sat Oct 18 10:00:00 2026 /Users/x/.local/share/claude/versions/2.1.302',
      ]),
    ),
  ).toEqual({
    pid: 4242,
    ppid: 1,
    uid: 501,
    startedAt: 'Sat Oct 18 10:00:00 2026',
    command: '/Users/x/.local/share/claude/versions/2.1.302',
  });
  expect(calls[0]?.args).toEqual(['-p', '4242', '-o', 'pid=,ppid=,uid=,lstart=,comm=']);
  expect(calls[0]?.options?.env).toMatchObject({ TZ: 'UTC', LC_ALL: 'C' });
  expect(calls[0]?.options?.timeoutMs).toBe(2500);
  expect(await readProcess(4242, signal, 2500, runner([], 1))).toBeUndefined();
  expect(await readProcess(4242, signal, 2500, runner(['a', 'b']))).toBeUndefined();
  expect(await readProcess(4242, signal, 2500, runner(['not ps output']))).toBeUndefined();
});

it('quotes a folder for a shown shell command', () => {
  expect(shellQuote("/Users/me/it's here")).toBe(`'/Users/me/it'"'"'s here'`);
});
