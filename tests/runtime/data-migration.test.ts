import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDir, legacyDataDir } from '../../src/runtime/data-dir.js';
import { migrateDataDir, stateDbInUse } from '../../src/runtime/data-migration.js';
import type { ProcessRunner } from '../../src/runtime/process-runner.js';

const tempHome = () => mkdtemp(join(tmpdir(), 'gloss-migrate-'));
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

async function seedLegacy(home: string) {
  const old = legacyDataDir(home);
  await mkdir(join(old, 'models'), { recursive: true });
  await mkdir(join(old, 'tmux'), { recursive: true });
  await writeFile(join(old, 'state.db'), 'db');
  await writeFile(join(old, 'models', 'ggml-small.bin'), 'model');
  await writeFile(join(old, 'tmux', 'socket'), '');
  return old;
}

function harness(inUse = false) {
  const logs: string[] = [];
  const checked: string[] = [];
  return {
    logs,
    checked,
    options: (home: string) => ({
      home,
      inUse: async (path: string) => {
        checked.push(path);
        return inUse;
      },
      log: (message: string) => logs.push(message),
    }),
  };
}

describe('migrateDataDir', () => {
  it('moves the old folder in one rename, keeping every file', async () => {
    const home = await tempHome();
    const old = await seedLegacy(home);
    const h = harness();
    expect(await migrateDataDir(h.options(home))).toEqual({ kind: 'moved' });
    expect(await exists(old)).toBe(false);
    const next = dataDir(home);
    expect(await readFile(join(next, 'state.db'), 'utf8')).toBe('db');
    expect(await readFile(join(next, 'models', 'ggml-small.bin'), 'utf8')).toBe('model');
    expect(await exists(join(next, 'tmux', 'socket'))).toBe(true);
    expect(h.checked).toEqual([join(old, 'state.db')]);
  });

  it('uses the new folder when only it exists', async () => {
    const home = await tempHome();
    await mkdir(dataDir(home));
    expect(await migrateDataDir(harness().options(home))).toEqual({ kind: 'already-new' });
  });

  it('reports a fresh start when neither folder exists', async () => {
    const home = await tempHome();
    expect(await migrateDataDir(harness().options(home))).toEqual({ kind: 'fresh' });
    expect(await exists(dataDir(home))).toBe(false);
  });

  it('never merges when both exist: touches nothing and logs once', async () => {
    const home = await tempHome();
    const old = await seedLegacy(home);
    await mkdir(dataDir(home));
    await writeFile(join(dataDir(home), 'state.db'), 'new');
    const h = harness();
    expect(await migrateDataDir(h.options(home))).toEqual({ kind: 'both-exist' });
    expect(h.logs).toHaveLength(1);
    expect(await readFile(join(old, 'state.db'), 'utf8')).toBe('db');
    expect(await readFile(join(dataDir(home), 'state.db'), 'utf8')).toBe('new');
    expect(h.checked).toEqual([]);
  });

  it('treats an empty new folder as both-exist instead of merging into it', async () => {
    const home = await tempHome();
    const old = await seedLegacy(home);
    await mkdir(dataDir(home));
    expect(await migrateDataDir(harness().options(home))).toEqual({ kind: 'both-exist' });
    expect(await readdir(dataDir(home))).toEqual([]);
    expect((await readdir(old)).sort()).toEqual(['models', 'state.db', 'tmux']);
  });

  it('refuses while state.db is open elsewhere', async () => {
    const home = await tempHome();
    const old = await seedLegacy(home);
    expect(await migrateDataDir(harness(true).options(home))).toEqual({ kind: 'in-use' });
    expect(await exists(old)).toBe(true);
    expect(await exists(dataDir(home))).toBe(false);
  });
});

const fakeRunner = (lines: string[], code: number | null, calls: string[][] = []): ProcessRunner =>
  async function* (executable, args) {
    calls.push([executable, ...args]);
    for (const line of lines) yield { type: 'line', line };
    yield {
      type: 'exit',
      outcome: { code, signal: null, reason: 'exited', diagnostics: '' },
    };
  };
const failingRunner: ProcessRunner = async function* () {
  yield {
    type: 'exit',
    outcome: { code: null, signal: null, reason: 'spawn-error', diagnostics: '' },
  };
};

describe('stateDbInUse', () => {
  const db = '/home/u/.language-assistant/state.db';

  it('asks lsof once about the database and its WAL', async () => {
    const calls: string[][] = [];
    await stateDbInUse(db, { runner: fakeRunner([], 1, calls), pid: 42 });
    expect(calls).toEqual([['lsof', '-t', '--', db, db + '-wal']]);
  });

  it('is free when lsof finds no process', async () => {
    expect(await stateDbInUse(db, { runner: fakeRunner([], 1), pid: 42 })).toBe(false);
  });

  it('is in use when another process holds it', async () => {
    expect(await stateDbInUse(db, { runner: fakeRunner(['42', '977'], 0), pid: 42 })).toBe(true);
    // lsof exits 1 when one of the files (the WAL) does not exist, while still listing holders of the other.
    expect(await stateDbInUse(db, { runner: fakeRunner(['977'], 1), pid: 42 })).toBe(true);
  });

  it('ignores the current process', async () => {
    expect(await stateDbInUse(db, { runner: fakeRunner(['42'], 0), pid: 42 })).toBe(false);
  });

  it('fails closed when lsof cannot run or fails', async () => {
    expect(await stateDbInUse(db, { runner: failingRunner, pid: 42 })).toBe(true);
    expect(await stateDbInUse(db, { runner: fakeRunner([], 2), pid: 42 })).toBe(true);
    expect(await stateDbInUse(db, { runner: fakeRunner(['not-a-pid'], 0), pid: 42 })).toBe(true);
  });
});
