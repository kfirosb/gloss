import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, unlink, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { createFileRegistry } from '../../src/runtime/file-registry.js';
import * as fileContent from '../../src/runtime/file-content.js';
import { readFileContext } from '../../src/runtime/file-content.js';
import { attachmentManifest } from '../../src/core/file-references.js';
import { defaultWorkspace } from '../../src/core/session-contracts.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'file-registry-')));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const roots = { A: join(dir, 'A'), B: join(dir, 'B') };
  for (const [id, root] of Object.entries(roots)) {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/app.ts'), id);
  }
  const db = join(dir, 'store.db');
  let store = new SqliteStore(db);
  for (const [id, root] of Object.entries(roots))
    store.registerSession({
      id,
      target: { agent: 'codex', sessionRef: id, projectId: root },
      canonicalRoot: root,
      projectName: id,
      enabled: true,
    });
  const uploads = join(dir, 'uploads');
  let registry = createFileRegistry({ store, attachmentRoot: uploads });
  cleanup.push(async () => store.close());
  return {
    dir,
    roots,
    uploads,
    get store() {
      return store;
    },
    get registry() {
      return registry;
    },
    reopen() {
      store.close();
      store = new SqliteStore(db);
      registry = createFileRegistry({ store, attachmentRoot: uploads });
    },
  };
}
it('indexes per session, reuses canonical references and retains counters after workspace removal and reopen', async () => {
  const f = await fixture();
  const a = await f.registry.reference('A', 'src/app.ts');
  expect(a).toMatchObject({
    kind: 'file',
    index: 1,
    source: 'worktree',
    originalPath: 'src/app.ts',
  });
  expect(await f.registry.reference('A', 'src/../src/app.ts')).toEqual(a);
  expect(await f.registry.reference('B', 'src/app.ts')).toMatchObject({
    index: 1,
    path: join(f.roots.B, 'src/app.ts'),
  });
  await expect(f.registry.resolve('B', [a.id])).rejects.toThrow('belong');
  f.store.writeWorkspace('A', 0, { ...defaultWorkspace(), attachmentIds: [a.id] });
  f.store.writeWorkspace('A', 1, defaultWorkspace());
  f.reopen();
  const next = await f.registry.upload('A', {
    name: 'Unicode space \u05e9.txt',
    data: Buffer.from('content').toString('base64'),
  });
  expect(next.index).toBe(2);
  expect(next.originalPath).toBeUndefined();
  expect(next.path.startsWith(f.uploads)).toBe(true);
  expect((await stat(next.path)).mode & 0o777).toBe(0o600);
  expect(attachmentManifest([a, next])).toContain('File 2');
  expect((await readFileContext([a, next])).map((x) => x.text)).toEqual(['A', 'content']);
});
it('rejects escapes, external symlinks, retargeting, missing files and directories', async () => {
  const f = await fixture();
  await symlink(join(f.roots.B, 'src/app.ts'), join(f.roots.A, 'outside'));
  for (const p of ['../B/src/app.ts', 'outside', 'missing', 'src'])
    await expect(f.registry.reference('A', p)).rejects.toThrow();
  await symlink(join(f.roots.A, 'src/app.ts'), join(f.roots.A, 'selected'));
  const file = await f.registry.reference('A', 'selected');
  await unlink(join(f.roots.A, 'selected'));
  await symlink(join(f.roots.B, 'src/app.ts'), join(f.roots.A, 'selected'));
  await expect(f.registry.resolve('A', [file.id])).rejects.toThrow();
  await expect(readFileContext([file])).rejects.toThrow();
});
it('validates names, base64, size, image magic and composer bounds', async () => {
  const f = await fixture();
  for (const input of [
    { name: '../x', data: 'YQ==' },
    { name: 'x'.repeat(161), data: 'YQ==' },
    { name: 'x', data: 'Y===' },
    { name: 'x', data: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') },
    { name: 'x.png', mime: 'image/png', data: 'YQ==' },
  ])
    await expect(f.registry.upload('A', input)).rejects.toThrow();
  const files = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      f.registry.upload('A', { name: `${i}.txt`, data: 'YQ==' }),
    ),
  );
  f.store.writeWorkspace('A', 0, { ...defaultWorkspace(), attachmentIds: files.map((x) => x.id) });
  await expect(f.registry.upload('A', { name: 'extra', data: 'YQ==' })).rejects.toThrow('10');
  expect(() =>
    f.store.writeWorkspace('B', 0, { ...defaultWorkspace(), attachmentIds: [files[0]!.id] }),
  ).toThrow('belong');
});
it('reports binary and invalid UTF-8 honestly and rejects cumulative text overflow', async () => {
  const f = await fixture();
  const files = [];
  for (const bytes of [Buffer.from([0, 1]), Buffer.from([0xff]), Buffer.from('x'.repeat(80001))])
    files.push(await f.registry.upload('A', { name: 'data', data: bytes.toString('base64') }));
  expect(await readFileContext(files.slice(0, 2))).toEqual(
    files.slice(0, 2).map((x) => ({ id: x.id, index: x.index, unreadable: expect.any(String) })),
  );
  await expect(readFileContext([files[2]!, files[2]!])).rejects.toThrow('160000');
});
it('searches only the registered root with ignores, substring matching and cancellation', async () => {
  const f = await fixture();
  await writeFile(join(f.roots.A, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(f.roots.A, 'ignored.txt'), 'hidden');
  await mkdir(join(f.roots.A, 'node_modules'));
  await writeFile(join(f.roots.A, 'node_modules/app.ts'), 'hidden');
  expect(await f.registry.search('A', 'app', new AbortController().signal)).toEqual([
    { relativePath: 'src/app.ts', name: 'app.ts' },
  ]);
  expect(await f.registry.search('A', 'ignored', new AbortController().signal)).toEqual([]);
  const controller = new AbortController();
  controller.abort();
  await expect(f.registry.search('A', '', controller.signal)).rejects.toThrow();
});
it('imports historical image numbers and prepared membership before allowing legacy composer adoption', async () => {
  const f = await fixture();
  const { saveImage } = await import('../../src/runtime/attachments.js');
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const old = await saveImage({ name: 'old.png', data: png }, f.uploads);
  const other = await saveImage({ name: 'composer.png', data: png }, f.uploads);
  const target = { agent: 'codex' as const, sessionRef: 'A', projectId: f.roots.A };
  f.store.save({
    id: 'A',
    target,
    codingState: 'idle',
    codingMessages: [],
    discussion: [{ role: 'user', text: 'Image 7', attachments: [{ ...old, index: 7 }] }],
    deliveries: [],
    language: 'he',
    languageSessionId: 'l',
    languageModel: 'm',
    sourceRevision: 0,
    currentDraft: {
      id: 'd',
      revision: 1,
      target,
      sourceRevision: 0,
      language: 'he',
      localizedText: 'Image 7',
      englishText: 'Image 7',
      attachments: [{ ...old, index: 7 }],
    },
  });
  f.reopen();
  await expect(f.registry.importLegacyWorkspace('B', [old.id])).rejects.toThrow('belong');
  expect(await f.registry.resolve('A', [old.id])).toEqual([
    expect.objectContaining({ id: old.id, index: 7, kind: 'image' }),
  ]);
  expect(f.store.load('A')?.currentDraft?.attachments).toEqual([
    expect.objectContaining({ id: old.id, index: 7 }),
  ]);
  await f.registry.importLegacyWorkspace('A', [other.id]);
  expect(await f.registry.resolve('A', [other.id])).toEqual([
    expect.objectContaining({ index: 8 }),
  ]);
  f.store.writeWorkspace('A', 0, { ...defaultWorkspace(), attachmentIds: [other.id] });
  f.reopen();
  await expect(f.registry.importLegacyWorkspace('B', [other.id])).rejects.toThrow('belong');
  const next = await f.registry.upload('A', { name: 'new.png', data: png });
  expect(next.index).toBe(9);
});
it('accepts the full 10 MB upload bound without rejecting valid base64', async () => {
  const f = await fixture();
  const bytes = Buffer.alloc(10 * 1024 * 1024, 97);
  expect(
    await f.registry.upload('A', { name: 'large.txt', data: bytes.toString('base64') }),
  ).toMatchObject({ size: bytes.length });
});
it('enforces four images per composer and allows explicit historical ownership of shared bytes', async () => {
  const f = await fixture();
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const files = await Promise.all(
    Array.from({ length: 5 }, () => f.registry.upload('A', { name: 'image.png', data: png })),
  );
  await expect(
    f.registry.resolve(
      'A',
      files.map((file) => file.id),
    ),
  ).rejects.toThrow('4');
  expect(() =>
    f.store.writeWorkspace('A', 0, {
      ...defaultWorkspace(),
      attachmentIds: files.map((file) => file.id),
    }),
  ).toThrow('4');
  f.store.writeWorkspace('A', 0, {
    ...defaultWorkspace(),
    attachmentIds: files.slice(0, 4).map((file) => file.id),
  });
  await expect(f.registry.upload('A', { name: 'extra.png', data: png })).rejects.toThrow('4');
  const shared = files[0]!;
  f.store.registerFileReference({ ...shared, sessionId: 'B' });
  expect(await f.registry.resolve('B', [shared.id])).toEqual([
    expect.objectContaining({ sessionId: 'B', path: shared.path }),
  ]);
});
it('does not adopt a legacy image concurrently into two sessions', async () => {
  const f = await fixture();
  const { saveImage } = await import('../../src/runtime/attachments.js');
  const image = await saveImage(
    {
      name: 'legacy.png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    },
    f.uploads,
  );
  const results = await Promise.allSettled(
    ['A', 'B'].map((id) => f.registry.importLegacyWorkspace(id, [image.id])),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(f.store.fileOwners(image.id)).toHaveLength(1);
});
it('never falls back to cwd for missing roots and keeps other sessions usable', async () => {
  const f = await fixture();
  f.store.registerSession({
    id: 'missing-root',
    target: { agent: 'codex', sessionRef: 'missing-root', projectId: f.roots.A },
    canonicalRoot: '',
    projectName: 'Unavailable',
    enabled: false,
  });
  await expect(f.registry.reference('missing-root', 'package.json')).rejects.toThrow('canonical');
  await expect(f.registry.search('missing-root', '', new AbortController().signal)).rejects.toThrow(
    'canonical',
  );
  expect(await f.registry.reference('A', 'src/app.ts')).toMatchObject({ index: 1 });
});
it('reserves historical membership even before an old conversation is registered as a panel session', async () => {
  const f = await fixture();
  const { saveImage } = await import('../../src/runtime/attachments.js');
  const image = await saveImage(
    {
      name: 'legacy.png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    },
    f.uploads,
  );
  f.store.save({
    id: 'unregistered',
    target: { agent: 'codex', sessionRef: 'old', projectId: f.roots.A },
    codingState: 'idle',
    codingMessages: [],
    discussion: [{ role: 'user', text: 'old image', attachments: [image] }],
    deliveries: [],
    language: 'he',
    languageSessionId: 'l',
    languageModel: 'm',
    sourceRevision: 0,
  });
  await expect(f.registry.importLegacyWorkspace('B', [image.id])).rejects.toThrow('belong');
});
it('classifies worktree images by magic and enforces image membership limits', async () => {
  const f = await fixture();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  const files = [];
  for (let i = 0; i < 5; i++) {
    await writeFile(join(f.roots.A, `picture-${i}.dat`), png);
    files.push(await f.registry.reference('A', `picture-${i}.dat`));
  }
  expect(files[0]).toMatchObject({
    kind: 'image',
    mime: 'image/png',
    index: 1,
    source: 'worktree',
  });
  await expect(
    f.registry.resolve(
      'A',
      files.map((file) => file.id),
    ),
  ).rejects.toThrow('4');
  f.store.writeWorkspace('A', 0, {
    ...defaultWorkspace(),
    attachmentIds: files.slice(0, 4).map((file) => file.id),
  });
  await writeFile(join(f.roots.A, 'extra.png'), png);
  await expect(f.registry.reference('A', 'extra.png')).rejects.toThrow('4');
});
it('returns unreadable for a worktree binary larger than the upload bound and streams UTF-8 safely', async () => {
  const f = await fixture();
  await writeFile(join(f.roots.A, 'large.bin'), Buffer.alloc(11 * 1024 * 1024));
  const binary = await f.registry.reference('A', 'large.bin');
  expect(await readFileContext([binary])).toEqual([
    { id: binary.id, index: binary.index, unreadable: expect.any(String) },
  ]);
  const text = 'a'.repeat(65535) + '\u20ac';
  await writeFile(join(f.roots.A, 'split.txt'), text);
  const file = await f.registry.reference('A', 'split.txt');
  expect(await readFileContext([file])).toEqual([{ id: file.id, index: file.index, text }]);
  await writeFile(join(f.roots.A, 'large.txt'), 'a'.repeat(11 * 1024 * 1024));
  await expect(readFileContext([await f.registry.reference('A', 'large.txt')])).rejects.toThrow(
    '160000',
  );
});
it('formats complete deterministic manifests with JSON-escaped paths and worktree identities', async () => {
  const f = await fixture();
  const file = await f.registry.reference('A', 'src/app.ts');
  const uploaded = await f.registry.upload('A', { name: 'a "quoted" name.txt', data: 'YQ==' });
  expect(attachmentManifest([uploaded, file])).toBe(
    `References:\nFile 2: name=${JSON.stringify(uploaded.name)} path=${JSON.stringify(uploaded.path)} worktree=${JSON.stringify(f.roots.A)}\nFile 1: name="app.ts" path=${JSON.stringify(file.path)} worktree=${JSON.stringify(f.roots.A)}\nRead the referenced files and inspect referenced images before responding.`,
  );
  const image = {
    ...uploaded,
    kind: 'image' as const,
    index: 9,
    name: 'line\nname.png',
    path: '/managed/a"b.png',
    worktreePath: '/tree/with\\slash',
  };
  expect(attachmentManifest([image])).toBe(
    `References:\nImage 9: name=${JSON.stringify(image.name)} path=${JSON.stringify(image.path)} worktree=${JSON.stringify(image.worktreePath)}\nRead the referenced files and inspect referenced images before responding.`,
  );
  expect(attachmentManifest([])).toBe('');
});
it('classifies late binary markers after the text budget without retaining or truncating oversized text', async () => {
  const f = await fixture();
  const prefix = Buffer.alloc(196608, 97);
  const preceding = await f.registry.upload('A', {
    name: 'preceding.txt',
    data: Buffer.from('keep this text').toString('base64'),
  });
  for (const [name, marker] of [
    ['late-nul.bin', Buffer.from([0])],
    ['late-invalid.bin', Buffer.from([255])],
    ['late-incomplete.bin', Buffer.from([195])],
  ] as const) {
    await writeFile(join(f.roots.A, name), Buffer.concat([prefix, marker]));
    const file = await f.registry.reference('A', name);
    expect(await readFileContext([preceding, file])).toEqual([
      { id: preceding.id, index: preceding.index, text: 'keep this text' },
      { id: file.id, index: file.index, unreadable: expect.any(String) },
    ]);
  }
  await writeFile(join(f.roots.A, 'oversized-valid.txt'), prefix);
  await expect(
    readFileContext([preceding, await f.registry.reference('A', 'oversized-valid.txt')]),
  ).rejects.toThrow('160000');
});
it('browses folders and previews without allocating references or indices', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  expect(await f.registry.browse('A', '', 0, signal)).toMatchObject({
    entries: [{ name: 'src', relativePath: 'src', kind: 'directory' }],
  });
  expect(await f.registry.preview('A', 'src/app.ts', signal)).toMatchObject({
    name: 'app.ts',
    relativePath: 'src/app.ts',
    state: 'text',
    text: 'A',
  });
  expect(f.store.listFileReferences('A')).toEqual([]);
  expect(await f.registry.reference('A', 'src/app.ts')).toMatchObject({ index: 1 });
});
it('confines browse, preview and content hits and handles cancelled and unsupported previews', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  await writeFile(join(f.roots.A, 'src/app.ts'), 'hidden needle in content');
  await symlink(f.roots.B, join(f.roots.A, 'outside'));
  for (const p of ['../B', 'outside'])
    await expect(f.registry.browse('A', p, 0, signal)).rejects.toThrow();
  for (const p of ['../B/src/app.ts', 'outside/src/app.ts', 'missing', 'src'])
    await expect(f.registry.preview('A', p, signal)).rejects.toThrow();
  await writeFile(join(f.roots.A, 'binary'), Buffer.from([0, 1]));
  await writeFile(join(f.roots.A, 'large'), 'a'.repeat(200000));
  await writeFile(
    join(f.roots.A, 'image.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  expect(await f.registry.preview('A', 'binary', signal)).toMatchObject({ state: 'binary' });
  expect(await f.registry.preview('A', 'large', signal)).toMatchObject({
    state: 'text',
    truncated: true,
  });
  await writeFile(
    join(f.roots.A, 'oversized.png'),
    Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(4 * 1024 * 1024)]),
  );
  expect(await f.registry.preview('A', 'oversized.png', signal)).toMatchObject({ state: 'large' });
  await writeFile(join(f.roots.A, 'invalid.txt'), Buffer.from([255]));
  expect(await f.registry.preview('A', 'invalid.txt', signal)).toMatchObject({ state: 'binary' });
  expect(await f.registry.preview('A', 'image.png', signal)).toMatchObject({
    state: 'image',
    dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
  });
  expect(await f.registry.find('A', 'needle', 'content', signal)).toMatchObject({
    entries: [{ relativePath: 'src/app.ts', name: 'app.ts' }],
  });
  expect(await f.registry.find('A', 'needle', 'name', signal)).toMatchObject({ entries: [] });
  const cancelled = AbortSignal.abort();
  await expect(f.registry.preview('A', 'src/app.ts', cancelled)).rejects.toThrow();
  await expect(f.registry.browse('A', '', 0, cancelled)).rejects.toThrow();
  await expect(f.registry.find('A', 'needle', 'content', cancelled)).rejects.toThrow();
  expect(f.store.listFileReferences('A')).toEqual([]);
});
it('paginates folder inventories and reports bounded search scope', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  await Promise.all(
    Array.from({ length: 110 }, (_, i) => writeFile(join(f.roots.A, 'src', `file-${i}`), 'match')),
  );
  const first = await f.registry.browse('A', 'src', 0, signal);
  expect(first.entries).toHaveLength(100);
  expect(first.nextOffset).toBeDefined();
  const second = await f.registry.browse('A', 'src', first.nextOffset!, signal);
  expect(second.entries).toHaveLength(11);
  expect(new Set([...first.entries, ...second.entries].map((e) => e.relativePath)).size).toBe(111);
  expect(await f.registry.find('A', 'match', 'content', signal)).toMatchObject({
    limited: true,
    guidance: expect.any(String),
  });
});

it('cancels in-flight browser operations before exposing results', async () => {
  const f = await fixture();
  for (const operation of [
    (signal: AbortSignal) => f.registry.preview('A', 'src/app.ts', signal),
    (signal: AbortSignal) => f.registry.browse('A', '', 0, signal),
    (signal: AbortSignal) => f.registry.find('A', 'A', 'content', signal),
  ]) {
    const controller = new AbortController();
    const pending = operation(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  }
  expect(f.store.listFileReferences('A')).toEqual([]);
});

it('keeps content-search raster reads within the text scan budget', async () => {
  const f = await fixture();
  await writeFile(
    join(f.roots.A, 'scan.png'),
    Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(1024 * 1024)]),
  );
  const reads = vi.spyOn(fileContent, 'readReferencePrefix');
  try {
    expect(
      (await f.registry.find('A', 'absent', 'content', new AbortController().signal)).entries,
    ).toEqual([]);
    expect(
      reads.mock.calls.filter(([file]) => file.name === 'scan.png').map(([, length]) => length),
    ).toEqual([128 * 1024]);
  } finally {
    reads.mockRestore();
  }
});

it('browsing skips nested worktree folders reported for the root', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'file-registry-nested-')));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, '.worktrees', 'wt'), { recursive: true });
  await mkdir(join(dir, 'src'));
  await mkdir(join(dir, 'side'));
  const store = new SqliteStore(':memory:');
  cleanup.push(async () => store.close());
  store.registerSession({
    id: 'A',
    target: { agent: 'codex', sessionRef: 'A', projectId: dir },
    canonicalRoot: dir,
    projectName: 'A',
    enabled: true,
  });
  const nestedWorktrees = vi.fn(async (root: string) =>
    root === dir ? ['.worktrees/wt', 'side'] : [],
  );
  const registry = createFileRegistry({
    store,
    attachmentRoot: join(dir, 'uploads'),
    nestedWorktrees,
  });
  const signal = new AbortController().signal;
  expect((await registry.browse('A', '', 0, signal)).entries.map((e) => e.name)).toEqual([
    '.worktrees',
    'src',
  ]);
  expect((await registry.browse('A', '.worktrees', 0, signal)).entries).toEqual([]);
  expect(nestedWorktrees).toHaveBeenCalledWith(dir);
});
