import { expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error untyped desktop module
import { migrateUserData } from '../../desktop/migrate-user-data.mjs';

function setup(folders: string[]) {
  const appData = mkdtempSync(join(tmpdir(), 'gloss-appdata-'));
  for (const folder of folders) {
    mkdirSync(join(appData, folder));
    writeFileSync(join(appData, folder, 'desktop.json'), folder);
  }
  const renames: string[][] = [];
  const options = {
    appData,
    legacyName: 'language-assistant',
    name: 'Gloss',
    rename: (from: string, to: string) => {
      renames.push([from, to]);
      renameSync(from, to);
    },
    exists: existsSync,
  };
  return { appData, renames, options };
}

it('moves the old settings folder to Gloss', () => {
  const { appData, renames, options } = setup(['language-assistant']);
  expect(migrateUserData(options)).toBe('moved');
  expect(renames).toEqual([[join(appData, 'language-assistant'), join(appData, 'Gloss')]]);
  expect(readFileSync(join(appData, 'Gloss', 'desktop.json'), 'utf8')).toBe('language-assistant');
  expect(existsSync(join(appData, 'language-assistant'))).toBe(false);
});

it('touches nothing when both folders exist', () => {
  const { appData, renames, options } = setup(['language-assistant', 'Gloss']);
  expect(migrateUserData(options)).toBe('both-exist');
  expect(renames).toEqual([]);
  expect(readFileSync(join(appData, 'language-assistant', 'desktop.json'), 'utf8')).toBe(
    'language-assistant',
  );
});

it('keeps the new folder when only it exists, and when neither does', () => {
  expect(migrateUserData(setup(['Gloss']).options)).toBe('kept');
  const fresh = setup([]);
  expect(migrateUserData(fresh.options)).toBe('kept');
  expect(fresh.renames).toEqual([]);
});
