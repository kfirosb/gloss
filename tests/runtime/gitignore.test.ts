import { afterAll, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureIgnoreEntry } from '../../src/runtime/gitignore.js';
const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});
const temp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'la-ignore-'));
  made.push(d);
  return d;
};
it('creates the file when missing', async () => {
  const d = await temp();
  expect(await ensureIgnoreEntry(d, '/.worktrees/')).toEqual({ added: true, line: '/.worktrees/' });
  expect(await readFile(join(d, '.gitignore'), 'utf8')).toBe('/.worktrees/\n');
});
it('appends after a last line without a newline, preserving content', async () => {
  const d = await temp();
  await writeFile(join(d, '.gitignore'), 'node_modules/\ndist');
  await ensureIgnoreEntry(d, '/.worktrees/');
  expect(await readFile(join(d, '.gitignore'), 'utf8')).toBe('node_modules/\ndist\n/.worktrees/\n');
});
it('keeps CRLF style', async () => {
  const d = await temp();
  await writeFile(join(d, '.gitignore'), 'a\r\nb\r\n');
  await ensureIgnoreEntry(d, '/.worktrees/');
  expect(await readFile(join(d, '.gitignore'), 'utf8')).toBe('a\r\nb\r\n/.worktrees/\r\n');
});
it('does not duplicate equivalent entries', async () => {
  for (const existing of ['/.worktrees/', '.worktrees/', '/.worktrees', '.worktrees']) {
    const d = await temp();
    await writeFile(join(d, '.gitignore'), `x\n${existing}\n`);
    expect((await ensureIgnoreEntry(d, '/.worktrees/')).added).toBe(false);
    expect(await readFile(join(d, '.gitignore'), 'utf8')).toBe(`x\n${existing}\n`);
  }
});
