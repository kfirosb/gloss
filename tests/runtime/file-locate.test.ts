import { test, expect } from 'vitest';
import { mkdir, mkdtemp, realpath, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createFileBrowser } from '../../src/runtime/file-browser.js';

test('locate resolves files and folders inside the session folder and rejects escapes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'locate-root-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'locate-outside-')));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'notes.txt'), 'note');
    await writeFile(join(outside, 'secret.txt'), 'private');
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
    await symlink(outside, join(root, 'escape-dir'));
    await symlink(join(root, 'src', 'notes.txt'), join(root, 'inside-link.txt'));
    const browser = createFileBrowser(() => root);
    const signal = new AbortController().signal;
    expect(await browser.locate('session', 'src/notes.txt', signal)).toEqual({
      path: join(root, 'src', 'notes.txt'),
      kind: 'file',
    });
    expect(await browser.locate('session', 'src', signal)).toEqual({
      path: join(root, 'src'),
      kind: 'directory',
    });
    expect(await browser.locate('session', '', signal)).toEqual({ path: root, kind: 'directory' });
    // A link that stays inside resolves to its real target.
    expect((await browser.locate('session', 'inside-link.txt', signal)).path).toBe(
      join(root, 'src', 'notes.txt'),
    );
    await expect(browser.locate('session', '..', signal)).rejects.toThrow('outside');
    await expect(
      browser.locate('session', `src/../../${basename(outside)}/secret.txt`, signal),
    ).rejects.toThrow('outside');
    await expect(browser.locate('session', 'escape.txt', signal)).rejects.toThrow('outside');
    await expect(browser.locate('session', 'escape-dir', signal)).rejects.toThrow('outside');
    await expect(browser.locate('session', join(outside, 'secret.txt'), signal)).rejects.toThrow(
      'relative',
    );
    await expect(browser.locate('session', 'missing.txt', signal)).rejects.toThrow('ENOENT');
    await expect(browser.locate('session', 'src\0', signal)).rejects.toThrow('relative');
  } finally {
    await rm(root, { recursive: true });
    await rm(outside, { recursive: true });
  }
});
