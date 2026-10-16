import type { Stats } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';

/** A real (non-symlink) directory owned by this user and closed to everyone else. */
export const isPrivateDirectory = (info: Stats): boolean =>
  info.isDirectory() &&
  !info.isSymbolicLink() &&
  (info.mode & 0o777) === 0o700 &&
  info.uid === process.getuid?.();

/** Creates `path` (and parents when `recursive`) with mode 0700, then fails closed unless it is private. */
export async function ensurePrivateDirectory(
  path: string,
  unsafeMessage: string,
  options: { recursive?: boolean } = {},
): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: options.recursive ?? false }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    },
  );
  if (!isPrivateDirectory(await lstat(path))) throw new Error(unsafeMessage);
}
