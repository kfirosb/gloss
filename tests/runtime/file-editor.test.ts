import { afterEach, expect, it } from 'vitest';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createFileEditor, FileEditConflict } from '../../src/runtime/file-editor.js';
import { MAX_EDITABLE_FILE_BYTES } from '../../src/core/content-policy.js';

const clean: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of clean.splice(0)) await close();
});
async function folders() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'edit-root-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'edit-outside-')));
  clean.push(() => rm(root, { recursive: true, force: true }));
  clean.push(() => rm(outside, { recursive: true, force: true }));
  return { root, outside, editor: createFileEditor(() => root) };
}

it('saves an edit atomically, keeping the mode, a CRLF body, BOM and no temporary file', async () => {
  const { root, editor } = await folders();
  const file = join(root, '.env');
  await writeFile(file, '﻿KEY=old\r\n', { mode: 0o600 });
  await chmod(file, 0o600);
  const opened = await editor.readEditable('s', '.env');
  expect(opened.text).toBe('﻿KEY=old\r\n');
  const saved = await editor.saveFile('s', '.env', '﻿KEY=new\r\nOTHER=1', opened.version);
  expect(await readFile(file, 'utf8')).toBe('﻿KEY=new\r\nOTHER=1');
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(saved.version).not.toBe(opened.version);
  expect(await readdir(root)).toEqual(['.env']);
  // The saved version is the next base version.
  await editor.saveFile('s', '.env', 'KEY=again\n', saved.version);
  expect(await readFile(file, 'utf8')).toBe('KEY=again\n');
});

it('refuses a save when the file changed on disk since it was opened', async () => {
  const { root, editor } = await folders();
  await writeFile(join(root, 'notes.md'), 'one');
  const opened = await editor.readEditable('s', 'notes.md');
  await writeFile(join(root, 'notes.md'), 'agent edit');
  const refused = editor.saveFile('s', 'notes.md', 'mine', opened.version);
  await expect(refused).rejects.toBeInstanceOf(FileEditConflict);
  await expect(refused).rejects.toMatchObject({ code: 'file-changed' });
  expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe('agent edit');
  expect(await readdir(root)).toEqual(['notes.md']);
});

it('creates files and missing folders but never replaces an existing entry', async () => {
  const { root, editor } = await folders();
  const created = await editor.createFile('s', 'config/local/.env.local', 'A=1\n');
  expect(created.relativePath).toBe('config/local/.env.local');
  expect(await readFile(join(root, 'config/local/.env.local'), 'utf8')).toBe('A=1\n');
  expect((await stat(join(root, 'config/local/.env.local'))).mode & 0o777).toBe(0o644);
  const again = editor.createFile('s', 'config/local/.env.local', 'B=2\n');
  await expect(again).rejects.toMatchObject({ code: 'file-exists' });
  await expect(editor.createFile('s', 'config', '')).rejects.toMatchObject({
    code: 'file-exists',
  });
  expect(await readFile(join(root, 'config/local/.env.local'), 'utf8')).toBe('A=1\n');
  expect(await readdir(join(root, 'config/local'))).toEqual(['.env.local']);
});

it('refuses paths outside the folder, through links, and inside .git', async () => {
  const { root, outside, editor } = await folders();
  await writeFile(join(outside, 'secret.txt'), 'private');
  await writeFile(join(root, 'inside.txt'), 'inside');
  await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
  await symlink(join(root, 'inside.txt'), join(root, 'inside-link.txt'));
  await symlink(outside, join(root, 'linked-dir'));
  await mkdir(join(root, '.git'));
  await writeFile(join(root, '.git', 'config'), '[core]');
  const opened = await editor.readEditable('s', 'inside.txt');
  const attempts: [string, () => Promise<unknown>, RegExp][] = [
    ['traversal', () => editor.createFile('s', '../x.txt', 'x'), /outside/],
    [
      'traversal through a folder',
      () => editor.createFile('s', `inside/../../${basename(outside)}/x.txt`, 'x'),
      /outside/,
    ],
    ['absolute', () => editor.createFile('s', join(outside, 'x.txt'), 'x'), /relative/],
    ['NUL', () => editor.createFile('s', 'a\0.txt', 'x'), /relative/],
    ['double slash', () => editor.createFile('s', 'a//b.txt', 'x'), /outside/],
    ['link to outside file', () => editor.saveFile('s', 'escape.txt', 'x', 'v'), /link/i],
    ['link to inside file', () => editor.readEditable('s', 'inside-link.txt'), /link/i],
    [
      'symlinked parent (save)',
      () => editor.saveFile('s', 'linked-dir/secret.txt', 'x', 'v'),
      /real folders/,
    ],
    [
      'symlinked parent (create)',
      () => editor.createFile('s', 'linked-dir/new.txt', 'x'),
      /real folders/,
    ],
    ['.git file', () => editor.saveFile('s', '.git/config', 'x', 'v'), /\.git/],
    ['.git create', () => editor.createFile('s', '.git/hooks/pre-commit', 'x'), /\.git/],
    ['.GIT case', () => editor.createFile('s', 'sub/.GIT/x', 'x'), /\.git/],
    ['root itself', () => editor.createFile('s', '', 'x'), /relative/],
  ];
  for (const [name, attempt, message] of attempts)
    await expect(attempt(), name).rejects.toThrow(message);
  // A stale version for the link is irrelevant: it is refused before any read.
  await expect(editor.saveFile('s', 'inside.txt', 'ok', opened.version)).resolves.toBeTruthy();
  expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('private');
  expect(await readdir(outside)).toEqual(['secret.txt']);
  expect(await readFile(join(root, '.git', 'config'), 'utf8')).toBe('[core]');
  expect((await readdir(root)).sort()).toEqual(
    ['.git', 'escape.txt', 'inside-link.txt', 'inside.txt', 'linked-dir'].sort(),
  );
});

it('refuses binary, invalid UTF-8 and over-limit content', async () => {
  const { root, editor } = await folders();
  await writeFile(join(root, 'image.bin'), Buffer.from([0, 1, 2]));
  await writeFile(join(root, 'latin1.txt'), Buffer.from([0xe9]));
  await writeFile(join(root, 'big.txt'), 'x'.repeat(MAX_EDITABLE_FILE_BYTES + 1));
  await expect(editor.readEditable('s', 'image.bin')).rejects.toThrow('UTF-8');
  await expect(editor.readEditable('s', 'latin1.txt')).rejects.toThrow('UTF-8');
  await expect(editor.readEditable('s', 'big.txt')).rejects.toThrow('limited');
  await expect(
    editor.createFile('s', 'huge.txt', 'x'.repeat(MAX_EDITABLE_FILE_BYTES + 1)),
  ).rejects.toThrow('limited');
  await expect(editor.createFile('s', 'bad.txt', 42)).rejects.toThrow('Invalid file text');
});
