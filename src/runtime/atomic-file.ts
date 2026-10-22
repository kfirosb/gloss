import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/**
 * Writes `content` to a new temporary file beside `path`, with exactly `mode`, and returns its path. The caller
 * moves it into place (rename or link) and removes it afterwards; a failed write leaves nothing behind.
 */
export async function writeTemporaryFile(
  path: string,
  content: string | Uint8Array,
  mode: number,
): Promise<string> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    await file.writeFile(content);
    // open() applies the umask; set the mode on the handle so the final file has it exactly.
    await file.chmod(mode);
    await file.sync();
    await file.close();
    return temporary;
  } catch (error) {
    await file.close();
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** Replaces `path` with `content` through a same-folder temporary file, leaving exactly `mode`. */
export async function writeFileAtomic(path: string, content: string, mode: number): Promise<void> {
  const temporary = await writeTemporaryFile(path, content, mode);
  try {
    await rename(temporary, path);
  } finally {
    // Already renamed on success; on failure this removes the temporary file.
    await unlink(temporary).catch(() => {});
  }
}
