// Moves the Electron settings folder (window bounds, desktop.json, local storage) from its pre-rename name to Gloss,
// kept free of Electron so it can be unit tested. It must run before Electron first uses userData (the single-instance
// lock lives there). One rename or nothing: when both folders exist the new one is used and the old one is untouched.
import { join } from 'node:path';

export function migrateUserData({ appData, legacyName, name, rename, exists }) {
  const legacy = join(appData, legacyName);
  const next = join(appData, name);
  if (!exists(legacy)) return 'kept';
  if (exists(next)) return 'both-exist';
  rename(legacy, next);
  return 'moved';
}
