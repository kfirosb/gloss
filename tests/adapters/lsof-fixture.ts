import type {
  ProcessOptions,
  ProcessOutcome,
  ProcessRunner,
} from '../../src/runtime/process-runner.js';

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

/** A fake `/usr/sbin/lsof -Fpcfn +c 0 -- <paths>` over a simulated table of socket holders. */
export function lsofRunner(
  owners: Record<string, LsofOwner[]>,
  behavior?: LsofBehavior | ((paths: string[], call: number) => LsofBehavior | undefined),
): { runner: ProcessRunner; calls: string[][]; options: (ProcessOptions | undefined)[] } {
  const calls: string[][] = [];
  const options: (ProcessOptions | undefined)[] = [];
  const runner: ProcessRunner = async function* (executable, args, _input, _signal, opts) {
    if (executable !== '/usr/sbin/lsof') throw new Error('Unexpected process');
    calls.push(args);
    options.push(opts);
    const paths = args.slice(args.indexOf('--') + 1);
    const chosen = typeof behavior === 'function' ? behavior(paths, calls.length - 1) : behavior;
    if (chosen?.wait) await chosen.wait;
    const byPid = new Map<number, { command: string; paths: string[] }>();
    for (const path of paths)
      for (const owner of owners[path] ?? []) {
        const entry = byPid.get(owner.pid) ?? { command: owner.command, paths: [] };
        entry.paths.push(path);
        byPid.set(owner.pid, entry);
      }
    for (const [pid, { command, paths: held }] of byPid) {
      yield { type: 'line', line: `p${pid}` };
      yield { type: 'line', line: `c${command}` };
      for (const [index, path] of held.entries()) {
        yield { type: 'line', line: `f${10 + index}` };
        yield { type: 'line', line: `n${path}` };
      }
    }
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
