import { test, expect } from 'vitest';
import { mkdtemp, realpath, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileBrowser } from '../../src/runtime/file-browser.js';
import { readReferenceChunks } from '../../src/runtime/file-content.js';

test('preview media reads a local video without registering it and rejects escapes and non-media', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'preview-media-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'outside-media-')));
  try {
    await writeFile(join(root, 'clip.webm'), 'video bytes');
    await writeFile(join(root, 'secret.txt'), 'private');
    await writeFile(join(outside, 'clip.webm'), 'outside');
    await symlink(join(outside, 'clip.webm'), join(root, 'escape.webm'));
    const browser = createFileBrowser(() => root);
    const signal = new AbortController().signal;
    const file = await browser.media('session', 'clip.webm', signal);
    expect(file.mime).toBe('video/webm');
    const chunks = [];
    for await (const chunk of readReferenceChunks(file)) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('video bytes');
    await expect(browser.media('session', 'escape.webm', signal)).rejects.toThrow('outside');
    await expect(browser.media('session', '../clip.webm', signal)).rejects.toThrow('outside');
    await expect(browser.media('session', 'secret.txt', signal)).rejects.toThrow('media');
  } finally {
    await rm(root, { recursive: true });
    await rm(outside, { recursive: true });
  }
});
