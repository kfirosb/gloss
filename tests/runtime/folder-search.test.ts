import { expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mdfindPredicate, searchFolders } from '../../src/runtime/folder-search.js';
import type { ProcessRunner } from '../../src/runtime/process-runner.js';

const fakeRunner = (
  lines: string[],
  code = 0,
  reason: 'exited' | 'spawn-error' = 'exited',
): ProcessRunner =>
  async function* () {
    for (const line of lines) yield { type: 'line', line };
    yield { type: 'exit', outcome: { code, signal: null, reason, diagnostics: '' } };
  };

it('escapes the predicate so quotes and wildcards stay literal', () => {
  expect(mdfindPredicate('my proj')).toBe(
    `kMDItemContentType == 'public.folder' && kMDItemFSName == '*my proj*'c`,
  );
  expect(mdfindPredicate(`a"b*c\\d`)).toBe(
    `kMDItemContentType == 'public.folder' && kMDItemFSName == '*a\\"b\\*c\\\\d*'c`,
  );
});

it('filters to home, skips Library/node_modules/hidden, tags git, caps results', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'la-home-')));
  for (const d of [
    'Projects/app/.git',
    'Projects/notes',
    'Library/Caches/app',
    'Projects/app/node_modules/x',
    'Projects/.hidden/app',
  ]) {
    await mkdir(join(home, d), { recursive: true });
  }
  await writeFile(join(home, 'Projects/app/.git/HEAD'), 'ref');
  const lines = [
    join(home, 'Projects/app'),
    join(home, 'Projects/notes'),
    join(home, 'Library/Caches/app'),
    join(home, 'Projects/app/node_modules/x'),
    join(home, 'Projects/.hidden/app'),
    '/tmp/elsewhere',
  ];
  const result = await searchFolders('app', { home, runner: fakeRunner(lines), limit: 1 });
  expect(result).toEqual({
    hits: [{ path: join(home, 'Projects/app'), name: 'app', git: true }],
    timedOut: false,
    unavailable: false,
  });
  const all = await searchFolders('app', { home, runner: fakeRunner(lines) });
  expect(all.hits.map((h) => h.path)).toEqual([
    join(home, 'Projects/app'),
    join(home, 'Projects/notes'),
  ]);
});

it('reports unavailable when mdfind is missing and rejects bad queries', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'la-home-')));
  expect(
    (await searchFolders('x', { home, runner: fakeRunner([], 1, 'spawn-error') })).unavailable,
  ).toBe(true);
  await expect(searchFolders('', { home })).rejects.toThrow('Enter a folder name');
  await expect(searchFolders('x'.repeat(121), { home })).rejects.toThrow('Enter a folder name');
});

it('escapes single quotes and every metacharacter', () => {
  expect(mdfindPredicate("it's")).toBe(
    `kMDItemContentType == 'public.folder' && kMDItemFSName == '*it\\'s*'c`,
  );
  expect(mdfindPredicate(`\\"'*?`)).toBe(
    `kMDItemContentType == 'public.folder' && kMDItemFSName == '*\\\\\\"\\'\\*\\?*'c`,
  );
});

it('reports unavailable when mdfind fails with a non-zero exit', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'la-home-')));
  expect(await searchFolders('x', { home, runner: fakeRunner([], 1) })).toEqual({
    hits: [],
    timedOut: false,
    unavailable: true,
  });
});

it('treats a typed / or ~/ path as the single candidate, without Spotlight', async () => {
  const raw = await mkdtemp(join(tmpdir(), 'la-home-'));
  const home = await realpath(raw);
  await mkdir(join(home, '.config/app/.git'), { recursive: true });
  await mkdir(join(home, 'Projects/notes'), { recursive: true });
  await writeFile(join(home, 'file.txt'), 'x');
  const spotlight: ProcessRunner = async function* () {
    throw new Error('mdfind must not run for a path');
  };
  const search = (q: string) => searchFolders(q, { home: raw, runner: spotlight });
  expect(await search(join(home, 'Projects/notes'))).toEqual({
    hits: [{ path: join(home, 'Projects/notes'), name: 'notes', git: false }],
    timedOut: false,
    unavailable: false,
  });
  expect(await search('~/.config/app/')).toEqual({
    hits: [{ path: join(home, '.config/app'), name: 'app', git: true }],
    timedOut: false,
    unavailable: false,
  });
  for (const q of ['~/missing', join(home, 'nope'), '~/file.txt', '/', tmpdir(), '~/..', home])
    expect(await search(q)).toEqual({ hits: [], timedOut: false, unavailable: false });
});

const mustNotRun: ProcessRunner = async function* () {
  throw new Error('mdfind must not run off macOS');
};

it('walks home itself off macOS: name match, skips, limit, no symlink escape', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'la-home-')));
  for (const d of [
    'work/my-app/.git',
    'work/notes',
    'node_modules/app',
    '.hidden/app',
    'deep/1/2/3/4/5/6/7/8/9/app',
  ])
    await mkdir(join(home, d), { recursive: true });
  await writeFile(join(home, 'work/my-app/.git/HEAD'), 'ref');
  await symlink('/', join(home, 'link'));
  const options = { home, runner: mustNotRun, platform: 'linux' as const };
  expect(await searchFolders('APP', options)).toEqual({
    hits: [{ path: join(home, 'work/my-app'), name: 'my-app', git: true }],
    timedOut: false,
    unavailable: false,
  });
  const limited = await searchFolders('o', { ...options, limit: 1 });
  expect(limited.hits).toHaveLength(1);
  expect(limited.timedOut).toBe(false);
});

it('stops the walk at the deadline and says so', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'la-home-')));
  await mkdir(join(home, 'work/app'), { recursive: true });
  const result = await searchFolders('app', {
    home,
    runner: mustNotRun,
    platform: 'linux',
    timeoutMs: 0,
  });
  expect(result.timedOut).toBe(true);
  expect(result.unavailable).toBe(false);
});
