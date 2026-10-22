import { lstatSync, type Stats } from 'node:fs';
import { rmdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CHANNEL_LEDGER_FILE, CHANNEL_REGISTRY_DIR } from './channel-names.js';
import { createChannelRegistry } from './channel-registry.js';

/*
 * When Claude channel helpers were running across the data-folder move, the migration leaves the old folder holding a
 * hard link to the moved ledger (see `keepLedgerWritable` in src/runtime/data-migration.ts). This module owns that
 * link's life: which path every ledger opener uses while it exists, and its removal once no helper needs it.
 */

const errorCode = (error: unknown): unknown =>
  error instanceof Error && 'code' in error ? error.code : undefined;

const statOrUndefined = (path: string): Stats | undefined => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};

/** Whether `link` is a regular file that is the same file as `ledger` (a hard link, never a symlink). */
function sameLedger(link: string, ledger: string): boolean {
  const a = statOrUndefined(link);
  const b = statOrUndefined(ledger);
  return !!a && !!b && a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino;
}

/**
 * The path every ledger opener uses, in `stateDir` or, while the old folder's link names the same file, that link.
 * SQLite names a rollback journal after the path a connection opened: if helpers opened the one database by two
 * names, a journal left by a crash under one name would be missed by connections using the other, which would then
 * commit on top of it, and a later opener of the first name would roll newer pages back. One name keeps one journal.
 */
export function channelLedgerPath(stateDir: string, legacyStateDir?: string): string {
  const ledger = join(stateDir, CHANNEL_LEDGER_FILE);
  if (legacyStateDir === undefined || resolve(legacyStateDir) === resolve(stateDir)) return ledger;
  const link = join(legacyStateDir, CHANNEL_LEDGER_FILE);
  return sameLedger(link, ledger) ? link : ledger;
}

export type LegacyLinkOutcome = 'absent' | 'kept' | 'removed';

/**
 * Removes the old folder's ledger link once no helper may still write by that path: `inUse(link)` answers that from
 * the live registrations. Removes only the link itself (same file as the new ledger, no journal beside it), then the
 * old `claude-channels` folder and the old folder, each only if empty. Never deletes anything else.
 */
export async function pruneLegacyLedgerLink(options: {
  stateDir: string;
  legacyStateDir: string;
  inUse(link: string): Promise<boolean>;
  log(message: string): void;
}): Promise<LegacyLinkOutcome> {
  const ledger = join(options.stateDir, CHANNEL_LEDGER_FILE);
  const link = join(options.legacyStateDir, CHANNEL_LEDGER_FILE);
  // The cheap check that every later scan ends at.
  if (!statOrUndefined(link)) return 'absent';
  if (!sameLedger(link, ledger)) return 'kept';
  // A journal means a commit is running or a helper died mid-commit; its next opener rolls it back by this name.
  if (statOrUndefined(link + '-journal')) return 'kept';
  if (await options.inUse(link)) return 'kept';
  // The registry scan awaited: check the files again right before the unlink.
  if (!sameLedger(link, ledger) || statOrUndefined(link + '-journal')) return 'kept';
  await unlink(link);
  for (const folder of [join(options.legacyStateDir, CHANNEL_REGISTRY_DIR), options.legacyStateDir])
    try {
      await rmdir(folder);
    } catch (error) {
      // Not empty (or already gone): what is left there is not ours to delete.
      if (errorCode(error) !== 'ENOENT') break;
    }
  options.log(
    `Removed ${link}: no Claude channel helper from before the data-folder move is running.`,
  );
  return 'removed';
}

/**
 * Pruning for one pair of folders, one run at a time (a scan that finds one running shares its result). `inUse`
 * defaults to the live registrations in both folders' registries.
 */
export function createLegacyLedgerPruner(
  options: Omit<Parameters<typeof pruneLegacyLedgerLink>[0], 'inUse'> & {
    inUse?: (link: string) => Promise<boolean>;
  },
): () => Promise<LegacyLinkOutcome> {
  const inUse =
    options.inUse ??
    ((link: string) =>
      createChannelRegistry({
        registryDir: join(options.stateDir, CHANNEL_REGISTRY_DIR),
        legacyRegistryDir: join(options.legacyStateDir, CHANNEL_REGISTRY_DIR),
      }).ledgerInUse(link));
  let running: Promise<LegacyLinkOutcome> | undefined;
  return () =>
    (running ??= pruneLegacyLedgerLink({ ...options, inUse })
      .catch((): LegacyLinkOutcome => 'kept')
      .finally(() => {
        running = undefined;
      }));
}
