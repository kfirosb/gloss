import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Target } from '../../src/core/contracts.js';
import type { ChannelKey, ChannelReply } from '../../src/agents/claude/channel-types.js';
import { ChannelStore } from '../../src/agents/claude/channel-store.js';

let root: string;
let path: string;
let target: Target;
let stores: ChannelStore[];
const nativeSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherNativeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const key: ChannelKey = {
  panelSessionId: 'panel-1',
  nativeSessionId,
  generation: 'generation-1',
  requestId: 'request-1',
};
const openStore = () => {
  const store = new ChannelStore(path);
  stores.push(store);
  return store;
};
const registeredStore = () => {
  const store = openStore();
  store.registerGeneration(key.generation, target);
  return store;
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-channel-store-')));
  path = join(root, 'private', 'ledger.db');
  mkdirSync(join(root, 'project'));
  mkdirSync(join(root, 'other-project'));
  target = { agent: 'claude', sessionRef: nativeSessionId, projectId: join(root, 'project') };
  stores = [];
});
afterEach(() => {
  for (const store of stores) store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('ChannelStore', () => {
  it('uses DELETE journaling and FULL durability on every writer connection and reopen', () => {
    const first = registeredStore();
    for (const writer of [first, openStore()]) {
      // Inspect the actual connection: synchronous is connection-local.
      const db = (writer as unknown as { database: DatabaseSync }).database;
      expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('delete');
      expect(db.prepare('PRAGMA synchronous').get()?.synchronous).toBe(2);
    }
    first.claim(key, 'durable');
    first.recordReply(key, 'persisted');
    for (const store of stores) store.close();
    const reopened = openStore();
    expect(reopened.claim(key, 'durable')).toBe('existing');
    expect(reopened.readReply(key)?.text).toBe('persisted');
    expect(existsSync(path + '-wal')).toBe(false);
  });

  it('fails closed while a legacy WAL reader prevents conversion, then converts without losing data', () => {
    const initial = registeredStore();
    initial.claim(key, 'legacy');
    initial.recordReply(key, 'legacy answer');
    initial.close();
    const legacy = new DatabaseSync(path);
    legacy.exec('PRAGMA journal_mode = WAL; BEGIN');
    legacy.prepare('SELECT * FROM requests').all();
    try {
      expect(() => openStore()).toThrow(/locked|busy/i);
      expect(legacy.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
      expect(legacy.prepare('SELECT COUNT(*) AS count FROM requests').get()?.count).toBe(1);
    } finally {
      legacy.exec('ROLLBACK');
      legacy.close();
    }
    const converted = openStore();
    expect(converted.claim(key, 'legacy')).toBe('existing');
    expect(converted.readReply(key)?.text).toBe('legacy answer');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('delete');
    } finally {
      db.close();
    }
  }, 10000);

  it('opens read-only without creating a missing database or its parent', () => {
    expect(() => {
      const reader = new ChannelStore(path, { readOnly: true });
      stores.push(reader);
    }).toThrow();
    expect(existsSync(join(root, 'private'))).toBe(false);
    mkdirSync(join(root, 'private'));
    expect(() => {
      const reader = new ChannelStore(path, { readOnly: true });
      stores.push(reader);
    }).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it('opens read-only without permission repair or schema initialization', () => {
    mkdirSync(join(root, 'private'));
    const empty = new DatabaseSync(path);
    empty.exec('CREATE TABLE unrelated (value TEXT)');
    empty.close();
    chmodSync(path, 0o400);
    const original = readFileSync(path);
    const reader = new ChannelStore(path, { readOnly: true });
    stores.push(reader);
    expect(() => reader.readReply(key)).toThrow(/no such table/);
    expect(statSync(path).mode & 0o777).toBe(0o400);
    expect(readFileSync(path)).toEqual(original);
    const inspection = new DatabaseSync(path, { readOnly: true });
    try {
      expect(
        inspection
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => row.name),
      ).toEqual(['unrelated']);
    } finally {
      inspection.close();
    }
  });

  it('reads committed replies under a reserved writer lock, observes later commits and rejects mutation', () => {
    const writer = registeredStore();
    writer.claim(key, 'question');
    const reply = writer.recordReply(key, 'answer');
    const lock = new DatabaseSync(path);
    lock.exec('BEGIN IMMEDIATE');
    let reader: ChannelStore;
    try {
      reader = new ChannelStore(path, { readOnly: true });
      stores.push(reader);
      expect(reader.readReply(key)).toEqual(reply);
      expect(reader.replies(target, 0, 100, 'panel-1')).toEqual([reply]);
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
    }
    const nextKey = { ...key, requestId: 'next' };
    writer.claim(nextKey, 'next');
    const next = writer.recordReply(nextKey, 'next answer');
    expect(reader.replies(target, reply.sequence, 100, 'panel-1')).toEqual([next]);
    expect(() => reader.claim({ ...key, requestId: 'must-not-write' }, 'no')).toThrow(/read.only/i);
    expect(() => reader.registerGeneration('must-not-register', target)).toThrow(/read.only/i);
    expect(() => reader.recordReply(key, 'replacement')).toThrow(/read.only/i);
    expect(writer.lookupRequest(key.generation, 'must-not-write')).toBeUndefined();
  }, 10000);

  it('refuses read-only symlink and directory paths without changing the destination', () => {
    registeredStore().close();
    const original = readFileSync(path);
    const alias = join(root, 'alias.db');
    symlinkSync(path, alias);
    expect(() => new ChannelStore(alias, { readOnly: true })).toThrow();
    expect(() => new ChannelStore(root, { readOnly: true })).toThrow();
    expect(readFileSync(path)).toEqual(original);
  });
  it('retains committed claims and immutable replies when reopened', () => {
    const first = registeredStore();
    expect(first.claim(key, 'review this')).toBe('new');
    expect(first.readReply(key)).toBeUndefined();
    const reply = first.recordReply(key, 'reviewed');
    expect(reply).toEqual({ key, text: 'reviewed', sequence: 1, timestamp: expect.any(String) });
    expect(Number.isNaN(Date.parse(reply.timestamp))).toBe(false);
    first.close();

    const second = openStore();
    expect(second.claim(key, 'review this')).toBe('existing');
    expect(second.readReply(key)).toEqual(reply);
    expect(second.replies(target, 0, 100)).toEqual([reply]);
    expect(second.lookupRequest(key.generation, key.requestId)).toEqual(key);
  });

  it('keeps unresolved claims across reopen without creating a reply or replaying them', () => {
    const store = registeredStore();
    store.claim(key, 'pending');
    store.close();
    const reopened = openStore();
    expect(reopened.claim(key, 'pending')).toBe('existing');
    expect(reopened.readReply(key)).toBeUndefined();
    expect(reopened.replies(target, 0, 100)).toEqual([]);
  });

  it('returns existing only for identical text and generation, including after rotation', () => {
    const store = registeredStore();
    expect(store.claim(key, 'original')).toBe('new');
    expect(store.claim(key, 'original')).toBe('existing');
    expect(store.claim(key, 'changed')).toBe('conflict');
    store.registerGeneration('generation-2', target);
    expect(store.claim({ ...key, generation: 'generation-2' }, 'original')).toBe('conflict');
    expect(store.lookupRequest('generation-2', key.requestId)).toBeUndefined();
    expect(store.claim(key, 'original')).toBe('existing');
  });

  it('requires registration and rejects keys whose native session does not match it', () => {
    const store = openStore();
    expect(() => store.claim(key, 'hello')).toThrow();
    store.registerGeneration(key.generation, target);
    expect(() => store.claim({ ...key, nativeSessionId: otherNativeId }, 'hello')).toThrow();
    expect(store.lookupRequest(key.generation, key.requestId)).toBeUndefined();
  });

  it('persists immutable generation and native-session project registrations', () => {
    const store = registeredStore();
    store.close();
    const reopened = openStore();
    expect(() => reopened.registerGeneration(key.generation, target)).not.toThrow();
    expect(() =>
      reopened.registerGeneration(key.generation, { ...target, sessionRef: otherNativeId }),
    ).toThrow();
    expect(() =>
      reopened.registerGeneration(key.generation, {
        ...target,
        projectId: join(root, 'other-project'),
      }),
    ).toThrow();
    expect(() =>
      reopened.registerGeneration('generation-2', {
        ...target,
        projectId: join(root, 'other-project'),
      }),
    ).toThrow();
    // Failed registration must not reserve the generation or corrupt the first binding.
    reopened.registerGeneration('generation-2', target);
    expect(reopened.claim(key, 'hello')).toBe('new');
  });

  it('canonicalizes project aliases for registration and project-scoped reads', () => {
    symlinkSync(target.projectId, join(root, 'alias'));
    const alias = { ...target, projectId: join(root, 'alias') };
    const store = openStore();
    store.registerGeneration(key.generation, alias);
    store.registerGeneration(key.generation, target);
    store.claim(key, 'hello');
    const reply = store.recordReply(key, 'answer');
    expect(store.replies(target, 0, 100)).toEqual([reply]);
    expect(store.replies(alias, 0, 100)).toEqual([reply]);
  });

  it('rejects non-Claude, invalid native, relative and absent project registrations', () => {
    const store = openStore();
    for (const invalid of [
      { ...target, agent: 'codex' as const },
      { ...target, sessionRef: 'not-a-uuid' },
      { ...target, projectId: '.' },
      { ...target, projectId: join(root, 'missing') },
    ])
      expect(() => store.registerGeneration(key.generation, invalid)).toThrow();
    expect(() => store.registerGeneration('', target)).toThrow();
    store.registerGeneration(key.generation, target);
    expect(store.claim(key, 'hello')).toBe('new');
  });

  it('resolves only unique generation/request pairs and rejects cross-panel ambiguity', () => {
    const store = registeredStore();
    expect(store.lookupRequest('unknown', key.requestId)).toBeUndefined();
    expect(store.lookupRequest(key.generation, 'unknown')).toBeUndefined();
    store.claim(key, 'hello');
    expect(store.lookupRequest(key.generation, key.requestId)).toEqual(key);
    store.claim({ ...key, panelSessionId: 'panel-2' }, 'hello');
    expect(() => store.lookupRequest(key.generation, key.requestId)).toThrow(/ambiguous/i);
    store.registerGeneration('generation-2', { ...target, sessionRef: otherNativeId });
    const independent = { ...key, nativeSessionId: otherNativeId, generation: 'generation-2' };
    store.claim(independent, 'hello');
    expect(store.lookupRequest('generation-2', key.requestId)).toEqual(independent);
  });

  it('rejects unknown replies and all mismatched key components', () => {
    const store = registeredStore();
    expect(() => store.recordReply(key, 'unclaimed')).toThrow();
    store.claim(key, 'hello');
    store.registerGeneration('generation-2', target);
    for (const changed of [
      { requestId: 'unknown' },
      { panelSessionId: 'panel-2' },
      { generation: 'generation-2' },
      { nativeSessionId: otherNativeId },
    ]) {
      expect(() => store.recordReply({ ...key, ...changed }, 'wrong reply')).toThrow();
      expect(store.readReply({ ...key, ...changed })).toBeUndefined();
    }
    expect(store.replies(target, 0, 100)).toEqual([]);
  });

  it('returns the original reply for identical and differing duplicates without consuming a sequence', () => {
    const store = registeredStore();
    store.claim(key, 'hello');
    const original = store.recordReply(key, 'first');
    expect(store.recordReply(key, 'first')).toEqual(original);
    expect(store.recordReply(key, 'changed')).toEqual(original);
    store.close();
    const reopened = openStore();
    const nextKey = { ...key, requestId: 'request-2' };
    reopened.claim(nextKey, 'next');
    expect(reopened.recordReply(nextKey, 'second').sequence).toBe(2);
    expect(reopened.readReply(key)).toEqual(original);
  });

  it('scopes paged replies by canonical project, native session and optional panel before applying limit', () => {
    const store = registeredStore();
    const secondTarget = { ...target, sessionRef: otherNativeId };
    store.registerGeneration('generation-2', secondTarget);
    const keys = [
      { ...key, panelSessionId: 'panel-2' },
      key,
      { ...key, nativeSessionId: otherNativeId, generation: 'generation-2' },
      { ...key, requestId: 'request-2' },
    ];
    for (const k of keys) {
      store.claim(k, 'question');
      store.recordReply(k, k.requestId);
    }
    expect(store.replies(target, 0, 1, 'panel-1').map((r) => r.sequence)).toEqual([2]);
    expect(store.replies(target, 2, 1, 'panel-1').map((r) => r.sequence)).toEqual([4]);
    expect(store.replies(target, 0, 100).map((r) => r.sequence)).toEqual([1, 2, 4]);
    expect(store.replies(secondTarget, 0, 100).map((r) => r.sequence)).toEqual([3]);
    expect(store.replies({ ...target, projectId: join(root, 'other-project') }, 0, 100)).toEqual(
      [],
    );
    expect(store.replies(target, 0, 100, 'unknown-panel')).toEqual([]);
    expect(() => store.replies({ ...target, agent: 'codex' }, 0, 100)).toThrow();
  });

  it('caps a page at 100 rows and advances exclusively by persisted sequence', () => {
    const store = registeredStore();
    for (let i = 0; i < 103; i++) {
      const k = { ...key, requestId: `request-${i}` };
      store.claim(k, 'question');
      store.recordReply(k, 'answer');
    }
    const page = store.replies(target, 0, 1000);
    expect(page).toHaveLength(100);
    expect(page[0]?.sequence).toBe(1);
    expect(page.at(-1)?.sequence).toBe(100);
    expect(store.replies(target, 100, 1000).map((r) => r.sequence)).toEqual([101, 102, 103]);
    expect(store.replies(target, 103, 100)).toEqual([]);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid cursor %s',
    (cursor) => {
      expect(() => registeredStore().replies(target, cursor, 100)).toThrow();
    },
  );

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid page size %s',
    (limit) => {
      expect(() => registeredStore().replies(target, 0, limit)).toThrow();
    },
  );

  it('bounds both texts at 160000 characters without truncation or partial writes', () => {
    const store = registeredStore();
    const maximum = 'א'.repeat(160000);
    expect(() => store.claim(key, maximum + 'א')).toThrow();
    expect(store.lookupRequest(key.generation, key.requestId)).toBeUndefined();
    expect(store.claim(key, maximum)).toBe('new');
    expect(() => store.recordReply(key, maximum + 'א')).toThrow();
    expect(store.readReply(key)).toBeUndefined();
    expect(store.recordReply(key, maximum).text).toBe(maximum);
    store.close();
    expect(openStore().claim(key, maximum)).toBe('existing');
  });

  it('preserves literal text including NUL, quotes and empty bodies', () => {
    const store = registeredStore();
    const literal = "\u0000 שלום '); DROP TABLE requests; --\n\ud800";
    expect(store.claim(key, literal)).toBe('new');
    expect(store.recordReply(key, literal).text).toBe(literal);
    const emptyKey = { ...key, requestId: 'empty' };
    expect(store.claim(emptyKey, '')).toBe('new');
    expect(store.recordReply(emptyKey, '').text).toBe('');
    store.close();
    const reopened = openStore();
    expect(reopened.claim(key, literal)).toBe('existing');
    expect(reopened.readReply(key)?.text).toBe(literal);
  });

  it('creates a private database and persists only whitelisted identity/text fields', () => {
    const store = openStore();
    store.registerGeneration(key.generation, { ...target, token: 'SECRET-REGISTRATION' } as Target);
    store.claim({ ...key, token: 'SECRET-KEY' } as ChannelKey, 'hello');
    store.recordReply(key, 'answer');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table'").all();
      expect(JSON.stringify(schema)).not.toMatch(/token|secret|credential/i);
    } finally {
      db.close();
    }
    store.close();
    expect(readFileSync(path).includes(Buffer.from('SECRET-'))).toBe(false);
    chmodSync(path, 0o644);
    openStore();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses a symlink database path without modifying its destination', () => {
    const store = registeredStore();
    store.close();
    const original = readFileSync(path);
    const alias = join(root, 'alias.db');
    symlinkSync(path, alias);
    expect(() => new ChannelStore(alias)).toThrow();
    expect(readFileSync(path)).toEqual(original);
  });

  it.each([0, 350])(
    'atomically deduplicates competing claims and replies across independent connections with writer delay %sms',
    async (writerDelay) => {
      registeredStore().close();
      const gate = new SharedArrayBuffer(8);
      const workers: Worker[] = [];
      // Load the actual TypeScript implementation in Node workers. The resolver only
      // bridges this repository's .js source imports to .ts; no store or SQLite mocks.
      const source = `
      const { parentPort, workerData } = require('node:worker_threads');
      const { registerHooks } = require('node:module');
      registerHooks({ resolve(specifier, context, next) {
        try { return next(specifier, context); }
        catch (error) {
          if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.endsWith('.js')) throw error;
          return next(specifier.slice(0, -3) + '.ts', context);
        }
      } });
      (async () => {
        const { ChannelStore } = await import(workerData.module);
        const store = new ChannelStore(workerData.path, { readOnly: workerData.reader });
        try {
          parentPort.postMessage({ ready: true });
          Atomics.wait(new Int32Array(workerData.gate), 0, 0);
          if (workerData.reader) {
            const completion = new Int32Array(workerData.gate);
            const deadline = performance.now() + 10000;
            let observed;
            while (Atomics.load(completion, 1) < 2) {
              if (performance.now() >= deadline) throw new Error('Timed out waiting for both channel writers');
              observed = store.readReply(workerData.key) ?? observed;
              Atomics.wait(completion, 1, Atomics.load(completion, 1), 1);
            }
            observed = store.readReply(workerData.key) ?? observed;
            parentPort.postMessage({ claim: 'reader', reply: observed });
            return;
          }
          if (workerData.writerDelay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.writerDelay);
          const claim = store.claim(workerData.key, 'question');
          const reply = store.recordReply(workerData.key, workerData.text);
          Atomics.add(new Int32Array(workerData.gate), 1, 1);
          Atomics.notify(new Int32Array(workerData.gate), 1);
          parentPort.postMessage({ claim, reply });
        } finally { store.close(); }
      })().catch(error => { throw error; });
    `;
      let ready = 0;
      try {
        const results = await Promise.all(
          ['answer A', 'answer B', 'reader'].map(
            (text) =>
              new Promise<{ claim: string; reply: ChannelReply }>((resolve, reject) => {
                const worker = new Worker(source, {
                  eval: true,
                  execArgv: ['--experimental-transform-types'],
                  workerData: {
                    module: new URL('../../src/agents/claude/channel-store.ts', import.meta.url)
                      .href,
                    path,
                    key,
                    text,
                    gate,
                    writerDelay,
                    reader: text === 'reader',
                  },
                });
                workers.push(worker);
                worker.on('error', reject);
                worker.on('exit', (code) => {
                  if (code !== 0) reject(new Error(`Worker exited ${code}`));
                });
                worker.on('message', (message) => {
                  if (!message.ready) {
                    resolve(message);
                    return;
                  }
                  if (++ready === 3) {
                    Atomics.store(new Int32Array(gate), 0, 1);
                    Atomics.notify(new Int32Array(gate), 0);
                  }
                });
              }),
          ),
        );
        expect(results.map((r) => r.claim).sort()).toEqual(['existing', 'new', 'reader']);
        expect(results[0]!.reply).toEqual(results[1]!.reply);
        expect(results[2]!.reply).toEqual(results[0]!.reply);
        expect(['answer A', 'answer B']).toContain(results[0]!.reply.text);
        expect(openStore().replies(target, 0, 100)).toEqual([results[0]!.reply]);
        const db = new DatabaseSync(path, { readOnly: true });
        try {
          expect(db.prepare('SELECT COUNT(*) AS count FROM replies').get()?.count).toBe(1);
        } finally {
          db.close();
        }
      } finally {
        await Promise.all(workers.map((worker) => worker.terminate()));
      }
    },
    15000,
  );
});
