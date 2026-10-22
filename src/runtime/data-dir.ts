import { homedir } from 'node:os';
import { join } from 'node:path';

/** Folder name, under the user's home, that holds all Gloss state (database, attachments, tmux socket, channel files). */
export const DATA_DIR_NAME = '.gloss';
/** The folder name used before the product was renamed; only migration and uninstall code may name it. */
export const LEGACY_DATA_DIR_NAME = '.language-assistant';

/** The one owner of the Gloss data-folder path. `home` is injectable so tests never touch the real home. */
export const dataDir = (home: string = homedir()): string => join(home, DATA_DIR_NAME);
export const legacyDataDir = (home: string = homedir()): string => join(home, LEGACY_DATA_DIR_NAME);
