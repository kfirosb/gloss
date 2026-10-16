import { mkdir, realpath, stat, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ConversationStore,
  ConversationSnapshot,
  ImageAttachment,
} from '../core/contracts.js';
import type { FileReference, FileReferenceStore, FileRegistry } from '../core/file-references.js';
import { selectFileReferences } from '../core/file-references.js';
import {
  ATTACHMENT_LIMIT_MESSAGE,
  IMAGE_LIMIT_MESSAGE,
  MAX_ATTACHMENTS,
  MAX_IMAGES,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_BASE64_CHARS,
  MAX_ATTACHMENT_NAME_CHARS,
} from '../core/content-policy.js';
import type { SessionStore } from '../core/session-contracts.js';
import { attachmentRoot, loadImage, imageMime } from './attachments.js';
import { readReferencePrefix, requireContained, validateFileReference } from './file-content.js';
import { searchFiles } from './file-search.js';
import { createFileBrowser } from './file-browser.js';
export interface RuntimeFileRegistry extends FileRegistry {
  importLegacyWorkspace(sessionId: string, ids: string[]): Promise<void>;
}
export function createFileRegistry(options: {
  store: ConversationStore & SessionStore & FileReferenceStore;
  attachmentRoot?: string;
  nestedWorktrees?: (root: string) => Promise<string[]>;
}): RuntimeFileRegistry {
  const store = options.store;
  const root = options.attachmentRoot ?? attachmentRoot;
  const nestedWorktrees = options.nestedWorktrees ?? (async () => []);
  const session = (id: string) => {
    const record = store.listSessions().find((record) => record.id === id);
    if (!record) throw new Error('Unknown session');
    return record;
  };
  const importImage = (id: string, image: ImageAttachment) =>
    store.registerFileReference({
      ...image,
      kind: 'image',
      sessionId: id,
      source: 'upload',
      worktreePath: session(id).canonicalRoot,
    });
  const snapshotImages = (snapshot: ConversationSnapshot | undefined) => [
    ...(snapshot?.discussion.flatMap((turn) => turn.attachments ?? []) ?? []),
    ...(snapshot?.currentDraft?.attachments ?? []),
    ...(snapshot?.composerDraft?.attachments ?? []),
    ...(snapshot?.deliveries.flatMap((delivery) => delivery.attachments ?? []) ?? []),
  ];
  const claimedElsewhere = (id: string, fileId: string) =>
    store.fileOwners(fileId).some((owner) => owner !== id) ||
    store
      .list()
      .some(
        (conversation) =>
          conversation.id !== id &&
          snapshotImages(store.load(conversation.id)).some((image) => image.id === fileId),
      );
  const importHistorical = (id: string) => {
    session(id);
    const snapshot = store.load(id);
    const images = snapshotImages(snapshot);
    // Reserve established Image N values before allocating numbers to unnumbered images.
    images.sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity));
    for (const image of images) if (!('sessionId' in image)) importImage(id, image);
  };
  const historical = (id: string) => {
    session(id);
    for (const record of store.listSessions()) importHistorical(record.id);
  };
  let restored: Promise<void> | undefined;
  const restore = (id: string) => {
    historical(id);
    restored ??= (async () => {
      for (const record of store.listSessions()) {
        const data = store.readWorkspace(record.id).data;
        for (const fileId of new Set([
          ...data.attachmentIds,
          ...(data.composerAttempt?.attachmentIds ?? []),
        ])) {
          if (store.fileOwners(fileId).length || claimedElsewhere(record.id, fileId)) continue;
          try {
            importImage(record.id, await loadImage(fileId, root));
          } catch {
            /* Missing old uploads remain explicit unavailable references. */
          }
        }
      }
    })();
    return restored;
  };
  const membership = (id: string, selected: string[]) =>
    selectFileReferences(store.listFileReferences(id), selected);
  const capacity = (id: string, kind: FileReference['kind'], existingId?: string) => {
    const selected = store.readWorkspace(id).data.attachmentIds;
    if (existingId && selected.includes(existingId)) return;
    if (selected.length >= MAX_ATTACHMENTS) throw new Error(ATTACHMENT_LIMIT_MESSAGE);
    if (
      kind === 'image' &&
      store
        .listFileReferences(id)
        .filter((file) => selected.includes(file.id) && file.kind === 'image').length >= MAX_IMAGES
    )
      throw new Error(IMAGE_LIMIT_MESSAGE);
  };
  const registry: RuntimeFileRegistry = {
    ...createFileBrowser((id) => session(id).canonicalRoot, nestedWorktrees),
    async upload(id, input) {
      await restore(id);
      if (
        !input ||
        typeof input.name !== 'string' ||
        !input.name.trim() ||
        input.name.length > MAX_ATTACHMENT_NAME_CHARS ||
        /[\\/\x00-\x1f\x7f]/.test(input.name) ||
        ['.', '..'].includes(input.name)
      )
        throw new Error('Invalid file name');
      if (
        typeof input.data !== 'string' ||
        input.data.length > MAX_UPLOAD_BASE64_CHARS ||
        input.data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)
      )
        throw new Error('Invalid base64 or file exceeds 10 MB');
      const bytes = Buffer.from(input.data, 'base64');
      if (bytes.length > MAX_UPLOAD_BYTES || bytes.toString('base64') !== input.data)
        throw new Error('Invalid base64 or file exceeds 10 MB');
      const detected = imageMime(bytes);
      if (
        (input.mime?.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(input.name)) &&
        !detected
      )
        throw new Error('Use a PNG, JPEG, WebP, or GIF image');
      const kind = detected ? 'image' : 'file';
      capacity(id, kind);
      const mime =
        detected ??
        (typeof input.mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(input.mime)
          ? input.mime
          : 'application/octet-stream');
      await mkdir(root, { recursive: true, mode: 0o700 });
      const managedRoot = await realpath(root);
      const fileId = randomUUID();
      const filePath = path.join(managedRoot, fileId);
      await writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 });
      try {
        capacity(id, kind);
        return store.registerFileReference({
          id: fileId,
          sessionId: id,
          kind,
          name: input.name,
          path: filePath,
          worktreePath: session(id).canonicalRoot,
          source: 'upload',
          mime,
          size: bytes.length,
        });
      } catch (error) {
        await unlink(filePath);
        throw error;
      }
    },
    async reference(id, relativePath) {
      await restore(id);
      if (
        typeof relativePath !== 'string' ||
        !relativePath ||
        relativePath.includes('\0') ||
        path.isAbsolute(relativePath)
      )
        throw new Error('Select a relative file path');
      if (!session(id).canonicalRoot) throw new Error('Session has no canonical worktree root');
      const canonicalRoot = await realpath(session(id).canonicalRoot);
      if (canonicalRoot !== session(id).canonicalRoot) throw new Error('Worktree path changed');
      const canonical = await realpath(path.resolve(canonicalRoot, relativePath));
      requireContained(canonicalRoot, canonical);
      const info = await stat(canonical);
      if (!info.isFile()) throw new Error('Only regular files can be attached');
      const existing = store
        .listFileReferences(id)
        .find((file) => file.source === 'worktree' && file.path === canonical);
      if (existing) {
        await validateFileReference(existing);
        return existing;
      }
      const file: FileReference = {
        id: randomUUID(),
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
      const detected = imageMime(await readReferencePrefix(file));
      if (detected) {
        file.kind = 'image';
        file.mime = detected;
      }
      capacity(id, file.kind);
      const { index: _unallocated, ...reference } = file;
      return store.registerFileReference(reference);
    },
    async resolve(id, ids) {
      await restore(id);
      const files = membership(id, ids);
      await Promise.all(files.map(validateFileReference));
      return files;
    },
    async search(id, query, signal) {
      if (!session(id).canonicalRoot) throw new Error('Session has no canonical worktree root');
      const canonicalRoot = await realpath(session(id).canonicalRoot);
      if (canonicalRoot !== session(id).canonicalRoot) throw new Error('Worktree path changed');
      const found = await searchFiles(
        canonicalRoot,
        query,
        signal,
        await nestedWorktrees(canonicalRoot),
      );
      const checked = await Promise.all(
        found.map(async (entry) => {
          signal.throwIfAborted();
          try {
            const canonical = await realpath(path.resolve(canonicalRoot, entry.relativePath));
            requireContained(canonicalRoot, canonical);
            return (await stat(canonical)).isFile() ? entry : null;
          } catch {
            return null;
          }
        }),
      );
      signal.throwIfAborted();
      return checked.filter((entry) => entry !== null);
    },
    async importLegacyWorkspace(id, ids) {
      await restore(id);
      const workspace = store.readWorkspace(id);
      const owned = store.listFileReferences(id);
      for (const fileId of [...new Set(ids)]) {
        if (owned.some((file) => file.id === fileId)) continue;
        // Only an untouched workspace can adopt old browser composer data. New uploads
        // have no legacy sidecar and cannot be claimed through arbitrary IDs.
        if (workspace.revision !== 0 || claimedElsewhere(id, fileId))
          throw new Error('Attachment does not belong to this session');
        const image = await loadImage(fileId, root);
        if (store.readWorkspace(id).revision !== 0 || claimedElsewhere(id, fileId))
          throw new Error('Attachment does not belong to this session');
        importImage(id, image);
      }
    },
  };
  return registry;
}
