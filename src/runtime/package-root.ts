import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The `name` in this repository's package.json; identifies the package root when walking up from a module. */
export const PACKAGE_NAME = 'language-assistant';
/** Walks up from `start` (at most `maxLevels` directories) to the directory whose package.json is named PACKAGE_NAME; source runs from src/runtime and the build from dist/server/runtime. */
export function packageRoot(start: string, maxLevels = 6): string | undefined {
  let dir = start;
  for (let level = 0; level < maxLevels; level += 1, dir = dirname(dir)) {
    try {
      if (
        (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }).name ===
        PACKAGE_NAME
      )
        return dir;
    } catch {
      /* keep walking up */
    }
    if (dirname(dir) === dir) break;
  }
  return undefined;
}
