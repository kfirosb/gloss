import type {
  ProcessOptions,
  ProcessOutcome,
  ProcessRunner,
} from '../../src/runtime/process-runner.js';
import { lsofPath } from '../../src/runtime/platform-tools.js';

export interface LsofOwner {
  pid: number;
  command: string;
}
export interface LsofBehavior {
  exit?: number;
  diagnostics?: string;
  reason?: ProcessOutcome['reason'];
  extraLines?: string[];
  /** Hold the reply until this settles, to observe in-flight requests. */
  wait?: Promise<void>;
}

/** A fake `lsof -Fpcfn +c 0 -- <paths>` (at the platform's lsof path) over a simulated table of socket holders. */
export function lsofRunner(
  owners: Record<string, LsofOwner[]>,
  behavior?: LsofBehavior | ((paths: string[], call: number) => LsofBehavior | undefined),
): { runner: ProcessRunner; calls: string[][]; options: (ProcessOptions | undefined)[] } {
  const calls: string[][] = [];
  const options: (ProcessOptions | undefined)[] = [];
  const runner: ProcessRunner = async function* (executable, args, _input, _signal, opts) {
    if (executable !== lsofPath()) throw new Error('Unexpected process');
    calls.push(args);
    options.push(opts);
    const paths = lsofPaths(args);
    const chosen = typeof behavior === 'function' ? behavior(paths, calls.length - 1) : behavior;
    if (chosen?.wait) await chosen.wait;
    for (const line of ownerLines(owners, paths)) yield { type: 'line', line };
    for (const line of chosen?.extraLines ?? []) yield { type: 'line', line };
    const unowned = paths.some((path) => !owners[path]?.length);
    yield {
      type: 'exit',
      outcome: {
        reason: chosen?.reason ?? 'exited',
        code: chosen?.exit ?? (unowned ? 1 : 0),
        signal: null,
        diagnostics: chosen?.diagnostics ?? '',
      },
    };
  };
  return { runner, calls, options };
}

/** `-Fpcfn` output for the requested paths: one p/c record per holder, then f/n per held path. */
export function ownerLines(
  owners: Record<string, LsofOwner[]>,
  paths: readonly string[],
): string[] {
  const byPid = new Map<number, { command: string; paths: string[] }>();
  for (const path of paths)
    for (const owner of owners[path] ?? []) {
      const entry = byPid.get(owner.pid) ?? { command: owner.command, paths: [] };
      entry.paths.push(path);
      byPid.set(owner.pid, entry);
    }
  const lines: string[] = [];
  for (const [pid, { command, paths: held }] of byPid) {
    lines.push(`p${pid}`, `c${command}`);
    for (const [index, path] of held.entries()) lines.push(`f${10 + index}`, `n${path}`);
  }
  return lines;
}
/** The socket paths of a batched owner query. */
export const lsofPaths = (args: readonly string[]) => args.slice(args.indexOf('--') + 1);
