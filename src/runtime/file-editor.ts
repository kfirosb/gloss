import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { MAX_EDITABLE_FILE_BYTES, MAX_EDITABLE_FILE_LABEL } from '../core/content-policy.js';
import type { EditableFile, FileEditConflictCode, SavedFile } from '../core/file-edits.js';
import { requireContained } from './file-content.js';
import { writeTemporaryFile } from './atomic-file.js';

/** A refusal the UI can act on: the file changed on disk, or a create named a taken path. */
export class FileEditConflict extends Error {
  constructor(
    message: string,
    readonly code: FileEditConflictCode,
  ) {
    super(message);
  }
}
/** Mode for files the user creates (rw-r--r--), the usual umask result for new files. */
const NEW_FILE_MODE = 0o644;
const NEW_FOLDER_MODE = 0o755;
const MAX_PATH_CHARS = 4096;
const tooLarge = () => new Error(`Editing is limited to ${MAX_EDITABLE_FILE_LABEL} of text`);
const versionOf = (bytes: Uint8Array) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
const missing = (error: unknown) => (error as { code?: unknown })?.code === 'ENOENT';

/**
 * The lexical path segments of an edit target. Stricter than reading: every segment must be a plain name, so
 * `..`, `.`, empty segments and absolute paths are refused before the path is resolved, and nothing inside a
 * `.git` folder or file (repositories and worktrees) can be written.
 */
function editSegments(relativePath: unknown): string[] {
  if (
    typeof relativePath !== 'string' ||
    !relativePath ||
    relativePath.length > MAX_PATH_CHARS ||
    relativePath.includes('\0') ||
    path.isAbsolute(relativePath)
  )
    throw new Error('Select a relative file path');
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    throw new Error('File is outside the selected worktree');
  // Case-insensitive: the default macOS volume treats .GIT as .git.
  if (segments.some((segment) => segment.toLowerCase() === '.git'))
    throw new Error('Files inside .git cannot be edited');
  return segments;
}
/** A folder on the way to the target: a real directory, never a symbolic link that could lead elsewhere. */
function requireRealFolder(info: Stats) {
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error('Files can only be edited inside real folders of the session');
}
/** Reads a regular file without following a final symbolic link, refusing anything over the edit limit. */
async function readBytes(file: string): Promise<{ bytes: Buffer; info: Stats }> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Only regular files can be edited');
    if (info.size > MAX_EDITABLE_FILE_BYTES) throw tooLarge();
    const bytes = await handle.readFile();
    if (bytes.length > MAX_EDITABLE_FILE_BYTES) throw tooLarge();
    return { bytes, info };
  } finally {
    await handle.close();
  }
}
function decodeText(bytes: Uint8Array): string {
  try {
    if (bytes.includes(0)) throw new Error();
    // ignoreBOM keeps a byte-order mark in the text, so saving writes it back.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error('Only UTF-8 text files can be edited');
  }
}
function encodeText(text: unknown): Buffer {
  if (typeof text !== 'string') throw new Error('Invalid file text');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_EDITABLE_FILE_BYTES) throw tooLarge();
  return bytes;
}

/**
 * Edits and creates text files inside a session's folder. Paths are scoped like the read endpoints (relative,
 * contained in the canonical session root) and, because a write follows links, more strictly: the target and every
 * folder on the way must be real entries below the root, never symbolic links. File contents are never logged.
 */
export function createFileEditor(sessionRoot: (id: string) => string) {
  async function root(id: string) {
    const registered = sessionRoot(id);
    if (!registered) throw new Error('Session has no canonical worktree root');
    const current = await realpath(registered);
    if (current !== registered) throw new Error('Worktree path changed');
    return current;
  }
  /** Resolves the target lexically and checks each existing folder on the way; `create` makes missing ones. */
  async function target(id: string, relativePath: unknown, create: boolean) {
    const segments = editSegments(relativePath);
    const canonicalRoot = await root(id);
    const file = path.join(canonicalRoot, ...segments);
    requireContained(canonicalRoot, file);
    let folder = canonicalRoot;
    for (const segment of segments.slice(0, -1)) {
      folder = path.join(folder, segment);
      try {
        requireRealFolder(await lstat(folder));
      } catch (error) {
        if (!create || !missing(error)) throw error;
        await mkdir(folder, { mode: NEW_FOLDER_MODE }).catch((reason: unknown) => {
          if ((reason as { code?: unknown })?.code !== 'EEXIST') throw reason;
        });
        // Re-checked after creating: a concurrent link in its place is refused.
        requireRealFolder(await lstat(folder));
      }
    }
    await requireParent(canonicalRoot, file);
    return file;
  }
  /** The folder holding the target resolves to itself inside the root, so no link redirects the write. */
  async function requireParent(canonicalRoot: string, file: string) {
    const parent = path.dirname(file);
    const resolved = await realpath(parent);
    if (resolved !== parent) throw new Error('Files can only be edited inside real folders');
    requireContained(canonicalRoot, resolved);
  }
  async function current(file: string) {
    const entry = await lstat(file);
    if (entry.isSymbolicLink()) throw new Error('Symbolic links cannot be edited here');
    if (!entry.isFile()) throw new Error('Only regular files can be edited');
    return readBytes(file);
  }
  return {
    async readEditable(id: string, relativePath: string): Promise<EditableFile> {
      const file = await target(id, relativePath, false);
      const { bytes } = await current(file);
      return { relativePath, text: decodeText(bytes), version: versionOf(bytes) };
    },
    /**
     * Replaces an existing file only when it still holds the version the edit started from. The new content goes
     * to a temporary file in the same folder with the file's permissions, then is renamed over the original.
     */
    async saveFile(
      id: string,
      relativePath: string,
      text: unknown,
      baseVersion: unknown,
    ): Promise<SavedFile> {
      if (typeof baseVersion !== 'string' || !baseVersion) throw new Error('Invalid file version');
      const bytes = encodeText(text);
      const file = await target(id, relativePath, false);
      const unchanged = async () => {
        const { bytes: before, info } = await current(file);
        if (versionOf(before) !== baseVersion)
          throw new FileEditConflict(
            'The file changed on disk since you opened it',
            'file-changed',
          );
        return info;
      };
      const info = await unchanged();
      const temporary = await writeTemporaryFile(file, bytes, info.mode & 0o777);
      try {
        // Checked again just before the swap, narrowing the window for an agent's write to be replaced.
        await unchanged();
        await requireParent(await root(id), file);
        await rename(temporary, file);
      } finally {
        await unlink(temporary).catch(() => {});
      }
      return { relativePath, version: versionOf(bytes) };
    },
    /**
     * Creates a new file (and any missing folders) without ever replacing an existing entry: the content is linked
     * into place from a temporary file, which fails when the name is already taken.
     */
    async createFile(id: string, relativePath: string, text: unknown): Promise<SavedFile> {
      const bytes = encodeText(text);
      const file = await target(id, relativePath, true);
      const taken = () =>
        new FileEditConflict('A file or folder with this name already exists', 'file-exists');
      try {
        await lstat(file);
        throw taken();
      } catch (error) {
        if (!missing(error)) throw error;
      }
      const temporary = await writeTemporaryFile(file, bytes, NEW_FILE_MODE);
      try {
        await requireParent(await root(id), file);
        await link(temporary, file).catch((error: unknown) => {
          throw (error as { code?: unknown })?.code === 'EEXIST' ? taken() : error;
        });
      } finally {
        await unlink(temporary).catch(() => {});
      }
      return { relativePath, version: versionOf(bytes) };
    },
  };
}
