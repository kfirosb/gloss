import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../../src/runtime/application.js';
import { startServer } from '../../src/runtime/http-server.js';
import { createMediaLinks, parseByteRange } from '../../src/runtime/media-links.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const VIDEO = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'media-links-root-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'media-links-outside-')));
  await writeFile(join(root, 'clip.mp4'), VIDEO);
  await writeFile(join(root, 'song.mp3'), 'audio');
  await writeFile(join(root, 'notes.txt'), 'plain text');
  await writeFile(join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await mkdir(join(root, 'nested'));
  await writeFile(join(outside, 'secret.mp4'), 'outside secret');
  await symlink(join(outside, 'secret.mp4'), join(root, 'escape.mp4'));
  await symlink(outside, join(root, 'linked-dir'));
  const attachmentRoot = await mkdtemp(join(tmpdir(), 'media-links-uploads-'));
  const app = createApplication({
    attachmentRoot,
    store: new SqliteStore(':memory:'),
    agents: [new FakeAgent()],
    conversationId: 'A',
    capability: 'cap',
    languageBackends: {
      codex: { open: async () => new FakeLanguageSession(), models: async () => [] },
    },
  });
  await app.sessions!.register({ agent: 'codex', sessionRef: 'A', projectId: root }, 'A');
  const server = await startServer(app);
  const origin = new URL(server.url).origin;
  cleanup.push(async () => {
    await server.close();
    await app.close();
    for (const dir of [root, outside, attachmentRoot]) await rm(dir, { recursive: true });
  });
  const link = (path: string, auth = true) =>
    fetch(origin + '/api/sessions/A/files/stream-link', {
      method: 'POST',
      headers: {
        ...(auth ? { authorization: 'Bearer cap' } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ path }),
    });
  const linkUrl = async (path: string) => {
    const response = await link(path);
    expect(response.status).toBe(200);
    return origin + ((await response.json()) as { url: string }).url;
  };
  return { root, outside, origin, link, linkUrl };
}

describe('parseByteRange', () => {
  it('reads single, open-ended and suffix ranges and clamps the end', () => {
    expect(parseByteRange(undefined, 10)).toBeUndefined();
    expect(parseByteRange('bytes=0-3', 10)).toEqual({ start: 0, end: 3 });
    expect(parseByteRange('bytes=4-', 10)).toEqual({ start: 4, end: 9 });
    expect(parseByteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseByteRange('bytes=-30', 10)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange('bytes=5-99', 10)).toEqual({ start: 5, end: 9 });
  });
  it('ignores other units and multiple ranges, and rejects malformed or unsatisfiable ones', () => {
    expect(parseByteRange('items=0-3', 10)).toBeUndefined();
    expect(parseByteRange('bytes=0-1,4-5', 10)).toBeUndefined();
    for (const header of [
      'bytes=10-',
      'bytes=5-2',
      'bytes=-0',
      'bytes=-',
      'bytes=a-b',
      'bytes=99999999999999999999-',
    ])
      expect(parseByteRange(header, 10), header).toBe('unsatisfiable');
    expect(parseByteRange('bytes=0-', 0)).toBe('unsatisfiable');
  });
});

describe('media links', () => {
  it('expire after idle time and are bounded per token', () => {
    let time = 0;
    const links = createMediaLinks(() => time);
    const { url } = links.issue('A', 'clip.mp4', '1:2', 'clip.mp4');
    expect(url).toMatch(/^\/api\/media\/[A-Za-z0-9_-]{43}\/clip\.mp4$/);
    expect(links.use(url)).toMatchObject({ sessionId: 'A', relativePath: 'clip.mp4' });
    expect(links.use(url.replace(/\/clip\.mp4$/, ''))).toBeDefined();
    expect(links.use('/api/media/' + 'x'.repeat(43))).toBeUndefined();
    time += 31 * 60_000;
    expect(links.use(url)).toBeUndefined();
  });

  it('refuses issuing without the capability and serves only with a valid token', async () => {
    const { link, linkUrl, origin } = await setup();
    expect((await link('clip.mp4', false)).status).toBe(401);
    const url = await linkUrl('clip.mp4');
    expect((await fetch(origin + '/api/media/' + 'A'.repeat(43) + '/clip.mp4')).status).toBe(404);
    expect((await fetch(origin + '/api/media/short')).status).toBe(404);
    const full = await fetch(url);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('video/mp4');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await full.arrayBuffer()).equals(VIDEO)).toBe(true);
    expect((await fetch(url, { method: 'POST' })).status).toBe(405);
  });

  it('answers a range request with 206 and the exact bytes', async () => {
    const { linkUrl } = await setup();
    const url = await linkUrl('clip.mp4');
    const part = await fetch(url, { headers: { range: 'bytes=100-199' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect(part.headers.get('content-length')).toBe('100');
    expect(Buffer.from(await part.arrayBuffer()).equals(VIDEO.subarray(100, 200))).toBe(true);
    const tail = await fetch(url, { headers: { range: 'bytes=-10' } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get('content-range')).toBe('bytes 990-999/1000');
    expect(Buffer.from(await tail.arrayBuffer()).equals(VIDEO.subarray(990))).toBe(true);
    const head = await fetch(url, { method: 'HEAD', headers: { range: 'bytes=0-' } });
    expect(head.status).toBe(206);
    expect(head.headers.get('content-range')).toBe('bytes 0-999/1000');
  });

  it('answers an unsatisfiable or malformed range with 416', async () => {
    const { linkUrl } = await setup();
    const url = await linkUrl('clip.mp4');
    for (const range of ['bytes=1000-', 'bytes=500-100', 'bytes=x-y']) {
      const response = await fetch(url, { headers: { range } });
      expect(response.status, range).toBe(416);
      expect(response.headers.get('content-range')).toBe('bytes */1000');
      expect((await response.arrayBuffer()).byteLength).toBe(0);
    }
  });

  it('refuses paths outside the folder: symlinks, traversal, absolute and encoded paths', async () => {
    const { link, outside } = await setup();
    for (const path of [
      'escape.mp4',
      'linked-dir/secret.mp4',
      '../' + outside.split('/').at(-1) + '/secret.mp4',
      'nested/../../' + outside.split('/').at(-1) + '/secret.mp4',
      join(outside, 'secret.mp4'),
      '%2e%2e/secret.mp4',
      'clip.mp4\0.txt',
    ]) {
      const response = await link(path);
      expect(response.status, path).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).not.toContain(outside);
    }
    // Kinds that are not streamed, and folders, are refused too.
    expect((await link('notes.txt')).status).toBe(400);
    expect((await link('nested')).status).toBe(400);
  });

  it('re-checks the folder on every request, so a later symlink swap cannot escape', async () => {
    const { root, outside, linkUrl } = await setup();
    const url = await linkUrl('song.mp3');
    expect((await fetch(url)).status).toBe(200);
    await rename(join(root, 'song.mp3'), join(root, 'song-old.mp3'));
    await writeFile(join(outside, 'song.mp3'), 'outside audio');
    await symlink(join(outside, 'song.mp3'), join(root, 'song.mp3'));
    const swapped = await fetch(url);
    expect(swapped.status).toBe(404);
    expect(await swapped.text()).not.toContain('outside audio');
  });

  it('refuses a link once the file is replaced by another file', async () => {
    const { root, linkUrl } = await setup();
    const url = await linkUrl('clip.mp4');
    await rm(join(root, 'clip.mp4'));
    await writeFile(join(root, 'clip.mp4'), 'replacement');
    expect((await fetch(url)).status).toBe(404);
  });

  it('serves SVG sandboxed so it cannot run as a page', async () => {
    const { linkUrl } = await setup();
    const response = await fetch(await linkUrl('icon.svg'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
  });
});
