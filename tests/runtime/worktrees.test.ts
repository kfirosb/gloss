import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { execFile } from 'node:child_process'; import { promisify } from 'node:util';
import { createWorktreeService, WORKTREE_NAME } from '../../src/runtime/worktrees.js';
const run = promisify(execFile);
const made: string[] = []; afterAll(async () => { await Promise.all(made.map(d => rm(d, { recursive: true, force: true }))); });
const temp = async (prefix: string) => { const d = await realpath(await mkdtemp(join(tmpdir(), prefix))); made.push(d); return d; };
async function repo(commit = true) {
  const dir = await temp('la-wt-');
  await run('git', ['-C', dir, 'init', '-q', '-b', 'main']); await run('git', ['-C', dir, 'config', 'user.email', 't@t']); await run('git', ['-C', dir, 'config', 'user.name', 't']);
  if (commit) { await writeFile(join(dir, 'README'), 'hi'); await run('git', ['-C', dir, 'add', '.']); await run('git', ['-C', dir, 'commit', '-q', '-m', 'init']); }
  return dir;
}
const service = createWorktreeService();
it('validates names', () => { for (const bad of ['', '-x', 'a b', 'x'.repeat(65)]) expect(WORKTREE_NAME.test(bad)).toBe(false); expect(WORKTREE_NAME.test('fix-login_2')).toBe(true); });
describe('with real git', () => {
  it('creates in the default location, adds the ignore entry, and lists it', async () => {
    const main = await repo(); const created = await service.create(main, 'feature-a', join(main, '.worktrees'));
    expect(created).toEqual({ path: join(main, '.worktrees', 'feature-a'), branch: 'feature-a', location: join(main, '.worktrees'), ignore: { added: true, line: '/.worktrees/' } });
    expect(await readFile(join(main, '.gitignore'), 'utf8')).toContain('/.worktrees/');
    const list = await service.list(main);
    expect(list.map(w => [w.path, w.branch, w.main])).toEqual([[main, 'main', true], [created.path, 'feature-a', false]]);
    expect((await stat(created.path)).isDirectory()).toBe(true);
  });
  it('refuses an existing branch, bad names, and repos without commits', async () => {
    const main = await repo(); await service.create(main, 'dup', join(main, '.worktrees'));
    await expect(service.create(main, 'dup', join(main, '.worktrees'))).rejects.toThrow(/already exists/);
    await expect(service.create(main, 'bad name', join(main, '.worktrees'))).rejects.toThrow('Use letters, numbers, hyphens or underscores');
    const empty = await repo(false); expect(await service.hasCommits(empty)).toBe(false);
    await expect(service.create(empty, 'x', join(empty, '.worktrees'))).rejects.toThrow('Make a first commit');
  });
  it('external location adds no ignore entry', async () => {
    const main = await repo(); const outside = await temp('la-out-');
    const created = await service.create(main, 'ext', outside); expect(created.ignore).toBeUndefined();
    await expect(readFile(join(main, '.gitignore'), 'utf8')).rejects.toThrow();
  });
  it('inspects counts and removes a dirty worktree while keeping the branch', async () => {
    const main = await repo(); const { path } = await service.create(main, 'dirty', join(main, '.worktrees'));
    await writeFile(join(path, 'README'), 'changed'); await writeFile(join(path, 'new.txt'), 'n');
    await run('git', ['-C', path, 'add', 'new.txt']); await run('git', ['-C', path, 'commit', '-q', '-m', 'wip']); await writeFile(join(path, 'later.txt'), 'l');
    const info = await service.inspect(main, path);
    expect(info).toMatchObject({ path, branch: 'dirty', modified: 1, untracked: 1, unmergedCommits: 1 }); expect(info.changedFiles.map(f => f.path).sort()).toEqual(['README', 'later.txt']);
    expect(info.oldestChange).toBeLessThanOrEqual(info.newestChange!);
    await service.remove(main, path);
    expect((await service.list(main)).map(w => w.path)).toEqual([main]);
    expect((await run('git', ['-C', main, 'branch', '--list', 'dirty'])).stdout).toContain('dirty');
  });
  it('caps changed files at 500 while keeping exact totals', async () => {
    const main = await repo(); const { path } = await service.create(main, 'many', join(main, '.worktrees'));
    await Promise.all(Array.from({ length: 510 }, (_, i) => writeFile(join(path, `f${i}.txt`), 'x')));
    const info = await service.inspect(main, path);
    expect(info).toMatchObject({ untracked: 510, modified: 0, truncated: true }); expect(info.changedFiles).toHaveLength(500);
    const clean = await service.inspect(main, main); expect(clean.truncated).toBeUndefined(); expect(clean.changedFiles).toHaveLength(1);
  });
  it('refuses to remove the main checkout or a foreign path', async () => {
    const main = await repo(); await expect(service.remove(main, main)).rejects.toThrow('main checkout'); await expect(service.remove(main, '/tmp')).rejects.toThrow('not a worktree of this project');
  });
  it('initializes git in a plain folder without committing', async () => {
    const dir = await temp('la-plain-'); await writeFile(join(dir, 'a.txt'), 'a');
    await service.initGit(dir); expect((await run('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'])).stdout.trim()).toBe('true'); expect(await service.hasCommits(dir)).toBe(false);
  });
  it('reports git stderr as the error message', async () => {
    const dir = await temp('la-nogit-');
    await expect(service.list(dir)).rejects.toMatchObject({ code: 'git', message: expect.stringMatching(/not a git repository/i) });
  });
});
describe('nested worktree lookup', () => {
  it('lists worktrees inside the root as relative paths and ignores non-git folders', async () => {
    const { createNestedWorktreeLookup } = await import('../../src/runtime/worktrees.js');
    const main = await repo(); await service.create(main, 'inner', join(main, '.worktrees')); const outside = await temp('la-out-'); await service.create(main, 'outer', outside);
    const lookup = createNestedWorktreeLookup(service);
    expect(await lookup(main)).toEqual(['.worktrees/inner']);
    expect(await lookup(join(main, '.worktrees', 'inner'))).toEqual([]);
    expect(await lookup(await temp('la-plain-'))).toEqual([]);
  });
});
