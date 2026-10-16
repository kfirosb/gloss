import { afterEach, test, expect, vi } from 'vitest';
import { SessionClient } from '../../src/ui/session-client.js';
afterEach(() => vi.unstubAllGlobals());
for (const declared of [true, false])
  test(`media download enforces remaining budget with ${declared ? 'declared' : 'streamed'} length`, async () => {
    vi.stubGlobal('location', { hash: '#capability=test' });
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { 'content-type': 'video/webm', ...(declared ? { 'content-length': '4' } : {}) },
        }),
    );
    const client = new SessionClient('test');
    await expect(client.previewMedia('clip.webm', new AbortController().signal, 3)).rejects.toThrow(
      'Combined local media',
    );
    const blob = await client.previewMedia('clip.webm', new AbortController().signal, 4);
    expect(blob.size).toBe(4);
    expect(blob.type).toBe('video/webm');
  });
