// The desktop side of the rename, kept free of Electron so it can be unit tested.
// - migrateUserData moves the Electron settings folder (window bounds, desktop.json, local storage) from its
//   pre-rename name to Gloss. It must run before Electron first uses userData (the single-instance lock lives there),
//   and only while no older Gloss is running. One rename or nothing: when both folders exist the new one is used.
// - settleMigration drives the dialogs around a migration attempt: Retry while an older copy holds the database,
//   Quit for a refusal the user must fix outside Gloss.
import { join } from 'node:path';

export const IN_USE_MESSAGE = 'Another copy of Gloss is still running. Quit it, then choose Retry.';

export const LEGACY_SETTINGS_NAME = 'language-assistant';
export const SETTINGS_NAME = 'Gloss';

/**
 * The settings folders Gloss manages under appData, or undefined when it was started with an explicit
 * --user-data-dir: that folder is the caller's choice, so nothing is moved and userData is not overridden.
 */
export function settingsFolders({ appData, explicitUserDataDir }) {
  if (explicitUserDataDir) return undefined;
  return { legacy: join(appData, LEGACY_SETTINGS_NAME), next: join(appData, SETTINGS_NAME) };
}

export function migrateUserData({ appData, legacyName, name, rename, exists }) {
  const legacy = join(appData, legacyName);
  const next = join(appData, name);
  if (!exists(legacy)) return 'kept';
  if (exists(next)) return 'both-exist';
  rename(legacy, next);
  return 'moved';
}

/**
 * `attempt` returns a result `{ kind }` (a data migration result or a database probe). `ask` shows the Retry/Quit
 * dialog and resolves true for Retry; `tell` shows a Quit-only explanation. Returns 'proceed' or 'quit'.
 */
export async function settleMigration({ attempt, ask, tell }) {
  for (;;) {
    const result = await attempt();
    if (result.kind === 'in-use') {
      if (await ask()) continue;
      return 'quit';
    }
    if (result.kind === 'lsof-missing' || result.kind === 'cross-device') {
      await tell(result);
      return 'quit';
    }
    return 'proceed';
  }
}

/**
 * The start that found an older Gloss holding the old database: nothing was moved, so once it is free the app
 * restarts and that next start moves both folders before Electron is ready. No window is opened here.
 */
export async function waitForOlderCopy({ probe, ask, tell, relaunch, quit }) {
  const outcome = await settleMigration({ attempt: async () => ({ kind: probe() }), ask, tell });
  if (outcome === 'proceed') relaunch();
  else quit();
}
