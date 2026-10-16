import { expect, it } from 'vitest';
import { buildProjectTree } from '../../src/ui/session-navigation.js';

it('attaches terminals to their folder, creating the folder when no session lives there', () => {
  const entry = {
    key: 'a',
    sessionId: 'a',
    target: { agent: 'codex' as const, sessionRef: 'a', projectId: '/repo' },
    projectKey: '/repo/.git',
    projectName: 'repo',
    worktreePath: '/repo',
    open: true,
    activity: 'idle' as const,
    availability: 'available' as const,
  };
  const terminals = [
    {
      key: 'terminal:T2',
      launchId: 'T2',
      title: 'Terminal 2',
      busy: true,
      folder: '/repo',
      projectKey: '/repo/.git',
      projectName: 'repo',
    },
    {
      key: 'terminal:T1',
      launchId: 'T1',
      title: 'Terminal',
      busy: false,
      folder: '/repo',
      projectKey: '/repo/.git',
      projectName: 'repo',
    },
    {
      key: 'terminal:T3',
      launchId: 'T3',
      title: 'Terminal',
      busy: false,
      folder: '/repo/.worktrees/x',
      projectKey: '/repo/.git',
      projectName: 'repo',
    },
  ];
  const tree = buildProjectTree([entry], {}, [], terminals);
  expect(tree).toHaveLength(1);
  const [main, wt] = tree[0]!.folders;
  expect(main!.open.map((e) => e.key)).toEqual(['a']);
  expect(main!.terminals.map((t) => t.launchId)).toEqual(['T1', 'T2']);
  expect(wt!.key).toBe('/repo/.worktrees/x');
  expect(wt!.open).toEqual([]);
  expect(wt!.terminals.map((t) => t.launchId)).toEqual(['T3']);
});
