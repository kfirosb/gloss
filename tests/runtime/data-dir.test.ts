import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { dataDir, existingDataDir, legacyDataDir } from '../../src/runtime/data-dir.js';
import { packageRoot } from '../../src/runtime/package-root.js';

it('names the data folder under the given home', () => {
  expect(dataDir('/h')).toBe('/h/.gloss');
  expect(legacyDataDir('/h')).toBe('/h/.language-assistant');
});

it('uses the old folder only while it alone exists, so no helper creates the new one first', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gloss-existing-'));
  try {
    expect(existingDataDir(home)).toBe(dataDir(home));
    await mkdir(legacyDataDir(home));
    expect(existingDataDir(home)).toBe(legacyDataDir(home));
    await mkdir(dataDir(home));
    expect(existingDataDir(home)).toBe(dataDir(home));
    await rm(legacyDataDir(home), { recursive: true });
    expect(existingDataDir(home)).toBe(dataDir(home));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
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
