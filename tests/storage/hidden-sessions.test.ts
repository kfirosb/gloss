import { expect, it } from 'vitest';
import { SqliteStore } from '../../src/storage/sqlite-store.js';

it('hides a conversation once and lists it', () => {
  const store = new SqliteStore(':memory:');
  store.hideSession('claude', 'A', 5);
  store.hideSession('claude', 'A', 6);
  store.hideSession('codex', 'B');
  expect(store.listHiddenSessions()).toEqual([
    { agent: 'claude', sessionRef: 'A' },
    { agent: 'codex', sessionRef: 'B' },
  ]);
  store.close();
});
