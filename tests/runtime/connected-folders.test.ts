import { expect, it } from 'vitest';
import { DEFAULT_SIDEBAR_SETTINGS, validateSidebarSettings } from '../../src/runtime/connected-folders.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';

it('validates sidebar settings and drops junk', () => {
  expect(validateSidebarSettings({ order: ['/a/.git', 1], hidden: ['/b'], collapsed: [], worktreeLocation: { '/a/.git': '/a/.worktrees', '/c': 'relative' }, extra: 1 }))
    .toEqual({ order: ['/a/.git'], hidden: ['/b'], collapsed: [], worktreeLocation: { '/a/.git': '/a/.worktrees' } });
  expect(() => validateSidebarSettings(null)).toThrow('Invalid sidebar settings');
  expect(validateSidebarSettings({})).toEqual(DEFAULT_SIDEBAR_SETTINGS);
});
it('persists connected folders and sidebar settings', () => {
  const store = new SqliteStore(':memory:');
  expect(store.listConnectedFolders()).toEqual([]);
  store.putConnectedFolder({ path: '/p', projectKey: '/p/.git', kind: 'main', createdByApp: false, connectedAt: 1 });
  store.putConnectedFolder({ path: '/p/.worktrees/x', projectKey: '/p/.git', kind: 'worktree', createdByApp: true, connectedAt: 2 });
  expect(store.listConnectedFolders().map(f => f.path)).toEqual(['/p', '/p/.worktrees/x']);
  store.deleteConnectedFolder('/p/.worktrees/x');
  expect(store.listConnectedFolders()).toHaveLength(1);
  expect(store.readSidebarSettings()).toEqual(DEFAULT_SIDEBAR_SETTINGS);
  store.writeSidebarSettings({ ...DEFAULT_SIDEBAR_SETTINGS, hidden: ['/p/.git'] });
  expect(store.readSidebarSettings().hidden).toEqual(['/p/.git']);
});
