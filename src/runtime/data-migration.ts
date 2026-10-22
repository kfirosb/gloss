import { lstat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir, legacyDataDir } from './data-dir.js';
import { collectProcess, runProcess, type ProcessRunner } from './process-runner.js';

/** What happened to the data folder. A discriminated union so later cases can carry their own details. */
export type MigrationResult =
  | { kind: 'moved' }
  | { kind: 'already-new' }
  | { kind: 'fresh' }
  | { kind: 'both-exist' }
  | { kind: 'in-use' };

const LSOF_TIMEOUT_MS = 5000;

const errorCode = (error: unknown): unknown =>
  error instanceof Error && 'code' in error ? error.code : undefined;

const present = (path: string) =>
  lstat(path).then(
    () => true,
    (error: unknown) => {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    },
  );

/**
 * Moves `~/.language-assistant` to `~/.gloss` with one rename, or does nothing. It never copies, merges, overwrites
 * or deletes: when both folders exist the new one wins and the old one is left as it is. The move waits until no
 * other process has the old `state.db` open, so an older Gloss backend never loses its database mid-write. The tmux
 * server's socket and channel helpers' files are not checked; they keep their inodes through a rename.
 */
export async function migrateDataDir(options: {
  home: string;
  inUse(path: string): Promise<boolean>;
  log(message: string): void;
}): Promise<MigrationResult> {
  const legacy = legacyDataDir(options.home);
  const next = dataDir(options.home);
  const [hasLegacy, hasNext] = await Promise.all([present(legacy), present(next)]);
  const bothExist = (): MigrationResult => {
    options.log(`Both ${legacy} and ${next} exist; using ${next} and leaving ${legacy} untouched.`);
    return { kind: 'both-exist' };
  };
  if (hasNext) return hasLegacy ? bothExist() : { kind: 'already-new' };
  if (!hasLegacy) return { kind: 'fresh' };
  if (await options.inUse(join(legacy, 'state.db'))) return { kind: 'in-use' };
  try {
    await rename(legacy, next);
  } catch (error) {
    const code = errorCode(error);
    // The new folder appeared since the check: the same no-merge rule applies.
    if (code === 'EEXIST' || code === 'ENOTEMPTY') return bothExist();
    // A different disk would need a copy of hundreds of megabytes; refuse instead and leave the old folder intact.
    if (code === 'EXDEV') {
      options.log(`${legacy} is on a different disk from ${next}; not moving it. Move it by hand.`);
      return { kind: 'both-exist' };
    }
    throw error;
  }
  options.log(`Moved ${legacy} to ${next}.`);
  return { kind: 'moved' };
}

/**
 * True when a process other than this one has `state.db` or its WAL open. One `lsof -t` call lists holder pids;
 * lsof exits 1 both when nothing holds the files and when one of them (often the WAL) does not exist, so the pid
 * list decides. Anything unexpected counts as in use: moving a live database is worse than asking to retry.
 */
export async function stateDbInUse(
  path: string,
  options: { runner?: ProcessRunner; pid?: number } = {},
): Promise<boolean> {
  const runner = options.runner ?? runProcess;
  const ownPid = String(options.pid ?? process.pid);
  const { lines, outcome } = await collectProcess(
    runner(
      'lsof',
      ['-t', '--', path, path + '-wal'],
      '',
      AbortSignal.timeout(LSOF_TIMEOUT_MS + 500),
      {
        timeoutMs: LSOF_TIMEOUT_MS,
        maxOutputBytes: 64 * 1024,
      },
    ),
  );
  if (outcome.reason !== 'exited' || (outcome.code !== 0 && outcome.code !== 1)) return true;
  const pids = lines.map((line) => line.trim()).filter(Boolean);
  if (pids.some((pid) => !/^\d+$/.test(pid))) return true;
  if (outcome.code === 0 && pids.length === 0) return true;
  return pids.some((pid) => pid !== ownPid);
}
