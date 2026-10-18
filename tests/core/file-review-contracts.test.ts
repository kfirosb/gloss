import { describe, expect, it } from 'vitest';
import { fileReviewCacheKey, type FileReviewKey } from '../../src/core/file-review-contracts.js';

describe('file review cache key', () => {
  it('changes the cache key when any field changes', () => {
    const key: FileReviewKey = {
      scope: '/p',
      path: 'a.md',
      version: '1:2:3:4',
      mode: 'summary',
      language: 'he',
      model: 'm',
      promptVersion: 'v1',
    };
    const base = fileReviewCacheKey(key);
    for (const changed of [
      { scope: '/q' },
      { path: 'b.md' },
      { version: '1:2:3:5' },
      { mode: 'translation' as const },
      { language: 'en' },
      { model: 'm2' },
      { promptVersion: 'v2' },
    ])
      expect(fileReviewCacheKey({ ...key, ...changed })).not.toBe(base);
    expect(fileReviewCacheKey({ ...key })).toBe(base);
  });
});
