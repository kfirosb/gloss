import { test, expect } from 'vitest';
import { mkdtemp, realpath, writeFile, symlink, rm, truncate } from 'node:fs/promises';
import { MAX_STREAMED_PREVIEW_BYTES } from '../../src/core/content-policy.js';
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

test('preview names the kind: streamed media, SVG source, archives and binaries', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'preview-kinds-')));
  try {
    await writeFile(join(root, 'clip.mov'), Buffer.from([0, 1, 2]));
    await writeFile(join(root, 'voice.m4a'), Buffer.from([0, 1, 2]));
    await writeFile(join(root, 'manual.pdf'), '%PDF-1.4');
    await writeFile(join(root, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(join(root, 'bundle.zip'), Buffer.from([0x50, 0x4b, 3, 4, 0]));
    await writeFile(join(root, 'tool.bin'), Buffer.from([0x7f, 0x45, 0, 0]));
    const browser = createFileBrowser(() => root);
    const signal = new AbortController().signal;
    expect(await browser.preview('s', 'clip.mov', signal)).toMatchObject({
      state: 'stream',
      kind: 'video',
    });
    expect(await browser.preview('s', 'voice.m4a', signal)).toMatchObject({
      state: 'stream',
      kind: 'audio',
    });
    const pdf = await browser.preview('s', 'manual.pdf', signal);
    expect(pdf).toMatchObject({ state: 'stream', kind: 'pdf' });
    expect(pdf.text).toBeUndefined();
    expect(await browser.preview('s', 'logo.svg', signal)).toMatchObject({
      state: 'text',
      kind: 'svg',
    });
    expect(await browser.preview('s', 'bundle.zip', signal)).toMatchObject({
      state: 'binary',
      kind: 'archive',
    });
    expect(await browser.preview('s', 'tool.bin', signal)).toMatchObject({
      state: 'binary',
      kind: 'binary',
    });
    expect((await browser.streamable('s', 'manual.pdf', signal)).file.mime).toBe('application/pdf');
    await expect(browser.streamable('s', 'bundle.zip', signal)).rejects.toThrow('streamed');
  } finally {
    await rm(root, { recursive: true });
  }
});

test('each streamed kind has its own size limit', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'preview-limits-')));
  try {
    // Sparse files: the size is reported without writing the bytes.
    await writeFile(join(root, 'long.wav'), '');
    await truncate(join(root, 'long.wav'), MAX_STREAMED_PREVIEW_BYTES.audio + 1);
    await writeFile(join(root, 'ok.webm'), '');
    await truncate(join(root, 'ok.webm'), MAX_STREAMED_PREVIEW_BYTES.audio + 1);
    const browser = createFileBrowser(() => root);
    const signal = new AbortController().signal;
    expect(await browser.preview('s', 'long.wav', signal)).toMatchObject({
      state: 'large',
      kind: 'audio',
    });
    await expect(browser.streamable('s', 'long.wav', signal)).rejects.toThrow(
      'Audio exceeds the 512 MiB preview limit.',
    );
    // The same size is within the video limit.
    expect(await browser.preview('s', 'ok.webm', signal)).toMatchObject({ state: 'stream' });
  } finally {
    await rm(root, { recursive: true });
  }
});
