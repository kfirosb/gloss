import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../../src/runtime/atomic-file.js';

const clean: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of clean.splice(0)) await close();
});

it('replaces a file with the exact mode and leaves no temporary file, even when rename fails', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'atomic-')));
  clean.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'settings.json');
  await writeFile(path, 'old', { mode: 0o600 });
  await writeFileAtomic(path, 'new', 0o644);
  expect(await readFile(path, 'utf8')).toBe('new');
  expect((await stat(path)).mode & 0o777).toBe(0o644);
  const directory = join(root, 'taken');
  await mkdir(directory);
  await writeFile(join(directory, 'keep'), '');
  await expect(writeFileAtomic(directory, 'x', 0o600)).rejects.toThrow();
  expect((await readdir(root)).sort()).toEqual(['settings.json', 'taken']);
});
