import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileInventory } from '../../src/runtime/file-search.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

it('reports missing ripgrep as an unavailable search, not an unreadable file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-search-root-'));
  const emptyBin = await mkdtemp(join(tmpdir(), 'file-search-bin-'));
  const path = process.env.PATH;
  process.env.PATH = emptyBin;
  cleanups.push(async () => { process.env.PATH = path; await rm(root, { recursive: true, force: true }); await rm(emptyBin, { recursive: true, force: true }); });
  const error = await fileInventory(root, new AbortController().signal).catch(value => value);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toMatch(/ripgrep/);
  expect(error.code).toBe('search-unavailable');
  // The HTTP layer treats errors carrying a path as file-system failures.
  expect(error.path).toBeUndefined();
});

it('excludes .worktrees and each nested worktree from the inventory', async () => {
  const { inventoryArgs } = await import('../../src/runtime/file-search.js');
  const args = inventoryArgs(['.worktrees/feature-a', 'tools/side[1]', 'my docs', 'star*dir']);
  const globs = args.flatMap((arg, i) => args[i - 1] === '-g' ? [arg] : []);
  // Anchored to the search root: a nested worktree named like another folder hides only itself.
  expect(globs).toEqual(['!.git', '!node_modules', '!dist', '!build', '!/.worktrees',
    '!/.worktrees/feature-a', '!/.worktrees/feature-a/**', '!/tools/side\\[1\\]', '!/tools/side\\[1\\]/**',
    '!/my docs', '!/my docs/**', '!/star\\*dir', '!/star\\*dir/**']);
  expect(inventoryArgs([]).filter(arg => arg.includes('.worktrees'))).toEqual(['!/.worktrees']);
});
