import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { link, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CHANNEL_LEDGER_FILE,
  CHANNEL_REGISTRY_DIR,
} from '../../src/agents/claude/channel-names.js';
import { ChannelStore } from '../../src/agents/claude/channel-store.js';
import {
  channelLedgerPath,
  createLegacyLedgerPruner,
  pruneLegacyLedgerLink,
} from '../../src/agents/claude/legacy-ledger.js';

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A new folder with its ledger and an old folder, as the move leaves them; `linked` adds the hard link. */
async function folders(linked = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'legacy-ledger-')));
  cleanups.push(root);
  const stateDir = join(root, 'new');
  const legacyStateDir = join(root, 'old');
  await mkdir(stateDir, { mode: 0o700 });
  await mkdir(legacyStateDir, { mode: 0o700 });
  const ledger = join(stateDir, CHANNEL_LEDGER_FILE);
  const alias = join(legacyStateDir, CHANNEL_LEDGER_FILE);
  await writeFile(ledger, '', { mode: 0o600 });
  if (linked) await link(ledger, alias);
  return { root, stateDir, legacyStateDir, ledger, alias };
}

describe('channelLedgerPath', () => {
  it('names the old folder’s link while it is the same file as the new ledger', async () => {
    const f = await folders();
    expect(channelLedgerPath(f.stateDir, f.legacyStateDir)).toBe(f.alias);
  });

  it('names the new ledger without a link, with a different file, or with a symlink', async () => {
    const f = await folders(false);
    expect(channelLedgerPath(f.stateDir, f.legacyStateDir)).toBe(f.ledger);
    await writeFile(f.alias, '', { mode: 0o600 });
    expect(channelLedgerPath(f.stateDir, f.legacyStateDir)).toBe(f.ledger);
    await rm(f.alias);
    await symlink(f.ledger, f.alias);
    expect(channelLedgerPath(f.stateDir, f.legacyStateDir)).toBe(f.ledger);
    expect(channelLedgerPath(f.stateDir)).toBe(f.ledger);
  });

  it('lets the next opener roll back a journal a crashed writer left under the old name', async () => {
    const f = await folders(false);
    const setup = new DatabaseSync(f.ledger);
    setup.exec(`PRAGMA journal_mode = DELETE;
      CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT);
      INSERT INTO t (value) VALUES ('committed');`);
    setup.close();
    await link(f.ledger, f.alias);
    const writerPath = channelLedgerPath(f.stateDir, f.legacyStateDir);
    expect(writerPath).toBe(f.alias);
    // A writer that dies mid-commit: a tiny cache spills changed pages into the database before the commit.
    const crash = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        '-e',
        `const { DatabaseSync } = require('node:sqlite');
         const db = new DatabaseSync(process.argv[1]);
         db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA cache_size = 1;");
         db.exec('BEGIN');
         db.exec("UPDATE t SET value = 'uncommitted'");
         for (let i = 0; i < 400; i++) db.prepare('INSERT INTO t (value) VALUES (?)').run('x'.repeat(2000));
         process.kill(process.pid, 'SIGKILL');`,
        writerPath,
      ],
      { encoding: 'utf8' },
    );
    expect(crash.signal).toBe('SIGKILL');
    expect(existsSync(f.alias + '-journal')).toBe(true);
    expect(existsSync(f.ledger + '-journal')).toBe(false);
    // Every opener resolves the same name, so the journal is found and rolled back.
    const next = new DatabaseSync(channelLedgerPath(f.stateDir, f.legacyStateDir));
    try {
      expect(next.prepare('SELECT value FROM t').all()).toEqual([{ value: 'committed' }]);
    } finally {
      next.close();
    }
    expect(existsSync(f.alias + '-journal')).toBe(false);
  });

  it('never creates a ledger when told to open an existing one only', async () => {
    const f = await folders(false);
    expect(() => new ChannelStore(f.alias, { create: false })).toThrow(
      expect.objectContaining({ code: 'ENOENT' }),
    );
    expect(existsSync(f.alias)).toBe(false);
  });
});

describe('pruneLegacyLedgerLink', () => {
  const prune = (f: Awaited<ReturnType<typeof folders>>, inUse: boolean, logs: string[] = []) =>
    pruneLegacyLedgerLink({
      stateDir: f.stateDir,
      legacyStateDir: f.legacyStateDir,
      inUse: async () => inUse,
      log: (message) => logs.push(message),
    });

  it('keeps the link while a helper from before the move is alive, and removes it after', async () => {
    const f = await folders();
    await mkdir(join(f.legacyStateDir, CHANNEL_REGISTRY_DIR), { mode: 0o700 });
    const logs: string[] = [];
    expect(await prune(f, true, logs)).toBe('kept');
    expect(existsSync(f.alias)).toBe(true);
    expect(await prune(f, false, logs)).toBe('removed');
    expect(existsSync(f.legacyStateDir)).toBe(false);
    expect(existsSync(f.ledger)).toBe(true);
    expect(logs).toHaveLength(1);
    expect(await prune(f, false, logs)).toBe('absent');
    expect(logs).toHaveLength(1);
  });

  it('keeps the link while a journal sits beside it', async () => {
    const f = await folders();
    await writeFile(f.alias + '-journal', 'hot');
    expect(await prune(f, false)).toBe('kept');
    expect(existsSync(f.alias)).toBe(true);
  });

  it('never removes an old-folder ledger that is a different file', async () => {
    const f = await folders(false);
    await writeFile(f.alias, 'separate', { mode: 0o600 });
    expect(await prune(f, false)).toBe('kept');
    expect(existsSync(f.alias)).toBe(true);
  });

  it('removes only the link from a folder that holds anything else', async () => {
    const f = await folders();
    await mkdir(join(f.legacyStateDir, CHANNEL_REGISTRY_DIR), { mode: 0o700 });
    await writeFile(join(f.legacyStateDir, CHANNEL_REGISTRY_DIR, 'stale.json'), '{}');
    await writeFile(join(f.legacyStateDir, 'notes.txt'), 'mine');
    expect(await prune(f, false)).toBe('removed');
    expect((await readdir(f.legacyStateDir)).sort()).toEqual([CHANNEL_REGISTRY_DIR, 'notes.txt']);
    expect(await readdir(join(f.legacyStateDir, CHANNEL_REGISTRY_DIR))).toEqual(['stale.json']);
  });

  it('asks the registries by default and keeps the link when they cannot be read safely', async () => {
    const f = await folders();
    // The new registry folder is not private: in doubt, the link stays.
    await mkdir(join(f.stateDir, CHANNEL_REGISTRY_DIR), { mode: 0o755 });
    const pruneOnce = createLegacyLedgerPruner({
      stateDir: f.stateDir,
      legacyStateDir: f.legacyStateDir,
      log: () => {},
    });
    expect(await pruneOnce()).toBe('kept');
    await rm(join(f.stateDir, CHANNEL_REGISTRY_DIR), { recursive: true });
    expect(await pruneOnce()).toBe('removed');
  });
});
