import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/** Replaces `path` with `content` through a same-folder temporary file, leaving exactly `mode`. */
export async function writeFileAtomic(path: string, content: string, mode: number): Promise<void> {
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
    await rename(temporary, path);
  } finally {
    await file.close();
    // Already renamed on success; on failure this removes the partial file.
    await unlink(temporary).catch(() => {});
  }
}
