import { basename } from 'node:path';
import { collectProcess, runProcess, type ProcessRunner } from '../../runtime/process-runner.js';

/** One process as `ps` reports it; `startedAt` is `lstart` in UTC and the C locale, the form Claude writes as `procStart`. */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  uid: number;
  startedAt: string;
  command: string;
}
/** Bound on one `ps` call's output and on each line, in bytes; one process is one short line. */
const PS_MAX_OUTPUT_BYTES = 4096;
/** Bound on one `ps` call's diagnostics, in bytes. */
const PS_MAX_DIAGNOSTIC_BYTES = 1024;
const PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})\s+(.+?)\s*$/;
/**
 * The names a Claude process runs under: a native binary is named after its version, a PATH install is `claude`, and
 * the npm package runs as `claude.exe`. `command` may be a path; only its last component counts.
 */
export function isClaudeExecutable(command: string, version: string): boolean {
  const name = basename(command);
  return name === 'claude' || name === 'claude.exe' || name === version;
}
/**
 * Reads one process with `ps`; undefined when it does not exist, `ps` takes longer than `timeoutMs` milliseconds, or
 * the output is not exactly one well-formed line. Each caller names its own timeout: a busy Mac can be slow to answer.
 */
export async function readProcess(
  pid: number,
  signal: AbortSignal,
  timeoutMs: number,
  runner: ProcessRunner = runProcess,
): Promise<ProcessInfo | undefined> {
  const result = await collectProcess(
    runner('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,uid=,lstart=,comm='], '', signal, {
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
      timeoutMs,
      maxOutputBytes: PS_MAX_OUTPUT_BYTES,
      maxLineBytes: PS_MAX_OUTPUT_BYTES,
      maxDiagnosticBytes: PS_MAX_DIAGNOSTIC_BYTES,
    }),
  );
  const [line, ...rest] = result.lines;
  if (
    result.outcome.reason !== 'exited' ||
    result.outcome.code !== 0 ||
    line === undefined ||
    rest.length
  )
    return undefined;
  const [, ownPid, ppid, uid, startedAt, command] = PS_LINE.exec(line) ?? [];
  if (!ownPid || !ppid || !uid || !startedAt || !command) return undefined;
  return { pid: Number(ownPid), ppid: Number(ppid), uid: Number(uid), startedAt, command };
}
