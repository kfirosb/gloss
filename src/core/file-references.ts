import {
  ATTACHMENT_LIMIT_MESSAGE,
  DISTINCT_ATTACHMENT_LIMIT_MESSAGE,
  IMAGE_LIMIT_MESSAGE,
  MAX_ATTACHMENTS,
  MAX_IMAGES,
} from './content-policy.js';

export interface FileReference {
  id: string;
  sessionId: string;
  kind: 'file' | 'image';
  index: number;
  name: string;
  path: string;
  originalPath?: string;
  worktreePath: string;
  source: 'upload' | 'worktree';
  mime: string;
  size: number;
}
export interface BrowserEntry {
  name: string;
  relativePath: string;
  kind: 'file' | 'directory';
}
export interface BrowserPage {
  entries: BrowserEntry[];
  nextOffset?: number;
  limited: boolean;
}
export interface FilePreview {
  name: string;
  relativePath: string;
  size: number;
  version?: string;
  state: 'text' | 'image' | 'binary' | 'large';
  text?: string;
  dataUrl?: string;
  truncated?: boolean;
}
/** The absolute, symlink-resolved location of an entry inside a session's folder. */
export interface FileLocation {
  path: string;
  kind: 'file' | 'directory';
}
export interface BrowserSearch {
  entries: { name: string; relativePath: string }[];
  limited: boolean;
  guidance: string;
}
export interface FileRegistry {
  reviewText(
    sessionId: string,
    relativePath: string,
    signal: AbortSignal,
  ): Promise<{ text: string; version: string }>;
  media(sessionId: string, relativePath: string, signal: AbortSignal): Promise<FileReference>;
  browse(
    sessionId: string,
    relativePath: string,
    offset: number,
    signal: AbortSignal,
  ): Promise<BrowserPage>;
  preview(sessionId: string, relativePath: string, signal: AbortSignal): Promise<FilePreview>;
  locate(sessionId: string, relativePath: string, signal: AbortSignal): Promise<FileLocation>;
  find(
    sessionId: string,
    query: string,
    mode: 'name' | 'content',
    signal: AbortSignal,
  ): Promise<BrowserSearch>;
  upload(
    sessionId: string,
    input: { name: string; data: string; mime?: string },
  ): Promise<FileReference>;
  reference(sessionId: string, relativePath: string): Promise<FileReference>;
  resolve(sessionId: string, ids: string[]): Promise<FileReference[]>;
  search(
    sessionId: string,
    query: string,
    signal: AbortSignal,
  ): Promise<{ relativePath: string; name: string }[]>;
}
export interface FileReferenceStore {
  listFileReferences(sessionId: string): FileReference[];
  registerFileReference(file: Omit<FileReference, 'index'> & { index?: number }): FileReference;
  fileOwners(id: string): string[];
}
/** Resolves an ordered selection against one session's registry, preserving ownership checks. */
export function selectFileReferences(
  owned: readonly FileReference[],
  ids: readonly string[],
): FileReference[] {
  if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS)
    throw new Error(ATTACHMENT_LIMIT_MESSAGE);
  if (new Set(ids).size !== ids.length) throw new Error(DISTINCT_ATTACHMENT_LIMIT_MESSAGE);
  const byId = new Map(owned.map((file) => [file.id, file]));
  const selected = ids.map((id) => {
    const file = byId.get(id);
    if (!file) throw new Error('Attachment does not belong to this session');
    return file;
  });
  if (selected.filter((file) => file.kind === 'image').length > MAX_IMAGES)
    throw new Error(IMAGE_LIMIT_MESSAGE);
  return selected;
}
export function attachmentManifest(files: FileReference[]): string {
  if (!files.length) return '';
  const lines = files.map(
    (file) =>
      `${file.kind === 'image' ? 'Image' : 'File'} ${file.index}: name=${JSON.stringify(file.name)} path=${JSON.stringify(file.path)} worktree=${JSON.stringify(file.worktreePath)}`,
  );
  return [
    'References:',
    ...lines,
    'Read the referenced files and inspect referenced images before responding.',
  ].join('\n');
}

/** Legacy images remain readable in persisted snapshots and pending receipts. */
export function isFileReference(file: import('./contracts.js').Attachment): file is FileReference {
  return 'sessionId' in file;
}
export function uniqueReferences<T extends import('./contracts.js').Attachment>(files: T[]): T[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = JSON.stringify([isFileReference(file) ? file.sessionId : '', file.id]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
