import { MAX_TEXT_CHARS } from '../core/content-policy.js';
import { open, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { FileReference } from '../core/file-references.js';
export function requireContained(root: string, file: string): void {
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error('File is outside the selected worktree');
}
export async function validateFileReference(file: FileReference): Promise<void> {
  if (file.source === 'worktree') {
    if (!file.worktreePath || !file.originalPath)
      throw new Error('File has no registered worktree');
    const root = await realpath(file.worktreePath);
    if (root !== file.worktreePath) throw new Error('Worktree path changed');
    const current = await realpath(path.resolve(root, file.originalPath));
    requireContained(root, current);
    if (current !== file.path) throw new Error('Referenced file path changed; select it again');
  } else if ((await realpath(file.path)) !== file.path)
    throw new Error('Uploaded file path changed');
  if (!(await stat(file.path)).isFile()) throw new Error('Only regular files can be attached');
}
async function openReference(file: FileReference) {
  await validateFileReference(file);
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    const current = await stat(file.path);
    await validateFileReference(file);
    if (!info.isFile() || info.dev !== current.dev || info.ino !== current.ino)
      throw new Error('Referenced file changed while opening');
    return { handle, info };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
export async function readReferencePrefix(file: FileReference, length = 16): Promise<Buffer> {
  const { handle } = await openReference(file);
  try {
    const prefix = Buffer.alloc(length);
    const { bytesRead } = await handle.read(prefix, 0, length, 0);
    await validateFileReference(file);
    return prefix.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
// Stream a finite snapshot of the file's size with constant per-read memory. An
// expanding file cannot keep a download or context extraction running forever.
export async function* readReferenceChunks(file: FileReference): AsyncGenerator<Buffer> {
  const { handle, info } = await openReference(file);
  try {
    let position = 0;
    while (position < info.size) {
      const chunk = Buffer.alloc(Math.min(65536, info.size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) throw new Error('Referenced file changed while reading');
      position += bytesRead;
      yield chunk.subarray(0, bytesRead);
    }
    const after = await handle.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs)
      throw new Error('Referenced file changed while reading');
  } finally {
    await handle.close();
    // Also runs when a binary prefix or cancellation ends iteration early.
    await validateFileReference(file);
  }
}
export async function readFileContext(
  files: FileReference[],
): Promise<{ id: string; index: number; text?: string; unreadable?: string }[]> {
  const result: { id: string; index: number; text?: string; unreadable?: string }[] = [];
  let count = 0;
  for (const file of files) {
    await validateFileReference(file);
    let unreadable = file.kind === 'image';
    let text = '';
    let decodedLength = 0;
    const retainWithinBudget = (decoded: string) => {
      decodedLength += decoded.length;
      // Continue classification after overflow, retaining no over-budget input.
      // A later binary marker takes precedence over a text-only size failure.
      if (count + decodedLength <= MAX_TEXT_CHARS) text += decoded;
      else text = '';
    };
    const decoder = new TextDecoder('utf-8', { fatal: true });
    if (!unreadable) {
      for await (const bytes of readReferenceChunks(file)) {
        if (bytes.includes(0)) {
          unreadable = true;
          break;
        }
        try {
          retainWithinBudget(decoder.decode(bytes, { stream: true }));
        } catch {
          unreadable = true;
          break;
        }
      }
      if (!unreadable) {
        try {
          retainWithinBudget(decoder.decode());
        } catch {
          unreadable = true;
        }
      }
    }
    if (unreadable) {
      result.push({
        id: file.id,
        index: file.index,
        unreadable: 'Unsupported binary or invalid UTF-8 content',
      });
      continue;
    }
    count += decodedLength;
    if (count > MAX_TEXT_CHARS)
      throw new Error(`Attached text exceeds the cumulative ${MAX_TEXT_CHARS} character limit`);
    result.push({ id: file.id, index: file.index, text });
  }
  return result;
}
