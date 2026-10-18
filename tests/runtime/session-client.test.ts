import { afterEach, expect, it, vi } from 'vitest';
import { SessionClient } from '../../src/ui/session-client.js';
import { WorkspaceConflict, defaultWorkspace } from '../../src/core/session-contracts.js';
afterEach(() => vi.unstubAllGlobals());
it('uses encoded session routes and capability for every request including image metadata', async () => {
  vi.stubGlobal('location', { hash: '#capability=secret' });
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify({ sessionId: 'a/b', sequence: 1, snapshot: { id: 'a/b' } }), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const c = new SessionClient('a/b');
  await c.action({ type: 'older-history' });
  await c.snapshot();
  await c.loadWorkspace();
  await c.saveWorkspace(7, defaultWorkspace());
  await c.uploadImage({ name: 'x.png', data: 'AA==' });
  await c.imageMetadata('image/1');
  expect(fetcher.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
    '/api/sessions/a%2Fb/actions',
    '/api/sessions/a%2Fb/snapshot',
    '/api/sessions/a%2Fb/workspace',
    '/api/sessions/a%2Fb/workspace',
    '/api/sessions/a%2Fb/attachments',
    '/api/sessions/a%2Fb/attachments/image%2F1/metadata',
  ]);
  expect(fetcher).toHaveBeenCalledWith(
    '/api/sessions/a%2Fb/workspace',
    expect.objectContaining({
      body: JSON.stringify({ expectedRevision: 7, data: defaultWorkspace() }),
      headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
    }),
  );
});
it('requests saved-review status with encoded path and version', async () => {
  vi.stubGlobal('location', { hash: '#capability=secret' });
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify({ summary: true, translation: false }), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const signal = new AbortController().signal;
  expect(await new SessionClient('a/b').fileReviewStatus('docs/a b.md', 'v&1', signal)).toEqual({
    summary: true,
    translation: false,
  });
  expect(fetcher).toHaveBeenCalledWith(
    '/api/sessions/a%2Fb/files/review-status?path=docs%2Fa%20b.md&version=v%261',
    expect.objectContaining({ signal }),
  );
});
it('exposes CAS conflict current data without retrying', async () => {
  vi.stubGlobal('location', { hash: '#capability=secret' });
  const current = { sessionId: 'A', revision: 4, data: defaultWorkspace() };
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify({ code: 'workspace-conflict', current }), { status: 409 }),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(new SessionClient('A').saveWorkspace(3, defaultWorkspace())).rejects.toEqual(
    new WorkspaceConflict(current),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('ignores events with a different session envelope or snapshot identity', async () => {
  vi.stubGlobal('location', { hash: '#capability=secret' });
  const stop = new AbortController();
  const listener = vi.fn(() => stop.abort());
  const entries = [
    { sessionId: 'B', snapshot: { id: 'B' } },
    { sessionId: 'A', snapshot: { id: 'B' } },
    { sessionId: 'A', snapshot: { id: 'A' } },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          entries.map((e) => 'data: ' + JSON.stringify({ ...e, sequence: 1 }) + '\n\n').join(''),
        ),
    ),
  );
  await new SessionClient('A').subscribe(listener, stop.signal);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'A', snapshot: { id: 'A' } }),
  );
});
