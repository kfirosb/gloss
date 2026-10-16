import { expect, it, vi } from 'vitest';
import { createAsyncCache } from '../../src/core/async-cache.js';

it('invalidates a single key without discarding other cached reads', async () => {
  const cache = createAsyncCache<string, string>({ ttlMs: 100 });
  const read = vi.fn(async () => 'value');
  await cache.get('a', read);
  await cache.get('b', read);
  cache.delete('a');
  await cache.get('a', read);
  await cache.get('b', read);
  expect(read).toHaveBeenCalledTimes(3);
});

it('evicts the least recently used key and retries failed reads', async () => {
  const cache = createAsyncCache<string, string>({ ttlMs: 100, maxEntries: 2 });
  const read = vi.fn(async () => 'value');
  await cache.get('a', read);
  await cache.get('b', read);
  await cache.get('a', read);
  await cache.get('c', read);
  await cache.get('a', read);
  expect(read).toHaveBeenCalledTimes(3);
  await cache.get('b', read);
  expect(read).toHaveBeenCalledTimes(4);
  await expect(
    cache.get('bad', async () => {
      throw new Error('retry me');
    }),
  ).rejects.toThrow('retry me');
  await expect(cache.get('bad', read)).resolves.toBe('value');
  cache.clear();
  await cache.get('bad', read);
  expect(read).toHaveBeenCalledTimes(6);
});

it('an evicted pending rejection cannot remove its replacement', async () => {
  const cache = createAsyncCache<string, string>({ ttlMs: 100, maxEntries: 1 });
  let reject!: (error: Error) => void;
  const old = cache.get(
    'a',
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  await cache.get('b', async () => 'b');
  const replacement = cache.get('a', async () => 'new');
  reject(new Error('old'));
  await expect(old).rejects.toThrow('old');
  expect(cache.get('a', async () => 'wrong')).toBe(replacement);
});
