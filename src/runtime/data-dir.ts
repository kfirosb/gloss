import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Folder name, under the user's home, that holds all Gloss state (database, attachments, tmux socket, channel files). */
export const DATA_DIR_NAME = '.gloss';
/** The folder name used before the product was renamed; only migration and uninstall code may name it. */
export const LEGACY_DATA_DIR_NAME = '.language-assistant';

/** The one owner of the Gloss data-folder path. `home` is injectable so tests never touch the real home. */
export const dataDir = (home: string = homedir()): string => join(home, DATA_DIR_NAME);
export const legacyDataDir = (home: string = homedir()): string => join(home, LEGACY_DATA_DIR_NAME);

/** Whether anything is at the path; an unreadable entry still counts as there. */
const occupied = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ENOENT');
  }
};

/**
 * The data folder for code that runs outside the two entry points that move it (desktop/main.mjs, src/runtime/cli.ts),
 * such as a Claude session's channel helper. Before the move only the old folder exists; creating the new one there
 * would make the move find both folders and leave every user file behind, so that code keeps using the old folder
 * until the move has happened. Otherwise this is `dataDir`.
 */
export function existingDataDir(home: string = homedir()): string {
  const next = dataDir(home);
  if (occupied(next)) return next;
  const legacy = legacyDataDir(home);
  return occupied(legacy) ? legacy : next;
}
