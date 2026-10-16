import { expect, it } from 'vitest';
import { SqliteStore } from '../../src/storage/sqlite-store.js';

it('accumulates spend per scope and provider, keeping dollars optional', () => {
  const store = new SqliteStore(':memory:');
  store.addSpend('session:A', 'claude', { usd: 0.001, inputTokens: 10, outputTokens: 2 });
  store.addSpend('session:A', 'claude', { usd: 0.002, inputTokens: 5, outputTokens: 1 });
  store.addSpend('session:A', 'codex', { inputTokens: 30, outputTokens: 4 });
  expect(store.readSpend('session:A', 'claude')).toEqual({
    usd: 0.003,
    inputTokens: 15,
    outputTokens: 3,
  });
  expect(store.readSpend('session:A', 'codex')).toEqual({ inputTokens: 30, outputTokens: 4 });
  expect(store.readSpend('session:B', 'claude')).toBeUndefined();
  store.addSpend('session:A', 'codex', {
    inputTokens: 100,
    cachedInputTokens: 60,
    outputTokens: 1,
  });
  store.addSpend('session:A', 'codex', { inputTokens: 50, cachedInputTokens: 40, outputTokens: 1 });
  expect(store.readSpend('session:A', 'codex')).toEqual({
    inputTokens: 180,
    cachedInputTokens: 100,
    outputTokens: 6,
  });
  store.close();
});
