import { afterEach, expect, it, vi } from 'vitest';
import { createApplication } from '../../src/runtime/application.js';
import { startServer } from '../../src/runtime/http-server.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '../../src/core/contracts.js';
import { defaultWorkspace } from '../../src/core/session-contracts.js';
const cleanup: (() => Promise<void>)[] = [];
it('authenticates and validates the dedicated summary route', async () => {
  const { request } = await setup();
  expect((await request('sessions/A/summaries', 'POST', {}, false)).status).toBe(401);
  for (const source of [
    {},
    { kind: 'coding', messageId: 'x'.repeat(301), contentHash: 'a'.repeat(64) },
    { kind: 'coding', messageId: 'm', contentHash: 'bad' },
  ])
    expect((await request('sessions/A/summaries', 'POST', source)).status).toBe(400);
  expect((await request('sessions/foreign/summaries', 'POST', {})).status).toBe(404);
});
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function setup() {
  const store = new SqliteStore(':memory:');
  const agent = new FakeAgent();
  const language = new FakeLanguageSession();
  const open = vi.fn(async () => language);
  const attachmentRoot = await mkdtemp(join(tmpdir(), 'session-http-uploads-'));
  const app = createApplication({
    attachmentRoot,
    store,
    agents: [agent],
    conversationId: 'A',
    capability: 'cap',
    languageBackends: { codex: { open, models: async () => [] } },
  });
  for (const id of ['A', 'B'])
    await app.sessions!.register({ agent: 'codex', sessionRef: id, projectId: process.cwd() }, id);
  const server = await startServer(app);
  const base = new URL('/api/', server.url);
  const request = (path: string, method = 'GET', body?: unknown, auth = true) =>
    fetch(new URL(path, base), {
      method,
      headers: {
        ...(auth ? { authorization: 'Bearer cap' } : {}),
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  cleanup.push(async () => {
    await server.close();
    await app.close();
    await rm(attachmentRoot, { recursive: true, force: true });
  });
  return { app, request, open, agent, base, language };
}
it('scopes actions and leaves unknown sessions unopened', async () => {
  const { request, open } = await setup();
  const action = await request('sessions/A/actions', 'POST', { type: 'discuss', text: 'A only' });
  expect(action.status).toBe(200);
  expect((await action.json()).sessionId).toBe('A');
  expect((await (await request('sessions/A/snapshot')).json()).sessionId).toBe('A');
  expect((await (await request('sessions/B/snapshot')).json()).snapshot.discussion).toEqual([]);
  const before = open.mock.calls.length;
  for (const path of ['snapshot', 'events', 'workspace', 'attachments/missing'])
    expect((await request('sessions/unknown/' + path)).status).toBe(404);
  expect(
    (await request('sessions/unknown/actions', 'POST', { type: 'discuss', text: 'Unknown' }))
      .status,
  ).toBe(404);
  expect(open).toHaveBeenCalledTimes(before);
});
it('requires capability for every new route', async () => {
  const { request } = await setup();
  for (const [path, method] of [
    ['sessions', 'GET'],
    ['sessions', 'POST'],
    ['sessions/discover', 'POST'],
    ['sessions/A/snapshot', 'GET'],
    ['sessions/A/events', 'GET'],
    ['sessions/A/actions', 'POST'],
    ['sessions/A/workspace', 'GET'],
    ['sessions/A/workspace', 'PUT'],
    ['sessions/A/attachments', 'POST'],
    ['sessions/A/attachments/x', 'GET'],
    ['source/messages', 'POST'],
  ])
    expect((await request(path!, method!, undefined, false)).status).toBe(401);
});
it('returns revision conflicts with the current workspace', async () => {
  const { request } = await setup();
  const initial = await (await request('sessions/A/workspace')).json();
  expect(initial.revision).toBe(0);
  const data = { ...defaultWorkspace(), composer: 'Saved A' };
  const saved = await (
    await request('sessions/A/workspace', 'PUT', { expectedRevision: 0, data })
  ).json();
  expect(saved.revision).toBe(1);
  const conflict = await request('sessions/A/workspace', 'PUT', { expectedRevision: 0, data });
  expect(conflict.status).toBe(409);
  expect((await conflict.json()).current).toEqual(saved);
});
it('routes hidden source sessions and rejects wrong or ambiguous identities', async () => {
  const { app, request } = await setup();
  const source = {
    sourceSessionId: 'B',
    sourceId: 'm',
    sequence: 1,
    role: 'user',
    text: 'Hidden B',
  };
  expect(
    (await (await request('source/messages', 'POST', { agent: 'codex', ...source })).json())
      .sessionId,
  ).toBe('B');
  expect((await request('source/messages', 'POST', { agent: 'claude', ...source })).status).toBe(
    400,
  );
  expect(
    (
      await (
        await request('source/messages', 'POST', { ...source, sourceId: 'legacy', sequence: 2 })
      ).json()
    ).sessionId,
  ).toBe('B');
  await app.sessions!.register({ agent: 'claude', sessionRef: 'B', projectId: process.cwd() }, 'C');
  expect((await request('source/messages', 'POST', source)).status).toBe(400);
  expect(app.snapshot().snapshot.discussion).toEqual([]);
});
it('sends exactly one initial SSE snapshot and isolates subscriptions', async () => {
  const { app, request } = await setup();
  const original = app.sessions!.subscribe.bind(app.sessions);
  const removed = vi.fn();
  const subscribe = vi.spyOn(app.sessions!, 'subscribe').mockImplementation((id, listener) => {
    const unsubscribe = original(id, listener);
    return () => {
      removed();
      unsubscribe();
    };
  });
  const response = await request('sessions/B/events');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const initial = decoder.decode((await reader.read()).value);
  expect(initial.match(/data: /g)).toHaveLength(1);
  expect(initial).toContain('"sessionId":"B"');
  await request('sessions/A/actions', 'POST', { type: 'discuss', text: 'Only A' });
  await request('sessions/B/actions', 'POST', { type: 'discuss', text: 'Only B' });
  const next = decoder.decode((await reader.read()).value);
  expect(next).toContain('"sessionId":"B"');
  expect(next).not.toContain('"sessionId":"A"');
  expect(subscribe).toHaveBeenCalledWith('B', expect.any(Function));
  await reader.cancel();
  await vi.waitFor(() => expect(removed).toHaveBeenCalledTimes(1));
});
it('discovers without attaching and connects only a verified selected target', async () => {
  const { app, request, agent, open } = await setup();
  const target = { agent: 'codex' as const, sessionRef: 'new', projectId: process.cwd() };
  vi.spyOn(agent as AgentAdapter, 'discover').mockResolvedValue([target]);
  const found = await (
    await request('sessions/discover', 'POST', { projectPath: process.cwd() })
  ).json();
  expect(found).toEqual([
    expect.objectContaining({ target, projectName: expect.any(String), available: true }),
  ]);
  expect(open).not.toHaveBeenCalled();
  expect(app.sessions!.list()).toHaveLength(2);
  const created = await (await request('sessions', 'POST', { target })).json();
  expect(created.sessionId).toBeTruthy();
  expect(created.snapshot.target).toEqual(target);
  expect(open).toHaveBeenCalledTimes(1);
  expect(
    (await request('sessions', 'POST', { target: { ...target, sessionRef: 'unverified' } })).status,
  ).toBe(400);
  expect(app.sessions!.list()).toHaveLength(3);
  expect((await (await request('snapshot')).json()).snapshot.id).toBe('A');
  expect(
    (await (await request('sessions')).json()).map((record: { id: string }) => record.id),
  ).toContain(created.sessionId);
});
it('decodes session path segments and validates identity before image upload', async () => {
  const { app, request } = await setup();
  await app.sessions!.register(
    { agent: 'codex', sessionRef: 'encoded', projectId: process.cwd() },
    'codex:a/b',
  );
  expect(
    (await (await request('sessions/' + encodeURIComponent('codex:a/b') + '/snapshot')).json())
      .sessionId,
  ).toBe('codex:a/b');
  const upload = vi.spyOn(app, 'uploadImage').mockResolvedValue({
    id: 'image',
    name: 'image.png',
    mime: 'image/png',
    size: 1,
    path: '/private/image',
  });
  expect(
    (await request('sessions/unknown/attachments', 'POST', { name: 'image.png', data: '' })).status,
  ).toBe(404);
  expect(upload).not.toHaveBeenCalled();
  const uploaded = await (
    await request('sessions/A/attachments', 'POST', { name: 'image.png', data: '' })
  ).json();
  expect(uploaded.id).toBe('image');
  expect(uploaded.path).toBeUndefined();
});
it('keeps legacy actions pinned to the launch session', async () => {
  const { request } = await setup();
  await request('sessions/B/actions', 'POST', { type: 'discuss', text: 'B only' });
  const legacy = await (
    await request('actions', 'POST', { type: 'discuss', text: 'Launch only' })
  ).json();
  expect(legacy.sessionId).toBe('A');
  expect((await (await request('snapshot')).json()).snapshot.id).toBe('A');
});

it('serves authenticated image previews on scoped and legacy routes', async () => {
  const { app, request } = await setup();
  const dir = await mkdtemp(join(tmpdir(), 'session-preview-'));
  const path = join(dir, 'image.png');
  await writeFile(path, 'image bytes');
  try {
    vi.spyOn(app, 'readImage').mockResolvedValue({
      id: 'image',
      name: 'image.png',
      mime: 'image/png',
      size: 11,
      path,
    });
    for (const route of ['sessions/A/attachments/image', 'attachments/image']) {
      const response = await request(route);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe('image bytes');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('returns authenticated session image metadata without exposing filesystem paths', async () => {
  const { app, request } = await setup();
  const read = vi.spyOn(app, 'readImage').mockResolvedValue({
    id: 'image',
    name: 'image.png',
    mime: 'image/png',
    size: 11,
    path: '/private/image.png',
  });
  expect(
    (await request('sessions/A/attachments/image/metadata', 'GET', undefined, false)).status,
  ).toBe(401);
  expect((await request('sessions/unknown/attachments/image/metadata')).status).toBe(404);
  expect(read).not.toHaveBeenCalled();
  const response = await request('sessions/A/attachments/image/metadata');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    id: 'image',
    name: 'image.png',
    mime: 'image/png',
    size: 11,
  });
});

it('registers scoped files, serves downloads and enforces ownership on every alias and workspace', async () => {
  const { request } = await setup();
  const uploaded = await request('sessions/A/files', 'POST', {
    name: 'read me.txt',
    data: Buffer.from('file text').toString('base64'),
  });
  expect(uploaded.status).toBe(200);
  const file = await uploaded.json();
  expect(file).toMatchObject({ kind: 'file', index: 1 });
  expect(await (await request(`sessions/A/files/${file.id}/metadata`)).json()).toMatchObject(file);
  expect((await request(`sessions/B/files/${file.id}/metadata`)).status).toBe(400);
  const download = await request(`sessions/A/files/${file.id}/content`);
  expect(await download.text()).toBe('file text');
  expect(download.headers.get('content-disposition')).toContain('attachment');
  expect((await request(`sessions/B/files/${file.id}/content`)).status).toBe(400);
  expect(
    (
      await request('sessions/B/workspace', 'PUT', {
        expectedRevision: 0,
        data: { ...defaultWorkspace(), attachmentIds: [file.id] },
      })
    ).status,
  ).toBe(400);
  const ref = await request('sessions/A/files/reference', 'POST', { relativePath: 'package.json' });
  expect(ref.status).toBe(200);
  expect((await ref.json()).index).toBe(2);
  const search = await request('sessions/A/files/search?q=package.json');
  expect(search.status).toBe(200);
  expect(await search.json()).toContainEqual({
    name: 'package.json',
    relativePath: 'package.json',
  });
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const image = await (
    await request('sessions/A/attachments', 'POST', { name: 'test.png', data: png })
  ).json();
  expect(image.index).toBe(1);
  expect((await request(`attachments/${image.id}`)).status).toBe(200);
  for (const suffix of ['', '/metadata'])
    expect((await request(`sessions/B/attachments/${image.id}${suffix}`)).status).toBe(400);
  expect(
    (
      await request('sessions/B/actions', 'POST', {
        type: 'discuss',
        text: 'borrow',
        attachmentIds: [image.id],
      })
    ).status,
  ).toBe(400);
});
it('keeps allocated image numbers when an earlier upload is removed before discussion', async () => {
  const { request } = await setup();
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  await request('sessions/A/attachments', 'POST', { name: 'unused.png', data: png });
  const image = await (
    await request('sessions/A/attachments', 'POST', { name: 'used.png', data: png })
  ).json();
  expect(image.index).toBe(2);
  const discussion = await (
    await request('sessions/A/actions', 'POST', {
      type: 'discuss',
      text: 'Image 2',
      attachmentIds: [image.id],
    })
  ).json();
  expect(discussion.snapshot.discussion[0].attachments[0].index).toBe(2);
});
it('rejects oversized upload request bodies and unauthenticated file routes', async () => {
  const { request } = await setup();
  for (const [route, method] of [
    ['files', 'POST'],
    ['files/reference', 'POST'],
    ['files/search?q=x', 'GET'],
    ['files/x/content', 'GET'],
    ['files/x/metadata', 'GET'],
  ])
    expect((await request('sessions/A/' + route, method, undefined, false)).status).toBe(401);
  expect(
    (await request('sessions/A/files', 'POST', { name: 'large', data: 'a'.repeat(14_100_001) }))
      .status,
  ).toBe(400);
});
it('preserves separate pending receipt and current composer image memberships', async () => {
  const { request } = await setup();
  const ids: string[] = [];
  for (let i = 0; i < 8; i++)
    ids.push(
      (
        await (
          await request('sessions/A/attachments', 'POST', {
            name: 'image.png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
          })
        ).json()
      ).id,
    );
  const data = {
    ...defaultWorkspace(),
    attachmentIds: ids.slice(0, 4),
    composerAttempt: { requestId: 'uncertain', text: 'keep', attachmentIds: ids.slice(4) },
  };
  const saved = await request('sessions/A/workspace', 'PUT', { expectedRevision: 0, data });
  expect(saved.status).toBe(200);
  expect((await saved.json()).data).toEqual(data);
});
it('previews worktree images and downloads large worktree binaries without the upload size cap', async () => {
  const { app, request } = await setup();
  const directory = await mkdtemp(join(tmpdir(), 'large-worktree-'));
  const { realpath } = await import('node:fs/promises');
  const root = await realpath(directory);
  try {
    await app.sessions!.register({ agent: 'codex', sessionRef: 'large', projectId: root }, 'large');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    );
    await writeFile(join(root, 'image.dat'), png);
    const image = await (
      await request('sessions/large/files/reference', 'POST', { relativePath: 'image.dat' })
    ).json();
    expect(image.kind).toBe('image');
    const preview = await request(`sessions/large/files/${image.id}/content`);
    expect(preview.headers.get('content-type')).toBe('image/png');
    expect(preview.headers.get('content-disposition')).toBeNull();
    expect(Buffer.from(await preview.arrayBuffer())).toEqual(png);
    const legacyPreview = await request(`sessions/large/attachments/${image.id}`);
    expect(Buffer.from(await legacyPreview.arrayBuffer())).toEqual(png);
    const action = await request('sessions/large/actions', 'POST', {
      type: 'discuss',
      text: 'Inspect Image 1',
      attachmentIds: [image.id],
    });
    expect(action.status).toBe(200);
    expect((await action.json()).snapshot.discussion[0].attachments[0]).toMatchObject({
      kind: 'image',
      index: 1,
      mime: 'image/png',
    });
    const data = Buffer.alloc(11 * 1024 * 1024, 7);
    await writeFile(join(root, 'large.bin'), data);
    const file = await (
      await request('sessions/large/files/reference', 'POST', { relativePath: 'large.bin' })
    ).json();
    const response = await request(`sessions/large/files/${file.id}/content`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(Buffer.from(await response.arrayBuffer()).equals(data)).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('returns bounded content status without contents and retains binary reference identity', async () => {
  const { request } = await setup();
  for (const bytes of [
    Buffer.from([65, 0, 66]),
    Buffer.from([65, 255, 66]),
    Buffer.from('sensitive readable text'),
    Buffer.from('a'.repeat(160001)),
  ]) {
    const file = await (
      await request('sessions/A/files', 'POST', {
        name: 'status.dat',
        data: bytes.toString('base64'),
      })
    ).json();
    const response = await request(`sessions/A/files/${file.id}/metadata`);
    expect(response.status).toBe(200);
    const metadata = await response.json();
    expect(metadata).toMatchObject(file);
    expect(metadata).not.toHaveProperty('text');
    expect(metadata).not.toHaveProperty('fileContext');
    expect(metadata.contentStatus.state).toBe(
      bytes.equals(Buffer.from('sensitive readable text')) ? 'readable' : 'unreadable',
    );
    if (bytes.includes(0) || bytes.includes(255))
      expect(metadata.contentStatus.reason).toBe('Unsupported binary or invalid UTF-8 content');
    expect(JSON.stringify(metadata)).not.toContain('sensitive readable text');
  }
});
it('authenticates read-only browsing APIs and preserves reference allocation', async () => {
  const { request } = await setup();
  for (const route of [
    'browse?path=src',
    'preview?path=package.json',
    'find?q=private&mode=content',
  ]) {
    expect((await request('sessions/A/files/' + route, 'GET', undefined, false)).status).toBe(401);
    expect((await request('sessions/A/files/' + route)).status).toBe(200);
  }
  const preview = await (await request('sessions/A/files/preview?path=package.json')).json();
  expect(preview).toMatchObject({ state: 'text', relativePath: 'package.json' });
  expect(preview.path).toBeUndefined();
  expect(preview.text).toContain('gloss');
  expect((await request('sessions/A/files/preview?path=../outside')).status).toBe(400);
  expect(
    await (
      await request('sessions/A/files/reference', 'POST', { relativePath: 'package.json' })
    ).json(),
  ).toMatchObject({ index: 1 });
});
it('keeps internal absolute paths out of missing-file browse, preview and Attach errors', async () => {
  const { request } = await setup();
  for (const route of [
    'browse?path=missing-file-browser-entry',
    'preview?path=missing-file-browser-entry',
    'reference',
  ]) {
    const response = await request(
      'sessions/A/files/' + route,
      route === 'reference' ? 'POST' : 'GET',
      route === 'reference' ? { relativePath: 'missing-file-browser-entry' } : undefined,
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).not.toContain(process.cwd());
    expect(body.error).toContain('unavailable');
  }
});
it('streams preview media only for an authenticated registered session without attaching it', async () => {
  const { request, app } = await setup();
  const route = 'sessions/A/files/media?path=tests%2Ffixtures%2Fpreview-video.webm';
  expect((await request(route, 'GET', undefined, false)).status).toBe(401);
  expect(
    (await request('sessions/unknown/files/media?path=tests%2Ffixtures%2Fpreview-video.webm'))
      .status,
  ).toBe(404);
  const response = await request(route);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('video/webm');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(100);
  expect((await request('sessions/A/files/media?path=README.md')).status).toBe(400);
  expect(app.readWorkspace!('A').data.attachmentIds).toEqual([]);
});
it('locates an entry for Open in Finder only inside the session folder, with the capability', async () => {
  const { request } = await setup();
  const route = 'sessions/A/files/locate?path=package.json';
  expect((await request(route, 'GET', undefined, false)).status).toBe(401);
  expect(await (await request(route)).json()).toEqual({
    path: join(await realpath(process.cwd()), 'package.json'),
    kind: 'file',
  });
  expect(await (await request('sessions/A/files/locate?path=src')).json()).toMatchObject({
    kind: 'directory',
  });
  expect((await request('sessions/A/files/locate?path=..')).status).toBe(400);
  expect((await request('sessions/A/files/locate?path=%2Fetc')).status).toBe(400);
});

it('reviews the complete file, authenticates requests and rejects stale previews', async () => {
  const { request, language, app } = await setup();
  const folder = await mkdtemp(join(process.cwd(), '.file-review-'));
  cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'plan.md');
  const relative = file.slice(process.cwd().length + 1);
  const text = 'A'.repeat(140000) + ' End of file';
  await writeFile(file, text);
  const summary = vi.spyOn(language, 'summarize').mockResolvedValue('תקציר');
  const translation = vi.spyOn(language, 'translate').mockResolvedValue('תרגום מלא');
  const preview = await (
    await request('sessions/A/files/preview?path=' + encodeURIComponent(relative))
  ).json();
  expect(preview.truncated).toBe(true);
  const body = { path: relative, mode: 'summary', version: preview.version };
  expect((await request('sessions/A/files/review', 'POST', body, false)).status).toBe(401);
  expect((await request('sessions/unknown/files/review', 'POST', body)).status).toBe(404);
  const result = await request('sessions/A/files/review', 'POST', body);
  expect(result.status).toBe(200);
  expect((await result.json()).text).toBe('תקציר');
  expect(summary).toHaveBeenCalledWith(text, 'he', expect.any(AbortSignal));
  const statusRoute =
    'sessions/A/files/review-status?path=' +
    encodeURIComponent(relative) +
    '&version=' +
    encodeURIComponent(preview.version);
  expect((await request(statusRoute, 'GET', undefined, false)).status).toBe(401);
  const status = await request(statusRoute);
  expect(status.status).toBe(200);
  expect(status.headers.get('cache-control')).toBe('no-store');
  expect(await status.json()).toEqual({ summary: true, translation: false });
  expect((await request('sessions/A/files/review-status?path=&version=')).status).toBe(400);
  const cached = await request('sessions/A/files/review', 'POST', body);
  expect((await cached.json()).text).toBe('תקציר');
  expect(summary).toHaveBeenCalledTimes(1);
  expect(
    (await request('sessions/A/files/review', 'POST', { ...body, mode: 'translation' })).status,
  ).toBe(200);
  expect(translation).toHaveBeenCalledWith(text, 'Hebrew', expect.any(AbortSignal));
  expect(app.snapshot().snapshot.discussion).toEqual([]);
  await writeFile(file, 'Changed file');
  const stale = await request('sessions/A/files/review', 'POST', body);
  expect(stale.status).toBe(400);
  expect((await stale.json()).error).toContain('File changed');
  expect(summary).toHaveBeenCalledTimes(1);
  summary.mockImplementationOnce(async () => {
    await writeFile(file, 'Changed during summary');
    return 'stale result';
  });
  const changedDuring = await request('sessions/A/files/review', 'POST', {
    path: relative,
    mode: 'summary',
  });
  expect(changedDuring.status).toBe(400);
  expect((await changedDuring.json()).error).toContain('File changed');
  expect(
    (await request('sessions/A/files/review', 'POST', { path: '../outside.txt', mode: 'summary' }))
      .status,
  ).toBe(400);
});
