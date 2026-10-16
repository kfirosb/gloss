import { it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveImage, loadImage } from '../../src/runtime/attachments.js';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
it('stores validated images privately and restores their file references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'panel-images-'));
  try {
    const image = await saveImage({ name: 'Screenshot.png', data: png }, root);
    expect(image.mime).toBe('image/png');
    expect(await loadImage(image.id, root)).toEqual(image);
    expect((await readFile(image.path)).toString('base64')).toBe(png);
    await expect(
      saveImage({ name: 'fake.png', data: Buffer.from('not an image').toString('base64') }, root),
    ).rejects.toThrow('Use a PNG');
    await expect(loadImage('../outside', root)).rejects.toThrow('Invalid attachment');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
