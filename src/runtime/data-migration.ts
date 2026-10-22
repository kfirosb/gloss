import { spawnSync } from 'node:child_process';
import { link as linkFile, lstat, mkdir, readdir, rename as renameFolder } from 'node:fs/promises';
import { join } from 'node:path';
import { CHANNEL_LEDGER_FILE, CHANNEL_REGISTRY_DIR } from '../agents/claude/channel-names.js';
import { dataDir, legacyDataDir } from './data-dir.js';
import { lsofDiagnosticsClean, lsofPath, supportsProcessProbes } from './platform-tools.js';
import { collectProcess, runProcess, type ProcessRunner } from './process-runner.js';

/** What happened to the data folder. A discriminated union so later cases can carry their own details. */
export type MigrationResult =
  | { kind: 'moved' }
  | { kind: 'already-new' }
  | { kind: 'fresh' }
  | { kind: 'both-exist' }
  /** Both exist, but the old folder holds only Claude channel helpers' files: left alone, not a failed move. */
  | { kind: 'legacy-helpers' }
  | { kind: 'in-use' }
  | { kind: 'lsof-missing' }
  | { kind: 'cross-device' };

/** Whether another process holds the old database: `lsof-missing` means nobody could check. */
export type StateDbUse = 'free' | 'in-use' | 'lsof-missing';

const LSOF_TIMEOUT_MS = 5000;
const LSOF_MAX_OUTPUT_BYTES = 64 * 1024;

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
 * server's socket and channel helpers' registrations are not checked; they keep their inodes through a rename. Nothing
 * is created on any outcome except `moved`, which may also link the channel ledger back at its old path (see
 * `keepLedgerWritable`).
 */
export async function migrateDataDir(options: {
  home: string;
  probe(path: string): Promise<StateDbUse>;
  log(message: string): void;
  /** Tests inject a failing rename or link; production uses the filesystem's. */
  rename?: (from: string, to: string) => Promise<void>;
  link?: (existing: string, alias: string) => Promise<void>;
}): Promise<MigrationResult> {
  const legacy = legacyDataDir(options.home);
  const next = dataDir(options.home);
  const [hasLegacy, hasNext] = await Promise.all([present(legacy), present(next)]);
  const bothExist = async (): Promise<MigrationResult> => {
    if (await onlyHelperFiles(legacy)) {
      options.log(
        `${legacy} holds only files of older Claude channel helpers; using ${next} and leaving it untouched.`,
      );
      return { kind: 'legacy-helpers' };
    }
    options.log(`Both ${legacy} and ${next} exist; using ${next} and leaving ${legacy} untouched.`);
    return { kind: 'both-exist' };
  };
  if (hasNext) return hasLegacy ? bothExist() : { kind: 'already-new' };
  if (!hasLegacy) return { kind: 'fresh' };
  const use = await options.probe(join(legacy, 'state.db'));
  if (use !== 'free') return { kind: use };
  try {
    await (options.rename ?? renameFolder)(legacy, next);
  } catch (error) {
    const code = errorCode(error);
    // The new folder appeared since the check: the same no-merge rule applies.
    if (code === 'EEXIST' || code === 'ENOTEMPTY') return bothExist();
    // A different disk would need a copy of hundreds of megabytes; refuse and leave the old folder intact.
    if (code === 'EXDEV') {
      options.log(`${legacy} and ${next} are on different disks; not moving the data folder.`);
      return { kind: 'cross-device' };
    }
    throw error;
  }
  options.log(`Moved ${legacy} to ${next}.`);
  await keepLedgerWritable({ ...options, legacy, next });
  return { kind: 'moved' };
}

/** What a channel helper started before the move can leave in, or bring back to, the old folder. */
const HELPER_ENTRIES = new Set([
  CHANNEL_REGISTRY_DIR,
  ...['', '-journal', '-wal', '-shm'].map((suffix) => CHANNEL_LEDGER_FILE + suffix),
]);
const onlyHelperFiles = async (legacy: string) =>
  (await readdir(legacy)).every((name) => HELPER_ENTRIES.has(name));

/**
 * A channel helper started before the move keeps its ledger open, but SQLite writes by path: each commit first checks
 * that the path still names the open file, then creates `<ledger>-journal` beside it. With the folder gone every
 * claim fails, so Gloss can no longer send into that Claude session. While some process holds the moved ledger, a
 * private old folder with a hard link (never a symlink) to it keeps those writes landing in the one moved database.
 * The link is best effort: failing it costs only those sessions' channel, never the move.
 */
async function keepLedgerWritable(options: {
  legacy: string;
  next: string;
  probe(path: string): Promise<StateDbUse>;
  log(message: string): void;
  link?: (existing: string, alias: string) => Promise<void>;
}): Promise<void> {
  const ledger = join(options.next, CHANNEL_LEDGER_FILE);
  const alias = join(options.legacy, CHANNEL_LEDGER_FILE);
  // Runs after the move, so nothing here may throw.
  try {
    if (!(await present(ledger))) return;
    // Unsure counts as held: an unneeded link only leaves a small folder, a missing one breaks running sessions.
    if ((await options.probe(ledger)) === 'free') return;
    await mkdir(options.legacy, { mode: 0o700 });
    await (options.link ?? linkFile)(ledger, alias);
  } catch (error) {
    options.log(
      `Could not link ${alias} for running Claude channel helpers (${String(errorCode(error) ?? error)}); those sessions need their channel reconnected.`,
    );
    return;
  }
  options.log(`Linked ${alias} to ${ledger} for Claude channel helpers that are still running.`);
}

/** The user-facing reason a migration stopped and the user must act outside Gloss, or undefined. */
export function migrationBlockedMessage(result: MigrationResult, home: string): string | undefined {
  const legacy = legacyDataDir(home);
  const next = dataDir(home);
  if (result.kind === 'cross-device')
    return `Gloss could not move its data from ${legacy} to ${next} because they are on different disks. Move the folder yourself, then open Gloss again.`;
  if (result.kind === 'lsof-missing')
    return `Gloss needs lsof to check that no older copy of Gloss is using ${legacy} before moving it to ${next}. Install lsof (for example: sudo apt install lsof), then open Gloss again.`;
  return undefined;
}

/**
 * Decides from one `lsof -t -- <db> <db>-wal` run, with the same stderr policy as every other lsof probe: exit 1 with
 * no pids is "free" only when stderr holds nothing but missing-path notices (the WAL often does not exist). The
 * current process is ignored. Anything unexpected counts as in use: moving a live database is worse than a retry.
 */
function decideLsof(
  run: { code: number | null; pids: string[]; diagnostics: string },
  ownPid: number,
): StateDbUse {
  if (run.code !== 0 && run.code !== 1) return 'in-use';
  if (!lsofDiagnosticsClean(run.diagnostics)) return 'in-use';
  if (run.pids.some((pid) => !/^[1-9]\d*$/.test(pid))) return 'in-use';
  if (run.code === 0 && run.pids.length === 0) return 'in-use';
  return run.pids.some((pid) => pid !== String(ownPid)) ? 'in-use' : 'free';
}

const lsofArgs = (path: string) => ['-t', '--', path, path + '-wal'];
const pidLines = (lines: string[]) => lines.map((line) => line.trim()).filter(Boolean);

/** Whether a process other than this one has `state.db` or its WAL open. */
export async function probeStateDb(
  path: string,
  options: { runner?: ProcessRunner; pid?: number; platform?: NodeJS.Platform } = {},
): Promise<StateDbUse> {
  const platform = options.platform ?? process.platform;
  if (!supportsProcessProbes(platform)) return 'in-use';
  const runner = options.runner ?? runProcess;
  const { lines, outcome } = await collectProcess(
    runner(lsofPath(platform), lsofArgs(path), '', AbortSignal.timeout(LSOF_TIMEOUT_MS + 500), {
      timeoutMs: LSOF_TIMEOUT_MS,
      maxOutputBytes: LSOF_MAX_OUTPUT_BYTES,
    }),
  );
  if (outcome.reason === 'spawn-error') return 'lsof-missing';
  if (outcome.reason !== 'exited') return 'in-use';
  return decideLsof(
    { code: outcome.code, pids: pidLines(lines), diagnostics: outcome.diagnostics },
    options.pid ?? process.pid,
  );
}

/** A synchronous, shell-free process run: the subset of `spawnSync` the probe reads. */
export type SyncRun = (
  executable: string,
  args: string[],
) => { status: number | null; stdout: string; stderr: string; error?: Error | undefined };

const runSync: SyncRun = (executable, args) =>
  spawnSync(executable, args, {
    encoding: 'utf8',
    timeout: LSOF_TIMEOUT_MS,
    maxBuffer: LSOF_MAX_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/**
 * The same check, synchronously, for the desktop app before Electron's ready event: the settings folder (which holds
 * the single-instance lock) must not move while an older Gloss is running.
 */
export function probeStateDbSync(
  path: string,
  options: { run?: SyncRun; pid?: number; platform?: NodeJS.Platform } = {},
): StateDbUse {
  const platform = options.platform ?? process.platform;
  if (!supportsProcessProbes(platform)) return 'in-use';
  const run = (options.run ?? runSync)(lsofPath(platform), lsofArgs(path));
  if (run.error) return errorCode(run.error) === 'ENOENT' ? 'lsof-missing' : 'in-use';
  return decideLsof(
    { code: run.status, pids: pidLines(run.stdout.split('\n')), diagnostics: run.stderr },
    options.pid ?? process.pid,
  );
}
