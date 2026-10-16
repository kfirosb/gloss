import {
  MAX_TEXT_FILE_BYTES,
  MAX_TEXT_CHARS,
  MAX_IMAGE_PREVIEW_BYTES,
  MAX_MEDIA_PREVIEW_BYTES,
  MAX_MEDIA_PREVIEW_LABEL,
  MEDIA_MIME_TYPES,
} from '../core/content-policy.js';
import { opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  BrowserPage,
  BrowserSearch,
  FilePreview,
  FileReference,
} from '../core/file-references.js';
import { readReferencePrefix, readReferenceChunks, requireContained } from './file-content.js';
import { imageMime } from './attachments.js';
import { fileInventory } from './file-search.js';
const TEXT_BYTES = 128 * 1024;
const guidance =
  'Search respects ignore files and excludes .git, node_modules, dist, build and nested worktrees. Up to 50 matches; content scans up to 200 files, the first 128 KiB per file, within 2 seconds. Large and unreadable files may be skipped.';
/** `nestedWorktrees(root)` returns worktree folders under the root (relative); browsing and search skip them. */
export function createFileBrowser(
  sessionRoot: (id: string) => string,
  nestedWorktrees: (root: string) => Promise<string[]> = async () => [],
) {
  async function root(id: string) {
    const registered = sessionRoot(id);
    if (!registered) throw new Error('Session has no canonical worktree root');
    const current = await realpath(registered);
    if (current !== registered) throw new Error('Worktree path changed');
    return current;
  }
  async function lookup(id: string, relativePath: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (
      typeof relativePath !== 'string' ||
      relativePath.includes('\0') ||
      path.isAbsolute(relativePath)
    )
      throw new Error('Select a relative file path');
    const canonicalRoot = await root(id);
    requireContained(canonicalRoot, path.resolve(canonicalRoot, relativePath));
    const canonical = await realpath(path.resolve(canonicalRoot, relativePath));
    requireContained(canonicalRoot, canonical);
    const info = await stat(canonical);
    signal.throwIfAborted();
    return { canonicalRoot, canonical, info };
  }
  async function preview(
    id: string,
    relativePath: string,
    signal: AbortSignal,
    includeImageData = true,
  ): Promise<FilePreview> {
    const { canonicalRoot, canonical, info } = await lookup(id, relativePath, signal);
    if (!info.isFile()) throw new Error('Only regular files can be previewed');
    const file: FileReference = {
      id: 'preview',
      sessionId: id,
      index: 0,
      kind: 'file',
      name: path.basename(relativePath),
      path: canonical,
      originalPath: relativePath,
      worktreePath: canonicalRoot,
      source: 'worktree',
      mime: 'application/octet-stream',
      size: info.size,
    };
    const base = {
      name: file.name,
      relativePath,
      size: info.size,
      version: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`,
    };
    const prefix = await readReferencePrefix(file, Math.min(TEXT_BYTES, info.size));
    signal.throwIfAborted();
    const mime = imageMime(prefix);
    if (mime) {
      // Content searches classify raster files without reading/encoding their payload.
      if (!includeImageData) return { ...base, state: 'image' };
      if (info.size > MAX_IMAGE_PREVIEW_BYTES) return { ...base, state: 'large' };
      const bytes = await readReferencePrefix(file, info.size);
      signal.throwIfAborted();
      return {
        ...base,
        state: 'image',
        dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
      };
    }
    const truncated = info.size > prefix.length;
    try {
      if (prefix.includes(0)) return { ...base, state: 'binary' };
      const text = new TextDecoder('utf-8', { fatal: true }).decode(prefix, { stream: truncated });
      return { ...base, state: 'text', text, truncated };
    } catch {
      return { ...base, state: 'binary' };
    }
  }
  return {
    preview,
    async reviewText(id: string, relativePath: string, signal: AbortSignal) {
      const { canonicalRoot, canonical, info } = await lookup(id, relativePath, signal);
      if (!info.isFile()) throw new Error('Select a readable text file');
      if (info.size > MAX_TEXT_FILE_BYTES)
        throw new Error(`File review supports at most ${MAX_TEXT_CHARS} characters`);
      const file: FileReference = {
        id: 'file-review',
        sessionId: id,
        index: 0,
        kind: 'file',
        name: path.basename(relativePath),
        path: canonical,
        originalPath: relativePath,
        worktreePath: canonicalRoot,
        source: 'worktree',
        mime: 'text/plain',
        size: info.size,
      };
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of readReferenceChunks(file)) {
        signal.throwIfAborted();
        size += chunk.length;
        if (size > MAX_TEXT_FILE_BYTES)
          throw new Error(`File review supports at most ${MAX_TEXT_CHARS} characters`);
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      signal.throwIfAborted();
      let text: string;
      try {
        if (bytes.includes(0)) throw new Error();
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new Error('File review requires readable UTF-8 text');
      }
      if (!text.trim()) throw new Error('File is empty');
      if (text.length > MAX_TEXT_CHARS)
        throw new Error(`File review supports at most ${MAX_TEXT_CHARS} characters`);
      const current = await lookup(id, relativePath, signal);
      const version = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
      if (
        current.canonical !== canonical ||
        `${current.info.dev}:${current.info.ino}:${current.info.size}:${current.info.mtimeMs}` !==
          version
      )
        throw new Error('File changed; reopen the preview');
      return { text, version };
    },
    async media(id: string, relativePath: string, signal: AbortSignal): Promise<FileReference> {
      const { canonicalRoot, canonical, info } = await lookup(id, relativePath, signal);
      const mime = MEDIA_MIME_TYPES[path.extname(canonical).toLowerCase()];
      if (!info.isFile() || !mime) throw new Error('Only supported media files can be played');
      if (info.size > MAX_MEDIA_PREVIEW_BYTES)
        throw new Error(`Media preview is limited to ${MAX_MEDIA_PREVIEW_LABEL} per file`);
      return {
        id: 'preview-media',
        sessionId: id,
        index: 0,
        kind: 'file',
        name: path.basename(relativePath),
        path: canonical,
        originalPath: relativePath,
        worktreePath: canonicalRoot,
        source: 'worktree',
        mime,
        size: info.size,
      };
    },
    async browse(
      id: string,
      relativePath: string,
      offset: number,
      signal: AbortSignal,
    ): Promise<BrowserPage> {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
        throw new Error('Invalid folder offset');
      const selected = await lookup(id, relativePath, signal);
      if (!selected.info.isDirectory()) throw new Error('Select a directory');
      const skipped = new Set(
        (await nestedWorktrees(selected.canonicalRoot)).map((p) => path.normalize(p)),
      );
      signal.throwIfAborted();
      const entries: BrowserPage['entries'] = [];
      let scanned = 0;
      let nextOffset: number | undefined;
      const deadline = Date.now() + 2000;
      for await (const entry of await opendir(selected.canonical)) {
        signal.throwIfAborted();
        if (scanned++ < offset) {
          if (Date.now() > deadline) throw new Error('Directory scan timed out');
          continue;
        }
        if (entries.length === 100 || Date.now() > deadline || scanned > 100000) {
          nextOffset = scanned - 1;
          break;
        }
        const child = path.join(relativePath, entry.name);
        if (skipped.has(path.normalize(child))) continue;
        try {
          const checked = await lookup(id, child, signal);
          if (checked.info.isFile() || checked.info.isDirectory())
            entries.push({
              name: entry.name,
              relativePath: child,
              kind: checked.info.isDirectory() ? 'directory' : 'file',
            });
        } catch {
          signal.throwIfAborted();
        }
      }
      const after = await lookup(id, relativePath, signal);
      if (
        after.canonical !== selected.canonical ||
        after.info.ino !== selected.info.ino ||
        after.info.dev !== selected.info.dev
      )
        throw new Error('Directory changed while browsing');
      entries.sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1,
      );
      return {
        entries,
        ...(nextOffset !== undefined && nextOffset < 100000 ? { nextOffset } : {}),
        limited: nextOffset !== undefined,
      };
    },
    async find(
      id: string,
      query: string,
      mode: 'name' | 'content',
      signal: AbortSignal,
    ): Promise<BrowserSearch> {
      signal.throwIfAborted();
      if (typeof query !== 'string' || query.length > 1000 || !['name', 'content'].includes(mode))
        throw new Error('Invalid search');
      const canonicalRoot = await root(id);
      const inventory = await fileInventory(
        canonicalRoot,
        signal,
        await nestedWorktrees(canonicalRoot),
      );
      const normalizedQuery = query.toLocaleLowerCase();
      const entries: BrowserSearch['entries'] = [];
      let limited = inventory.limited;
      let scanned = 0;
      const deadline = Date.now() + 2000;
      for (const relativePath of inventory.paths) {
        signal.throwIfAborted();
        if (
          entries.length >= 50 ||
          Date.now() > deadline ||
          (mode === 'content' && scanned >= 200)
        ) {
          limited = true;
          break;
        }
        if (mode === 'name' && !relativePath.toLocaleLowerCase().includes(normalizedQuery))
          continue;
        scanned++;
        try {
          const checked = await lookup(id, relativePath, signal);
          if (!checked.info.isFile()) continue;
          if (mode === 'content') {
            const content = await preview(id, relativePath, signal, false);
            if (content.truncated || content.state !== 'text') limited = true;
            if (
              content.state !== 'text' ||
              !content.text?.toLocaleLowerCase().includes(normalizedQuery)
            )
              continue;
          }
          entries.push({ name: path.basename(relativePath), relativePath });
        } catch {
          signal.throwIfAborted();
          limited = true;
        }
      }
      return { entries, limited, guidance };
    },
  };
}
