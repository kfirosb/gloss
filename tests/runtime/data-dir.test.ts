import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { dataDir, legacyDataDir } from '../../src/runtime/data-dir.js';
import { packageRoot } from '../../src/runtime/package-root.js';

it('names the data folder under the given home', () => {
  expect(dataDir('/h')).toBe('/h/.gloss');
  expect(legacyDataDir('/h')).toBe('/h/.language-assistant');
});

it('finds the package root by the package name gloss', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gloss-root-'));
  try {
    await mkdir(join(root, 'a', 'b'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'gloss' }));
    expect(packageRoot(join(root, 'a', 'b'))).toBe(root);
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'language-assistant' }));
    expect(packageRoot(join(root, 'a', 'b'))).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
