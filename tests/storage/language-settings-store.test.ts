import { expect, it } from 'vitest';
import { SqliteStore } from '../../src/storage/sqlite-store.js';

const register = (store: SqliteStore, id: string) =>
  store.registerSession({
    id,
    target: { agent: 'codex', sessionRef: id, projectId: process.cwd() },
    canonicalRoot: process.cwd(),
    projectName: 'p',
    enabled: true,
  });

it('starts with initial defaults and no overrides', () => {
  const store = new SqliteStore(':memory:');
  register(store, 'A');
  expect(store.readLanguageDefaults()).toEqual({
    write: 'he',
    send: 'en',
    reply: 'he',
    assist: 'he',
  });
  expect(store.readLanguageOverride('A')).toEqual({});
});
it('round-trips defaults and overrides; reset deletes the override', () => {
  const store = new SqliteStore(':memory:');
  register(store, 'A');
  store.writeLanguageDefaults({ write: 'en', send: 'en', reply: 'en', assist: 'en' });
  store.writeLanguageOverride('A', { reply: 'he' });
  expect(store.readLanguageDefaults()).toEqual({
    write: 'en',
    send: 'en',
    reply: 'en',
    assist: 'en',
  });
  expect(store.readLanguageOverride('A')).toEqual({ reply: 'he' });
  store.writeLanguageOverride('A', null);
  expect(store.readLanguageOverride('A')).toEqual({});
  store.writeLanguageOverride('A', { reply: 'en' });
  store.writeLanguageOverride('A', {});
  expect(store.readLanguageOverride('A')).toEqual({});
});
it('rejects invalid values and unknown sessions without changing storage', () => {
  const store = new SqliteStore(':memory:');
  register(store, 'A');
  expect(() =>
    store.writeLanguageDefaults({ write: 'fr', send: 'en', reply: 'en', assist: 'en' }),
  ).toThrow('Invalid language settings');
  expect(store.readLanguageDefaults().write).toBe('he');
  expect(() => store.writeLanguageOverride('missing', { reply: 'en' })).toThrow('Unknown session');
});
it('ignores corrupted stored JSON by falling back to initial defaults', () => {
  const store = new SqliteStore(':memory:');
  (store as any).database
    .prepare(
      "INSERT OR REPLACE INTO app_settings(key,value_json) VALUES ('language.defaults','{bad')",
    )
    .run();
  expect(store.readLanguageDefaults()).toEqual({
    write: 'he',
    send: 'en',
    reply: 'he',
    assist: 'he',
  });
});
