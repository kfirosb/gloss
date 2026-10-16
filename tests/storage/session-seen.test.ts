import { expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationSnapshot } from '../../src/core/contracts.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';

const target = (id: string) => ({
  agent: 'codex' as const,
  sessionRef: id,
  projectId: process.cwd(),
});
const snapshot = (id: string): ConversationSnapshot => ({
  id,
  target: target(id),
  codingState: 'disconnected',
  codingMessages: [],
  discussion: [],
  deliveries: [],
  language: 'he',
  languageSessionId: 'l',
  languageModel: 'm',
  sourceRevision: 0,
});

it('markSeen stores a sequence, never lowers it, and reads back undefined for unknown sessions', () => {
  const store = new SqliteStore(':memory:');
  expect(store.seenSequence('A')).toBeUndefined();
  store.markSeen('A', 5, 1000);
  expect(store.seenSequence('A')).toBe(5);
  store.markSeen('A', 3, 2000);
  expect(store.seenSequence('A')).toBe(5);
  store.markSeen('A', 9, 3000);
  expect(store.seenSequence('A')).toBe(9);
  expect(() => store.markSeen('A', -1)).toThrow('Invalid seen sequence');
  expect(() => store.markSeen('A', 1.5)).toThrow('Invalid seen sequence');
  store.close();
});

it('seen sequences survive reopening the database file', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'gloss-seen-')), 'state.db');
  const first = new SqliteStore(path);
  first.markSeen('A', 7);
  first.close();
  const second = new SqliteStore(path);
  expect(second.seenSequence('A')).toBe(7);
  second.close();
});

it('deleting a conversation deletes its seen row', () => {
  const store = new SqliteStore(':memory:');
  store.registerSession({
    id: 'A',
    target: target('A'),
    canonicalRoot: process.cwd(),
    projectName: 'p',
    enabled: true,
  });
  store.save(snapshot('A'));
  store.markSeen('A', 4);
  store.deleteConversation('A');
  expect(store.seenSequence('A')).toBeUndefined();
  store.close();
});
