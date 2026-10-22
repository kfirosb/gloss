import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Target } from '../../core/contracts.js';
import { uuid, validateTarget } from '../shared.js';
import { CHANNEL_MAX_TEXT_CHARS, type ChannelKey, type ChannelReply } from './channel-types.js';

const MAX_PAGE = 100;
type KeyRow = {
  panel_session_id: string;
  native_session_id: string;
  generation: string;
  request_id: string;
};
type ReplyRow = KeyRow & { text: string; sequence: number; timestamp: string };

function identifier(value: string): void {
  if (typeof value !== 'string' || !value.length || value.includes('\0'))
    throw new Error('Invalid channel identifier');
}
function checkedKey(key: ChannelKey): void {
  for (const value of [key.panelSessionId, key.nativeSessionId, key.generation, key.requestId])
    identifier(value);
  if (!uuid.test(key.nativeSessionId)) throw new Error('Invalid native session identity');
}
function checkedText(text: string): void {
  if (typeof text !== 'string' || text.length > CHANNEL_MAX_TEXT_CHARS)
    throw new Error(`Channel text exceeds ${CHANNEL_MAX_TEXT_CHARS} characters`);
}
function canonicalProject(target: Target): string {
  validateTarget(target, 'claude');
  if (!isAbsolute(target.projectId)) throw new Error('Project identity must be absolute');
  const project = realpathSync(target.projectId);
  if (!statSync(project).isDirectory()) throw new Error('Project identity must be a directory');
  return project;
}
function toKey(row: KeyRow): ChannelKey {
  return {
    panelSessionId: row.panel_session_id,
    nativeSessionId: row.native_session_id,
    generation: row.generation,
    requestId: row.request_id,
  };
}
function toReply(row: ReplyRow): ChannelReply {
  return {
    key: toKey(row),
    text: JSON.parse(row.text) as string,
    sequence: row.sequence,
    timestamp: row.timestamp,
  };
}
const REPLY_SELECT = `
  SELECT q.panel_session_id, q.native_session_id, q.generation, q.request_id,
         r.text, r.sequence, r.timestamp
  FROM replies r JOIN requests q ON q.id = r.request_row_id
  JOIN generations g ON g.generation = q.generation AND g.native_session_id = q.native_session_id
  JOIN native_sessions s ON s.native_session_id = g.native_session_id
`;

/** Experimental local ledger. The consumer supplies its private database path.
 * Claims are durable before return, not proof of emission or delivery. Nothing is
 * replayed or expired at startup. Callers must emit only on a 'new' claim.
 * Accepts identity fields, never a ChannelRecord or its authentication token.
 */
export class ChannelStore {
  private readonly database: DatabaseSync;
  private readonly readOnly: boolean;
  private closed = false;

  /** `create: false` opens an existing ledger only (a missing one fails with ENOENT); readers never create. */
  constructor(path: string, options: { readOnly?: boolean; create?: boolean } = {}) {
    if (!path || path === ':memory:') throw new Error('A durable channel ledger path is required');
    this.readOnly = options.readOnly === true;
    const create = !this.readOnly && options.create !== false;
    if (create) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Readers must neither create a missing ledger nor repair its permissions.
    const mode = this.readOnly
      ? constants.O_RDONLY
      : create
        ? constants.O_CREAT | constants.O_RDWR
        : constants.O_RDWR;
    const file = openSync(path, mode | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      if (!fstatSync(file).isFile()) throw new Error('Channel ledger must be a regular file');
      if (!this.readOnly) fchmodSync(file, 0o600);
    } finally {
      closeSync(file);
    }
    this.database = new DatabaseSync(path, { readOnly: this.readOnly });
    try {
      // Rollback-journal commits briefly exclude readers too. This connection-local
      // wait does not mutate the database or enable writes on a read-only handle.
      this.database.exec('PRAGMA busy_timeout = 5000');
      if (this.readOnly) return;
      this.database.exec('PRAGMA foreign_keys = ON');
      // This ledger has writers in separate channel processes. Avoid the WAL-reset
      // race in SQLite bundled with supported Node versions. A busy legacy WAL
      // conversion must fail closed; never continue using an unconfirmed mode.
      const journal = this.database.prepare('PRAGMA journal_mode = DELETE').get();
      if (journal?.journal_mode !== 'delete')
        throw new Error('Channel ledger requires DELETE journaling');
      this.database.exec('PRAGMA synchronous = FULL');
      this.transaction(() =>
        this.database.exec(`
        CREATE TABLE IF NOT EXISTS native_sessions (
          native_session_id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS generations (
          generation TEXT PRIMARY KEY NOT NULL,
          native_session_id TEXT NOT NULL REFERENCES native_sessions(native_session_id),
          UNIQUE (generation, native_session_id)
        );
        CREATE TABLE IF NOT EXISTS requests (
          id INTEGER PRIMARY KEY,
          panel_session_id TEXT NOT NULL,
          native_session_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          generation TEXT NOT NULL,
          text TEXT NOT NULL,
          UNIQUE (panel_session_id, native_session_id, request_id),
          FOREIGN KEY (generation, native_session_id) REFERENCES generations(generation, native_session_id)
        );
        CREATE INDEX IF NOT EXISTS requests_generation_request ON requests(generation, request_id);
        CREATE TABLE IF NOT EXISTS replies (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          request_row_id INTEGER NOT NULL UNIQUE REFERENCES requests(id),
          text TEXT NOT NULL,
          timestamp TEXT NOT NULL
        );
      `),
      );
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  private transaction<T>(operation: () => T): T {
    if (this.readOnly) throw new Error('Channel ledger is read-only');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /** Trusted registry consumer registers a verified generation before claiming.
   * Both generation -> native and native -> canonical project are immutable.
   */
  registerGeneration(generation: string, target: Target): void {
    identifier(generation);
    const project = canonicalProject(target);
    this.transaction(() => {
      const native = this.database
        .prepare('SELECT project_id FROM native_sessions WHERE native_session_id = ?')
        .get(target.sessionRef);
      if (native && native.project_id !== project)
        throw new Error('Native session project conflict');
      this.database
        .prepare(
          'INSERT INTO native_sessions(native_session_id, project_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
        )
        .run(target.sessionRef, project);
      const existing = this.database
        .prepare('SELECT native_session_id FROM generations WHERE generation = ?')
        .get(generation);
      if (existing && existing.native_session_id !== target.sessionRef)
        throw new Error('Channel generation target conflict');
      this.database
        .prepare(
          'INSERT INTO generations(generation, native_session_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
        )
        .run(generation, target.sessionRef);
    });
  }

  claim(key: ChannelKey, text: string): 'new' | 'existing' | 'conflict' {
    checkedKey(key);
    checkedText(text);
    // JSON string encoding preserves NUL and lone UTF-16 surrogates across Node's
    // SQLite string boundary. Enforce the bound on the original text, not encoding.
    const encoded = JSON.stringify(text);
    return this.transaction(() => {
      const binding = this.database
        .prepare('SELECT native_session_id FROM generations WHERE generation = ?')
        .get(key.generation);
      if (!binding || binding.native_session_id !== key.nativeSessionId)
        throw new Error('Unregistered channel target');
      const existing = this.database
        .prepare(
          `
        SELECT generation, text FROM requests WHERE panel_session_id = ? AND native_session_id = ? AND request_id = ?
      `,
        )
        .get(key.panelSessionId, key.nativeSessionId, key.requestId);
      if (existing)
        return existing.generation === key.generation && existing.text === encoded
          ? 'existing'
          : 'conflict';
      this.database
        .prepare(
          `
        INSERT INTO requests(panel_session_id, native_session_id, request_id, generation, text) VALUES (?, ?, ?, ?, ?)
      `,
        )
        .run(key.panelSessionId, key.nativeSessionId, key.requestId, key.generation, encoded);
      return 'new';
    });
  }

  /** Reply tools supply the authenticated process generation plus request ID.
   * Never choose a panel/destination from model input. Multiple matches fail closed.
   */
  lookupRequest(generation: string, requestId: string): ChannelKey | undefined {
    identifier(generation);
    identifier(requestId);
    const rows = this.database
      .prepare(
        `
      SELECT panel_session_id, native_session_id, generation, request_id
      FROM requests WHERE generation = ? AND request_id = ? LIMIT 2
    `,
      )
      .all(generation, requestId) as KeyRow[];
    if (rows.length > 1) throw new Error('Ambiguous channel request');
    return rows[0] ? toKey(rows[0]) : undefined;
  }

  /** First reply wins, even on differing retries. The reply tool must compare the
   * returned text to its input and reject a differing duplicate to the model.
   */
  recordReply(key: ChannelKey, text: string): ChannelReply {
    checkedKey(key);
    checkedText(text);
    return this.transaction(() => {
      const request = this.database
        .prepare(
          `
        SELECT id FROM requests WHERE panel_session_id = ? AND native_session_id = ? AND generation = ? AND request_id = ?
      `,
        )
        .get(key.panelSessionId, key.nativeSessionId, key.generation, key.requestId);
      if (!request) throw new Error('Unknown channel request');
      const existing = this.readReply(key);
      if (existing) return existing;
      this.database
        .prepare('INSERT INTO replies(request_row_id, text, timestamp) VALUES (?, ?, ?)')
        .run(request.id!, JSON.stringify(text), new Date().toISOString());
      return this.readReply(key)!;
    });
  }

  /** Trusted exact-key read; the generation binds the key to its registered project.
   * Target-based history consumers should use replies(), including their panel ID.
   */
  readReply(key: ChannelKey): ChannelReply | undefined {
    checkedKey(key);
    const row = this.database
      .prepare(
        `${REPLY_SELECT}
      WHERE q.panel_session_id = ? AND q.native_session_id = ? AND q.generation = ? AND q.request_id = ?
    `,
      )
      .get(key.panelSessionId, key.nativeSessionId, key.generation, key.requestId) as
      ReplyRow | undefined;
    return row ? toReply(row) : undefined;
  }

  /** Exclusive sequence cursor, ascending order, at most 100 rows. Filtering is
   * performed before LIMIT so other panels cannot starve a consumer's page.
   */
  replies(
    target: Target,
    afterSequence: number,
    limit: number,
    panelSessionId?: string,
  ): ChannelReply[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
      throw new Error('Invalid channel reply cursor');
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new Error('Invalid channel reply page size');
    if (panelSessionId !== undefined) identifier(panelSessionId);
    const project = canonicalProject(target);
    const rows = this.database
      .prepare(
        `${REPLY_SELECT}
      WHERE s.project_id = ? AND q.native_session_id = ? AND r.sequence > ?
      ${panelSessionId === undefined ? '' : 'AND q.panel_session_id = ?'}
      ORDER BY r.sequence ASC LIMIT ?
    `,
      )
      .all(
        project,
        target.sessionRef,
        afterSequence,
        ...(panelSessionId === undefined ? [] : [panelSessionId]),
        Math.min(limit, MAX_PAGE),
      ) as ReplyRow[];
    return rows.map(toReply);
  }

  close(): void {
    if (!this.closed) {
      this.database.close();
      this.closed = true;
    }
  }
}
