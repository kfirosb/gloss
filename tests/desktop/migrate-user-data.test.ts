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
import * as desktopMigration from '../../desktop/migrate-user-data.mjs';

const { migrateUserData, settingsFolders, settleMigration, waitForOlderCopy } = desktopMigration;

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

it('manages the settings folders under appData by default', () => {
  expect(settingsFolders({ appData: '/AppData', explicitUserDataDir: false })).toEqual({
    legacy: join('/AppData', 'language-assistant'),
    next: join('/AppData', 'Gloss'),
  });
});

it('leaves the settings folders alone when started with an explicit --user-data-dir', () => {
  expect(settingsFolders({ appData: '/AppData', explicitUserDataDir: true })).toBeUndefined();
});

it('keeps the new folder when only it exists, and when neither does', () => {
  expect(migrateUserData(setup(['Gloss']).options)).toBe('kept');
  const fresh = setup([]);
  expect(migrateUserData(fresh.options)).toBe('kept');
  expect(fresh.renames).toEqual([]);
});

function dialogs(answers: boolean[]) {
  const events: string[] = [];
  return {
    events,
    ask: async () => {
      const retry = answers.shift() ?? false;
      events.push(retry ? 'retry' : 'quit');
      return retry;
    },
    tell: async (result: { kind: string }) => {
      events.push('tell ' + result.kind);
    },
  };
}

it('retries while the old database is in use, then proceeds', async () => {
  const results = [{ kind: 'in-use' }, { kind: 'in-use' }, { kind: 'moved' }];
  const d = dialogs([true, true]);
  const attempt = async () => results.shift();
  expect(await settleMigration({ attempt, ask: d.ask, tell: d.tell })).toBe('proceed');
  expect(d.events).toEqual(['retry', 'retry']);
  expect(results).toEqual([]);
});

it('stops on Quit without another attempt', async () => {
  let attempts = 0;
  const d = dialogs([false]);
  const attempt = async () => {
    attempts += 1;
    return { kind: 'in-use' };
  };
  expect(await settleMigration({ attempt, ask: d.ask, tell: d.tell })).toBe('quit');
  expect(attempts).toBe(1);
});

it('explains a refusal the user must fix and quits', async () => {
  for (const kind of ['cross-device', 'lsof-missing']) {
    const d = dialogs([]);
    const attempt = async () => ({ kind });
    expect(await settleMigration({ attempt, ask: d.ask, tell: d.tell })).toBe('quit');
    expect(d.events).toEqual(['tell ' + kind]);
  }
});

it('waits for an older copy, then relaunches; Quit quits without relaunching', async () => {
  const run = async (uses: string[], answers: boolean[]) => {
    const d = dialogs(answers);
    const calls: string[] = [];
    await waitForOlderCopy({
      probe: () => uses.shift(),
      ask: d.ask,
      tell: d.tell,
      relaunch: () => calls.push('relaunch'),
      quit: () => calls.push('quit'),
    });
    return [...d.events, ...calls];
  };
  expect(await run(['in-use', 'free'], [true])).toEqual(['retry', 'relaunch']);
  expect(await run(['in-use'], [false])).toEqual(['quit', 'quit']);
  expect(await run(['lsof-missing'], [])).toEqual(['tell lsof-missing', 'quit']);
});
