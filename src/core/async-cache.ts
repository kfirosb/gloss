export interface AsyncCacheOptions {
  ttlMs: number;
  maxEntries?: number;
  now?: () => number;
}

/** Bounded LRU cache that shares pending reads, expires from completion, and retries failures. */
export function createAsyncCache<K, V>(options: AsyncCacheOptions) {
  const { ttlMs, maxEntries = 200, now = Date.now } = options;
  if (!Number.isFinite(ttlMs) || ttlMs < 0 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error('Invalid cache limits');
  }
  const entries = new Map<K, { value: Promise<V>; expiresAt: number }>();
  return {
    get(key: K, read: () => Promise<V>): Promise<V> {
      const hit = entries.get(key);
      if (hit && now() <= hit.expiresAt) {
        entries.delete(key);
        entries.set(key, hit);
        return hit.value;
      }
      entries.delete(key);
      // Pending work does not expire just because the underlying read is slow.
      // Capacity eviction still bounds memory when many distinct keys are requested.
      let value: Promise<V>;
      try {
        value = Promise.resolve(read());
      } catch (error) {
        return Promise.reject(error);
      }
      const entry = { value, expiresAt: Infinity };
      entries.set(key, entry);
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
      void value.then(
        () => {
          entry.expiresAt = now() + ttlMs;
        },
        () => {
          if (entries.get(key) === entry) entries.delete(key);
        },
      );
      return value;
    },
    delete(key: K) {
      return entries.delete(key);
    },
    clear() {
      entries.clear();
    },
  };
}
