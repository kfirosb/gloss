import { describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDir, legacyDataDir } from '../../src/runtime/data-dir.js';
import {
  migrateDataDir,
  migrationBlockedMessage,
  probeStateDb,
  probeStateDbSync,
  type StateDbUse,
  type SyncRun,
} from '../../src/runtime/data-migration.js';
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

function harness(use: StateDbUse = 'free') {
  const logs: string[] = [];
  const checked: string[] = [];
  return {
    logs,
    checked,
    options: (home: string) => ({
      home,
      probe: async (path: string) => {
        checked.push(path);
        return use;
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

  it('leaves an old folder holding only channel-helper files alone, as legacy-helpers', async () => {
    const home = await tempHome();
    const old = legacyDataDir(home);
    await mkdir(join(old, 'claude-channels'), { recursive: true, mode: 0o700 });
    await writeFile(join(old, 'claude-channels', 'g.json'), 'record');
    await writeFile(join(old, 'claude-channel-ledger.db'), 'ledger');
    await writeFile(join(old, 'claude-channel-ledger.db-journal'), 'journal');
    await mkdir(dataDir(home));
    await writeFile(join(dataDir(home), 'state.db'), 'new');
    const h = harness();
    expect(await migrateDataDir(h.options(home))).toEqual({ kind: 'legacy-helpers' });
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatch(/older Claude channel helpers/);
    expect((await readdir(old)).sort()).toEqual([
      'claude-channel-ledger.db',
      'claude-channel-ledger.db-journal',
      'claude-channels',
    ]);
    expect(await readFile(join(old, 'claude-channels', 'g.json'), 'utf8')).toBe('record');
    expect(await readFile(join(dataDir(home), 'state.db'), 'utf8')).toBe('new');
    expect(h.checked).toEqual([]);
    expect(migrationBlockedMessage({ kind: 'legacy-helpers' }, home)).toBeUndefined();
  });

  it('still calls it both-exist when the old folder holds anything besides helper files', async () => {
    const home = await tempHome();
    const old = legacyDataDir(home);
    await mkdir(join(old, 'claude-channels'), { recursive: true });
    await writeFile(join(old, 'claude-channel-ledger.db'), 'ledger');
    await writeFile(join(old, 'state.db'), 'old');
    await mkdir(dataDir(home));
    expect(await migrateDataDir(harness().options(home))).toEqual({ kind: 'both-exist' });
  });

  describe('channel helpers running across the move', () => {
    const ledger = 'claude-channel-ledger.db';
    const options = (home: string, ledgerUse: StateDbUse) => {
      const h = harness();
      return {
        h,
        options: {
          ...h.options(home),
          probe: async (path: string) => {
            h.checked.push(path);
            return path.endsWith(ledger) ? ledgerUse : 'free';
          },
        },
      };
    };

    it('links the moved ledger at its old path so their writes by that path keep working', async () => {
      const home = await tempHome();
      const old = await seedLegacy(home);
      await writeFile(join(old, ledger), 'ledger');
      const { h, options: o } = options(home, 'in-use');
      expect(await migrateDataDir(o)).toEqual({ kind: 'moved' });
      const next = dataDir(home);
      expect(h.checked).toEqual([join(old, 'state.db'), join(next, ledger)]);
      expect(await readdir(old)).toEqual([ledger]);
      const [linked, moved, folder] = await Promise.all([
        lstat(join(old, ledger)),
        lstat(join(next, ledger)),
        lstat(old),
      ]);
      expect(linked.isSymbolicLink()).toBe(false);
      expect([linked.dev, linked.ino]).toEqual([moved.dev, moved.ino]);
      expect(folder.mode & 0o777).toBe(0o700);
      expect(await readFile(join(next, 'state.db'), 'utf8')).toBe('db');
      expect(h.logs.some((line) => /linked/i.test(line))).toBe(true);
      // The next start sees only helper files in the old folder and leaves them alone.
      expect(await migrateDataDir(o)).toEqual({ kind: 'legacy-helpers' });
    });

    it('recreates nothing when no helper holds the ledger', async () => {
      const home = await tempHome();
      const old = await seedLegacy(home);
      await writeFile(join(old, ledger), 'ledger');
      const { options: o } = options(home, 'free');
      expect(await migrateDataDir(o)).toEqual({ kind: 'moved' });
      expect(await exists(old)).toBe(false);
    });

    it('recreates nothing and asks nothing when there is no ledger', async () => {
      const home = await tempHome();
      const old = await seedLegacy(home);
      const { h, options: o } = options(home, 'in-use');
      expect(await migrateDataDir(o)).toEqual({ kind: 'moved' });
      expect(await exists(old)).toBe(false);
      expect(h.checked).toEqual([join(old, 'state.db')]);
    });

    it('still reports the move when linking fails, and logs why', async () => {
      const home = await tempHome();
      const old = await seedLegacy(home);
      await writeFile(join(old, ledger), 'ledger');
      const { h, options: o } = options(home, 'in-use');
      const result = await migrateDataDir({
        ...o,
        link: async () => {
          throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
        },
      });
      expect(result).toEqual({ kind: 'moved' });
      expect(h.logs.some((line) => /could not link/i.test(line))).toBe(true);
    });
  });

  it('refuses while state.db is open elsewhere', async () => {
    const home = await tempHome();
    const old = await seedLegacy(home);
    expect(await migrateDataDir(harness('in-use').options(home))).toEqual({ kind: 'in-use' });
    expect(await exists(old)).toBe(true);
    expect(await exists(dataDir(home))).toBe(false);
  });

  it('moves nothing when lsof is missing, and says so instead of blaming another copy', async () => {
    const home = await tempHome();
    const old = await seedLegacy(home);
    const result = await migrateDataDir(harness('lsof-missing').options(home));
    expect(result).toEqual({ kind: 'lsof-missing' });
    expect(await exists(old)).toBe(true);
    expect(await exists(dataDir(home))).toBe(false);
    expect(migrationBlockedMessage(result, home)).toMatch(/^Gloss needs lsof to check/);
  });

  it('refuses a move across disks without copying or creating anything', async () => {
    const home = await tempHome();
    const old = await seedLegacy(home);
    const h = harness();
    const result = await migrateDataDir({
      ...h.options(home),
      rename: async () => {
        throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
      },
    });
    expect(result).toEqual({ kind: 'cross-device' });
    expect(await exists(dataDir(home))).toBe(false);
    expect(await readFile(join(old, 'models', 'ggml-small.bin'), 'utf8')).toBe('model');
    expect(h.logs).toHaveLength(1);
    expect(migrationBlockedMessage(result, home)).toBe(
      `Gloss could not move its data from ${old} to ${dataDir(home)} because they are on different disks. Move the folder yourself, then open Gloss again.`,
    );
    expect(migrationBlockedMessage({ kind: 'moved' }, home)).toBeUndefined();
  });
});

const MISSING_WAL =
  'lsof: status error on /home/u/.language-assistant/state.db-wal: No such file or directory';

const fakeRunner = (
  lines: string[],
  code: number | null,
  diagnostics = '',
  calls: string[][] = [],
): ProcessRunner =>
  async function* (executable, args) {
    calls.push([executable, ...args]);
    for (const line of lines) yield { type: 'line', line };
    yield { type: 'exit', outcome: { code, signal: null, reason: 'exited', diagnostics } };
  };
const failingRunner = (reason: 'spawn-error' | 'timeout'): ProcessRunner =>
  async function* () {
    yield { type: 'exit', outcome: { code: null, signal: null, reason, diagnostics: '' } };
  };

describe('probeStateDb', () => {
  const db = '/home/u/.language-assistant/state.db';
  const probe = (runner: ProcessRunner, platform: NodeJS.Platform = 'darwin') =>
    probeStateDb(db, { runner, pid: 42, platform });

  it('asks the platform lsof once about the database and its WAL', async () => {
    const calls: string[][] = [];
    await probe(fakeRunner([], 1, '', calls));
    await probe(fakeRunner([], 1, '', calls), 'linux');
    expect(calls).toEqual([
      ['/usr/sbin/lsof', '-t', '--', db, db + '-wal'],
      ['/usr/bin/lsof', '-t', '--', db, db + '-wal'],
    ]);
  });

  it('is free when lsof finds no process and reports at most a missing path', async () => {
    expect(await probe(fakeRunner([], 1))).toBe('free');
    expect(await probe(fakeRunner([], 1, MISSING_WAL + '\n'))).toBe('free');
  });

  it('is in use when lsof exits 1 with any other message', async () => {
    expect(await probe(fakeRunner([], 1, 'lsof: WARNING: can not stat() fuse file system'))).toBe(
      'in-use',
    );
  });

  it('is in use when another process holds it', async () => {
    expect(await probe(fakeRunner(['42', '977'], 0))).toBe('in-use');
    // lsof exits 1 when the WAL does not exist, while still listing holders of the database.
    expect(await probe(fakeRunner(['977'], 1, MISSING_WAL))).toBe('in-use');
  });

  it('ignores the current process', async () => {
    expect(await probe(fakeRunner(['42'], 0))).toBe('free');
  });

  it('reports a missing lsof separately', async () => {
    expect(await probe(failingRunner('spawn-error'))).toBe('lsof-missing');
  });

  it('fails closed on any other failure', async () => {
    expect(await probe(failingRunner('timeout'))).toBe('in-use');
    expect(await probe(fakeRunner([], 2))).toBe('in-use');
    expect(await probe(fakeRunner(['not-a-pid'], 0))).toBe('in-use');
    expect(await probe(fakeRunner([], 0))).toBe('in-use');
    expect(await probe(fakeRunner([], 1), 'win32')).toBe('in-use');
  });
});

describe('probeStateDbSync', () => {
  const db = '/home/u/.language-assistant/state.db';
  const probe = (result: ReturnType<SyncRun>, calls: unknown[][] = []) =>
    probeStateDbSync(db, {
      pid: 42,
      platform: 'darwin',
      run: (executable, args) => {
        calls.push([executable, args]);
        return result;
      },
    });

  it('applies the same policy as the async probe', () => {
    const calls: unknown[][] = [];
    expect(probe({ status: 1, stdout: '', stderr: MISSING_WAL + '\n' }, calls)).toBe('free');
    expect(calls).toEqual([['/usr/sbin/lsof', ['-t', '--', db, db + '-wal']]]);
    expect(probe({ status: 0, stdout: '42\n', stderr: '' })).toBe('free');
    expect(probe({ status: 0, stdout: '42\n977\n', stderr: '' })).toBe('in-use');
    expect(probe({ status: 1, stdout: '', stderr: 'lsof: unexpected' })).toBe('in-use');
  });

  it('separates a missing lsof from other spawn failures', () => {
    const missing = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    const timeout = Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' });
    expect(probe({ status: null, stdout: '', stderr: '', error: missing })).toBe('lsof-missing');
    expect(probe({ status: null, stdout: '', stderr: '', error: timeout })).toBe('in-use');
  });
});
