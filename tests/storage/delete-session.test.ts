import { expect, it } from 'vitest';
import type { ConversationSnapshot } from '../../src/core/contracts.js';
import { defaultWorkspace } from '../../src/core/session-contracts.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';

const target = (id: string) => ({
  agent: 'codex' as const,
  sessionRef: id,
  projectId: process.cwd(),
});
const register = (store: SqliteStore, id: string) =>
  store.registerSession({
    id,
    target: target(id),
    canonicalRoot: process.cwd(),
    projectName: 'p',
    enabled: true,
  });
const snapshot = (id: string): ConversationSnapshot => ({
  id,
  target: target(id),
  codingState: 'disconnected',
  codingMessages: [],
  discussion: [{ role: 'user', text: 'hi' }],
  deliveries: [],
  language: 'he',
  languageSessionId: 'l',
  languageModel: 'm',
  sourceRevision: 0,
});
const count = (store: SqliteStore, sql: string, ...args: string[]) =>
  ((store as any).database.prepare(sql).get(...args) as { n: number }).n;

it('deleteSession removes the conversation, panel row, cascaded rows, override and ended launches only', () => {
  const store = new SqliteStore(':memory:');
  register(store, 'A');
  register(store, 'B');
  store.save(snapshot('A'));
  store.save(snapshot('B'));
  store.writeWorkspace('A', 0, { ...defaultWorkspace(), composer: 'draft' });
  store.writeLanguageOverride('A', { reply: 'en' });
  store.putLaunch({
    id: 'L1',
    agent: 'codex',
    folder: '/x',
    panePid: 1,
    panelSessionId: 'A',
    state: 'ended',
    createdAt: 1,
  });
  store.putLaunch({
    id: 'L2',
    agent: 'codex',
    folder: '/x',
    panePid: 2,
    panelSessionId: 'B',
    state: 'ended',
    createdAt: 1,
  });
  store.deleteSession('A');
  expect(store.listSessions().map((r) => r.id)).toEqual(['B']);
  expect(store.load('A')).toBeUndefined();
  expect(store.load('B')).toBeDefined();
  expect(
    count(store, 'SELECT COUNT(*) AS n FROM session_workspaces WHERE session_id = ?', 'A'),
  ).toBe(0);
  expect(store.listLaunches().map((l) => l.id)).toEqual(['L2']);
});
it('deleteSession keeps launch records that are not ended', () => {
  const store = new SqliteStore(':memory:');
  register(store, 'A');
  store.putLaunch({
    id: 'L1',
    agent: 'codex',
    folder: '/x',
    panePid: 1,
    panelSessionId: 'A',
    state: 'running',
    createdAt: 1,
  });
  store.deleteSession('A');
  expect(store.listLaunches().map((l) => l.id)).toEqual(['L1']);
});
