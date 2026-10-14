import type { FileReference, FileReferenceStore } from '../core/file-references.js';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AgentMessage,
  ConversationSnapshot,
  ConversationStore,
  ConversationSummary,
  Delivery,
  Draft,
  LanguageTurn,
  Target,
  TranslationKey,
} from '../core/contracts.js';
import {
  defaultWorkspace,
  WorkspaceConflict,
  type SessionRecord,
  type SessionStore,
  type WorkspaceData,
  type WorkspaceRecord,
} from '../core/session-contracts.js';

type Row = Record<string, unknown>;

const json = (value: unknown) => JSON.stringify(value);
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const optionalString = (value: unknown) => value === null || value === undefined ? undefined : String(value);

const MIGRATIONS = [{
  version: 1,
  sql: `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      target_json TEXT,
      project_id TEXT,
      coding_state TEXT NOT NULL,
      language TEXT NOT NULL,
      language_session_id TEXT NOT NULL,
      language_model TEXT NOT NULL,
      source_revision INTEGER NOT NULL
    );
    CREATE TABLE source_messages (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      complete INTEGER NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, source_id)
    );
    CREATE TABLE discussion_turns (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (conversation_id, position)
    );
    CREATE TABLE drafts (
      id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      target_json TEXT NOT NULL,
      source_revision INTEGER NOT NULL,
      language TEXT NOT NULL,
      localized_text TEXT NOT NULL,
      english_text TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (id, revision)
    );
    CREATE INDEX drafts_conversation ON drafts(conversation_id, is_current);
    CREATE TABLE deliveries (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      target_json TEXT NOT NULL,
      english_text TEXT NOT NULL,
      state TEXT NOT NULL,
      reason TEXT,
      UNIQUE (draft_id, revision)
    );
    CREATE TABLE translations (
      source_scope TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_revision INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      language TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (source_scope, source_id, source_revision, content_hash, language, model, prompt_version)
    );
    CREATE TABLE project_context (
      project_id TEXT PRIMARY KEY,
      text TEXT NOT NULL
    );
  `,
}, {
  version: 2,
  sql: 'ALTER TABLE conversations ADD COLUMN source_gaps_json TEXT;',
}, {
  version: 3,
  sql: 'ALTER TABLE source_messages ADD COLUMN translated_text TEXT; ALTER TABLE source_messages ADD COLUMN translation_status TEXT;',
}, {
  version: 4,
  sql: 'ALTER TABLE conversations ADD COLUMN source_session_id TEXT; ALTER TABLE conversations ADD COLUMN source_cursor TEXT; ALTER TABLE conversations ADD COLUMN source_sequence INTEGER;',
}, {
  version: 5,
  sql: 'ALTER TABLE source_messages ADD COLUMN timestamp TEXT;',
}, {
  version: 6,
  // Regenerate derived Hebrew translations once under the revised terminology style.
  sql: `UPDATE source_messages SET translated_text = NULL, translation_status = NULL
    WHERE conversation_id IN (SELECT id FROM conversations WHERE lower(language) IN ('he', 'hebrew') OR lower(language) LIKE 'he-%');`,
}, { version: 7, sql: 'ALTER TABLE drafts ADD COLUMN selected_discussion_json TEXT;'
}, { version: 8, sql: 'ALTER TABLE deliveries ADD COLUMN native_message_id TEXT;'
}, { version: 9, sql: 'ALTER TABLE conversations ADD COLUMN composer_draft_json TEXT;'
}, { version: 10, sql: 'ALTER TABLE deliveries ADD COLUMN native_after_revision INTEGER;'
}, { version: 11, sql: 'ALTER TABLE deliveries ADD COLUMN attachments_json TEXT;'
}, { version: 12, sql: 'ALTER TABLE discussion_turns ADD COLUMN attachments_json TEXT; ALTER TABLE drafts ADD COLUMN attachments_json TEXT;'
}, { version: 13, sql: `
  UPDATE discussion_turns AS reply SET attachments_json = (
    SELECT source.attachments_json FROM discussion_turns AS source
    WHERE source.conversation_id = reply.conversation_id
      AND source.position = reply.position - 1 AND source.role = 'user'
  ) WHERE reply.role = 'assistant';
` }, { version: 14, sql: `
  CREATE TABLE panel_sessions (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    native_session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    canonical_root TEXT NOT NULL,
    project_name TEXT NOT NULL,
    branch TEXT,
    worktree_path TEXT,
    enabled INTEGER NOT NULL,
    UNIQUE (agent, native_session_id)
  );
  CREATE TABLE session_workspaces (
    session_id TEXT PRIMARY KEY REFERENCES panel_sessions(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    data_json TEXT NOT NULL
  );
` }, { version: 15, sql: `
  CREATE TABLE session_files (
    session_id TEXT NOT NULL REFERENCES panel_sessions(id) ON DELETE CASCADE,
    id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('file','image')),
    file_index INTEGER NOT NULL CHECK(file_index > 0), data_json TEXT NOT NULL,
    PRIMARY KEY(session_id,id), UNIQUE(session_id,kind,file_index)
  );
  CREATE TABLE session_file_counters (
    session_id TEXT NOT NULL REFERENCES panel_sessions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, last_index INTEGER NOT NULL,
    PRIMARY KEY(session_id,kind)
  );
` }, { version: 16, sql: 'ALTER TABLE deliveries ADD COLUMN reference_format TEXT;' },
{ version: 17, sql: 'ALTER TABLE panel_sessions ADD COLUMN session_title TEXT;' },
{ version: 18, sql: `
  ALTER TABLE discussion_turns ADD COLUMN turn_id TEXT;
  ALTER TABLE discussion_turns ADD COLUMN complete INTEGER;
  UPDATE discussion_turns SET turn_id = conversation_id || ':legacy:' || position,
    complete = CASE WHEN length(trim(text)) > 0 THEN 1 ELSE 0 END;
  CREATE TABLE response_summaries (cache_key TEXT PRIMARY KEY, text TEXT NOT NULL);
` }, { version: 19, sql: 'ALTER TABLE deliveries ADD COLUMN transport TEXT; ALTER TABLE deliveries ADD COLUMN channel_generation TEXT;' }, { version: 20, sql: `
  CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
  ALTER TABLE panel_sessions ADD COLUMN language_override_json TEXT;
` }, { version: 21, sql: 'CREATE TABLE session_launches (id TEXT PRIMARY KEY, data_json TEXT NOT NULL);' }, { version: 22, sql: 'CREATE TABLE connected_folders (path TEXT PRIMARY KEY, project_key TEXT NOT NULL, kind TEXT NOT NULL, created_by_app INTEGER NOT NULL, connected_at INTEGER NOT NULL);' }, { version: 23, sql: 'CREATE TABLE session_seen (session_id TEXT PRIMARY KEY, seen_sequence INTEGER NOT NULL, seen_at INTEGER NOT NULL);' }] as const;

import {summaryCacheKey, type SummaryKey} from '../core/summary-contracts.js';
import { orderAgentMessages } from '../core/contracts.js';
import type { SeenStore } from '../core/session-catalog.js';
import { INITIAL_LANGUAGE_DEFAULTS, validateLanguageOverride, validateLanguageSettings, type LanguageOverride, type LanguageSettings, type LanguageSettingsStore } from '../core/language-settings.js';
import { DEFAULT_SIDEBAR_SETTINGS, validateSidebarSettings, type ConnectedFolder, type ConnectedFolderStore, type FolderKind, type SidebarSettings } from '../runtime/connected-folders.js';
import type { LaunchRecord, LaunchSettings, LaunchStore } from '../runtime/session-launcher.js';
function validateLaunchSettings(value: unknown): LaunchSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid launch settings');
  const { popup, extraArgs, terminalView = 'popup' } = value as LaunchSettings;
  if (!['auto', 'current-tab', 'dot-only'].includes(popup) || !['popup', 'workspace'].includes(terminalView) || !extraArgs || typeof extraArgs !== 'object' || Array.isArray(extraArgs)) throw new Error('Invalid launch settings');
  for (const agent of ['claude', 'codex'] as const) {
    const args = extraArgs[agent];
    if (!Array.isArray(args) || args.length > 32 || args.some(arg => typeof arg !== 'string' || arg.length > 512)) throw new Error('Invalid launch settings');
  }
  return { popup, terminalView, extraArgs: { claude: [...extraArgs.claude], codex: [...extraArgs.codex] } };
}
export class SqliteStore implements ConversationStore, SessionStore, FileReferenceStore, LanguageSettingsStore, LaunchStore, ConnectedFolderStore, SeenStore {
  seenSequence(sessionId: string): number | undefined {
    const row = this.database.prepare('SELECT seen_sequence FROM session_seen WHERE session_id = ?').get(sessionId) as Row | undefined;
    return row ? Number(row.seen_sequence) : undefined;
  }
  markSeen(sessionId: string, sequence: number, at = Date.now()): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid seen sequence');
    this.database.prepare(`INSERT INTO session_seen(session_id, seen_sequence, seen_at) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET seen_sequence = excluded.seen_sequence, seen_at = excluded.seen_at
      WHERE excluded.seen_sequence > session_seen.seen_sequence`).run(sessionId, sequence, at);
  }
  listConnectedFolders(): ConnectedFolder[] {
    return (this.database.prepare('SELECT * FROM connected_folders ORDER BY connected_at, path').all() as Row[]).map(r => ({ path: String(r.path), projectKey: String(r.project_key), kind: String(r.kind) as FolderKind, createdByApp: Number(r.created_by_app) === 1, connectedAt: Number(r.connected_at) }));
  }
  putConnectedFolder(f: ConnectedFolder): void {
    this.database.prepare('INSERT INTO connected_folders(path,project_key,kind,created_by_app,connected_at) VALUES (?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET project_key=excluded.project_key, kind=excluded.kind, created_by_app=excluded.created_by_app').run(f.path, f.projectKey, f.kind, f.createdByApp ? 1 : 0, f.connectedAt);
  }
  deleteConnectedFolder(path: string): void { this.database.prepare('DELETE FROM connected_folders WHERE path = ?').run(path); }
  readSidebarSettings(): SidebarSettings {
    const row = this.database.prepare("SELECT value_json FROM app_settings WHERE key = 'sidebar.projects'").get() as Row | undefined;
    if (!row) return { ...DEFAULT_SIDEBAR_SETTINGS, worktreeLocation: {} };
    try { return validateSidebarSettings(JSON.parse(String(row.value_json))); } catch { return { ...DEFAULT_SIDEBAR_SETTINGS, worktreeLocation: {} }; }
  }
  writeSidebarSettings(settings: SidebarSettings): void { this.database.prepare("INSERT OR REPLACE INTO app_settings(key,value_json) VALUES ('sidebar.projects',?)").run(json(validateSidebarSettings(settings))); }
  listLaunches(): LaunchRecord[] {
    return (this.database.prepare('SELECT data_json FROM session_launches ORDER BY rowid').all() as Row[]).map(row => parse<LaunchRecord>(row.data_json));
  }
  putLaunch(record: LaunchRecord): void {
    this.database.prepare('INSERT INTO session_launches(id,data_json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json').run(record.id, json(record));
  }
  deleteLaunch(id: string): void { this.database.prepare('DELETE FROM session_launches WHERE id = ?').run(id); }
  readLaunchSettings(): LaunchSettings {
    const row = this.database.prepare("SELECT value_json FROM app_settings WHERE key = 'launch.settings'").get() as Row | undefined;
    if (row) { try { return validateLaunchSettings(parse(row.value_json)); } catch { /* Invalid saved settings fall back to defaults. */ } }
    return { extraArgs: { claude: [], codex: [] }, popup: 'auto', terminalView: 'popup' };
  }
  writeLaunchSettings(settings: LaunchSettings): void {
    const valid = validateLaunchSettings(settings);
    this.database.prepare("INSERT OR REPLACE INTO app_settings(key,value_json) VALUES ('launch.settings',?)").run(json(valid));
  }
  readLanguageDefaults(): LanguageSettings {
    const row = this.database.prepare("SELECT value_json FROM app_settings WHERE key = 'language.defaults'").get() as Row | undefined;
    if (!row) return { ...INITIAL_LANGUAGE_DEFAULTS };
    try { return validateLanguageSettings(JSON.parse(String(row.value_json))); } catch { return { ...INITIAL_LANGUAGE_DEFAULTS }; }
  }
  writeLanguageDefaults(settings: LanguageSettings): void {
    const valid = validateLanguageSettings(settings);
    this.database.prepare("INSERT OR REPLACE INTO app_settings(key,value_json) VALUES ('language.defaults',?)").run(json(valid));
  }
  readLanguageOverride(sessionId: string): LanguageOverride {
    const row = this.database.prepare('SELECT language_override_json FROM panel_sessions WHERE id = ?').get(sessionId) as Row | undefined;
    if (!row || typeof row.language_override_json !== 'string') return {};
    try { return validateLanguageOverride(JSON.parse(row.language_override_json)); } catch { return {}; }
  }
  writeLanguageOverride(sessionId: string, override: LanguageOverride | null): void {
    const valid = override === null ? {} : validateLanguageOverride(override);
    const result = this.database.prepare('UPDATE panel_sessions SET language_override_json = ? WHERE id = ?').run(Object.keys(valid).length ? json(valid) : null, sessionId);
    if (!Number(result.changes)) throw Object.assign(new Error('Unknown session'), { code: 'unknown-session' });
  }
  getSummary(key:SummaryKey):string|undefined { const row=this.database.prepare('SELECT text FROM response_summaries WHERE cache_key = ?').get(summaryCacheKey(key)) as Row|undefined;return row?String(row.text):undefined; }
  putSummary(key:SummaryKey,text:string):void { this.database.prepare('INSERT OR REPLACE INTO response_summaries(cache_key,text) VALUES (?,?)').run(summaryCacheKey(key),text); }
  private readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') {
      const directory = dirname(path);
      const directoryExisted = existsSync(directory);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!directoryExisted) chmodSync(directory, 0o700);
    }
    this.database = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
    try {
      this.migrate();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  private migrate() {
    this.transaction(() => this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)
    `));
    const applied = (this.database.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Row[])
      .map((row) => Number(row.version));
    const latest = MIGRATIONS.at(-1)?.version ?? 0;
    const newer = applied.find((version) => version > latest);
    if (newer !== undefined) throw new Error(`Database uses newer schema version ${newer}`);
    const known = new Set<number>(MIGRATIONS.map(({ version }) => version));
    const unknown = applied.find((version) => !known.has(version));
    if (unknown !== undefined) throw new Error(`Database uses unsupported schema version ${unknown}`);

    for (const migration of MIGRATIONS) {
      if (applied.includes(migration.version)) continue;
      this.transaction(() => {
        this.database.exec(migration.sql);
        this.database.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(migration.version);
      });
    }
  }

  private transaction<T>(operation: () => T): T {
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

  listFileReferences(sessionId: string): FileReference[] {
    return (this.database.prepare('SELECT data_json FROM session_files WHERE session_id = ? ORDER BY kind, file_index').all(sessionId) as Row[])
      .map(row => parse<FileReference>(row.data_json));
  }

  fileOwners(id: string): string[] {
    return (this.database.prepare('SELECT session_id FROM session_files WHERE id = ?').all(id) as Row[]).map(row => String(row.session_id));
  }

  registerFileReference(file: Omit<FileReference, 'index'> & { index?: number }): FileReference {
    return this.transaction(() => {
      const existing = this.listFileReferences(file.sessionId).find(item => item.id === file.id ||
        (file.source === 'worktree' && item.source === 'worktree' && item.path === file.path));
      if (existing) return existing;
      const row = this.database.prepare('SELECT last_index FROM session_file_counters WHERE session_id = ? AND kind = ?').get(file.sessionId, file.kind) as Row | undefined;
      const index = file.index ?? Number(row?.last_index ?? 0) + 1;
      if (!Number.isSafeInteger(index) || index < 1) throw new Error('Invalid attachment index');
      const result: FileReference = { ...file, index };
      this.database.prepare('INSERT INTO session_files(session_id,id,kind,file_index,data_json) VALUES (?,?,?,?,?)').run(file.sessionId,file.id,file.kind,index,json(result));
      this.database.prepare(`INSERT INTO session_file_counters(session_id,kind,last_index) VALUES (?,?,?)
        ON CONFLICT(session_id,kind) DO UPDATE SET last_index = MAX(last_index,excluded.last_index)`).run(file.sessionId,file.kind,index);
      return result;
    });
  }

  listSessions(): SessionRecord[] {
    const rows = this.database.prepare('SELECT * FROM panel_sessions ORDER BY rowid').all() as Row[];
    return rows.map((row) => this.sessionFromRow(row));
  }

  updateSessionTitle(id: string, title: string): void {
    this.database.prepare('UPDATE panel_sessions SET session_title = ? WHERE id = ?').run(title, id);
  }

  registerSession(record: SessionRecord): SessionRecord {
    return this.transaction(() => {
      const byTarget = this.database.prepare(
        'SELECT * FROM panel_sessions WHERE agent = ? AND native_session_id = ?',
      ).get(record.target.agent, record.target.sessionRef) as Row | undefined;
      if (byTarget) {
        const existing = this.sessionFromRow(byTarget);
        // A missing project during migration may recover later. Only fill its
        // unavailable metadata; established roots and all session state survive.
        if (!existing.canonicalRoot && record.canonicalRoot && existing.id === record.id && existing.target.projectId === record.target.projectId) {
          this.database.prepare(`UPDATE panel_sessions SET canonical_root = ?, project_name = ?, branch = ?, worktree_path = ? WHERE id = ?`)
            .run(record.canonicalRoot, record.projectName, record.branch ?? null, record.worktreePath ?? null, existing.id);
          return this.sessionFromRow(this.database.prepare('SELECT * FROM panel_sessions WHERE id = ?').get(existing.id) as Row);
        }
        return existing;
      }

      const byId = this.database.prepare('SELECT * FROM panel_sessions WHERE id = ?')
        .get(record.id) as Row | undefined;
      if (byId) {
        throw new Error('Session ID is already registered to a different target');
      }

      this.database.prepare(`
        INSERT INTO panel_sessions (
          id, agent, native_session_id, project_id, canonical_root, project_name,
          branch, worktree_path, enabled, session_title
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id, record.target.agent, record.target.sessionRef, record.target.projectId,
        record.canonicalRoot, record.projectName, record.branch ?? null,
        record.worktreePath ?? null, Number(record.enabled), record.sessionTitle ?? null,
      );
      return { ...record, target: { ...record.target } };
    });
  }

  readWorkspace(sessionId: string): WorkspaceRecord {
    return this.transaction(() => {
      this.ensureWorkspace(sessionId);
      return this.workspaceRecord(sessionId);
    });
  }

  releaseComposerAttempt(conversationId: string, requestId: string): void {
    this.transaction(() => {
      const row = this.database.prepare('SELECT composer_draft_json FROM conversations WHERE id = ?').get(conversationId) as Row | undefined;
      if (typeof row?.composer_draft_json === 'string' && parse<Draft>(row.composer_draft_json).id === `composer-${requestId}`) {
        this.database.prepare('UPDATE conversations SET composer_draft_json = NULL WHERE id = ?').run(conversationId);
      }
      const workspace = this.database.prepare('SELECT data_json FROM session_workspaces WHERE session_id = ?').get(conversationId) as Row | undefined;
      if (!workspace) return;
      const data = parse<WorkspaceData>(workspace.data_json);
      if (data.composerAttempt?.requestId !== requestId) return;
      data.composerAttempt = null;
      this.database.prepare('UPDATE session_workspaces SET revision = revision + 1, data_json = ? WHERE session_id = ?').run(json(data), conversationId);
    });
  }

  writeWorkspace(sessionId: string, expectedRevision: number, data: WorkspaceData): WorkspaceRecord {
    return this.transaction(() => {
      this.ensureWorkspace(sessionId);
      const current = this.workspaceRecord(sessionId);
      if (current.revision !== expectedRevision) throw new WorkspaceConflict(current);
      const validated = this.validateWorkspace(sessionId, data);
      const updated = this.database.prepare(`
        UPDATE session_workspaces SET revision = revision + 1, data_json = ?
        WHERE session_id = ? AND revision = ?
      `).run(json(validated), sessionId, expectedRevision);
      if (updated.changes === 0) throw new WorkspaceConflict(this.workspaceRecord(sessionId));
      return this.workspaceRecord(sessionId);
    });
  }

  private ensureWorkspace(sessionId: string): void {
    const session = this.database.prepare('SELECT 1 FROM panel_sessions WHERE id = ?').get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    this.database.prepare(`
      INSERT OR IGNORE INTO session_workspaces(session_id, revision, data_json) VALUES (?, 0, ?)
    `).run(sessionId, json(defaultWorkspace()));
  }

  private workspaceRecord(sessionId: string): WorkspaceRecord {
    const row = this.database.prepare('SELECT * FROM session_workspaces WHERE session_id = ?')
      .get(sessionId) as Row | undefined;
    if (!row) throw new Error(`Unknown session: ${sessionId}`);
    return { sessionId, revision: Number(row.revision), data: parse<WorkspaceData>(row.data_json) };
  }

  private sessionFromRow(row: Row): SessionRecord {
    return {
      ...(optionalString(row.session_title) !== undefined ? { sessionTitle: String(row.session_title) } : {}),
      id: String(row.id),
      target: {
        agent: String(row.agent) as Target['agent'],
        sessionRef: String(row.native_session_id),
        projectId: String(row.project_id),
      },
      canonicalRoot: String(row.canonical_root),
      projectName: String(row.project_name),
      ...(optionalString(row.branch) !== undefined ? { branch: String(row.branch) } : {}),
      ...(optionalString(row.worktree_path) !== undefined ? { worktreePath: String(row.worktree_path) } : {}),
      enabled: Boolean(row.enabled),
    };
  }

  private validateWorkspace(sessionId: string, data: WorkspaceData): WorkspaceData {
    const panelIds = ['live', 'assistant', 'composer'] as const;
    if (!Array.isArray(data.layout.order)
      || data.layout.order.length !== panelIds.length
      || new Set(data.layout.order).size !== panelIds.length
      || !data.layout.order.every((id) => panelIds.includes(id))) {
      throw new Error('Invalid workspace layout order');
    }
    if (!['split', 'columns', 'rows', 'bottom'].includes(data.layout.mode)) {
      throw new Error('Invalid workspace layout mode');
    }
    if (![data.layout.liveSize, data.layout.discussionSize].every(Number.isFinite)) {
      throw new Error('Invalid workspace divider size');
    }
    if (!this.validStringIds(data.attachmentIds)
      || !Array.isArray(data.selectedDiscussion)
      || data.selectedDiscussion.some((index) => !Number.isSafeInteger(index) || index < 0)
      || new Set(data.selectedDiscussion).size !== data.selectedDiscussion.length
      || (data.composerAttempt !== null && !this.validStringIds(data.composerAttempt.attachmentIds))) {
      throw new Error('Invalid workspace array');
    }
    for (const ids of [data.attachmentIds, data.composerAttempt?.attachmentIds ?? []]) {
      if (ids.length > 10) throw new Error('Attach at most 10 files');
      const files = this.listFileReferences(sessionId);
      const selected = ids.map(id => {
        const file = files.find(file => file.id === id);
        if (!file) throw new Error('Attachment does not belong to this session');
        return file;
      });
      if (selected.filter(file => file.kind === 'image').length > 4) throw new Error('Attach at most 4 images');
    }
    if (data.review !== null) {
      const draft = this.database.prepare(`
        SELECT 1 FROM drafts WHERE id = ? AND revision = ? AND conversation_id = ?
      `).get(data.review.draftId, data.review.revision, sessionId);
      if (!draft) throw new Error('Prepared review does not exist for this session');
    }
    const clamp = (value: number) => Math.min(90, Math.max(10, value));
    return {
      composer: data.composer,
      attachmentIds: [...data.attachmentIds],
      selectedDiscussion: [...data.selectedDiscussion],
      review: data.review === null ? null : {
        draftId: data.review.draftId,
        revision: data.review.revision,
        localizedText: data.review.localizedText,
      },
      composerAttempt: data.composerAttempt === null ? null : {
        requestId: data.composerAttempt.requestId,
        text: data.composerAttempt.text,
        attachmentIds: [...data.composerAttempt.attachmentIds],
      },
      layout: {
        mode: data.layout.mode,
        order: [...data.layout.order],
        liveSize: clamp(data.layout.liveSize),
        discussionSize: clamp(data.layout.discussionSize),
      },
    };
  }

  private validStringIds(value: unknown): value is string[] {
    return Array.isArray(value)
      && value.every((id) => typeof id === 'string' && id.length > 0)
      && new Set(value).size === value.length;
  }

  load(id: string): ConversationSnapshot | undefined {
    const row = this.database.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Row | undefined;
    if (!row) return undefined;
    const messageRows = this.database.prepare(
      'SELECT * FROM source_messages WHERE conversation_id = ? ORDER BY revision, position',
    ).all(id) as Row[];
    const discussionRows = this.database.prepare(
      'SELECT * FROM discussion_turns WHERE conversation_id = ? ORDER BY position',
    ).all(id) as Row[];
    const draftRow = this.database.prepare(
      'SELECT * FROM drafts WHERE conversation_id = ? AND is_current = 1 ORDER BY revision DESC LIMIT 1',
    ).get(id) as Row | undefined;
    const deliveryRows = this.database.prepare(`
      SELECT DISTINCT deliveries.* FROM deliveries
      JOIN drafts ON drafts.id = deliveries.draft_id
      WHERE drafts.conversation_id = ? ORDER BY deliveries.rowid
    `).all(id) as Row[];
    const target = row.target_json === null ? undefined : parse<Target>(row.target_json);
    const currentDraft: Draft | undefined = draftRow && {
      id: String(draftRow.id), revision: Number(draftRow.revision),
      target: parse<Target>(draftRow.target_json), sourceRevision: Number(draftRow.source_revision),
      language: String(draftRow.language), localizedText: String(draftRow.localized_text),
      englishText: String(draftRow.english_text),
      ...(typeof draftRow.attachments_json === 'string' ? {attachments:parse<NonNullable<Draft['attachments']>>(draftRow.attachments_json)} : {}),
      ...(typeof draftRow.selected_discussion_json === 'string' ? { selectedDiscussion: parse<number[]>(draftRow.selected_discussion_json) } : {}),
    };
    return {
      id: String(row.id),
      ...(typeof row.source_gaps_json === 'string' ? { sourceGaps: parse<string[]>(row.source_gaps_json) } : {}),
      ...(target && { target }),
      codingState: String(row.coding_state) as ConversationSnapshot['codingState'],
      codingMessages: orderAgentMessages(messageRows.map((message): AgentMessage => {
        const translationStatus = message.translation_status === 'pending' || message.translation_status === 'complete' || message.translation_status === 'error' ? message.translation_status : undefined;
        return ({
        sourceId: String(message.source_id), revision: Number(message.revision),
        role: String(message.role) as AgentMessage['role'], text: String(message.text),
        complete: Boolean(message.complete),
        ...(typeof message.timestamp === 'string' ? { timestamp: message.timestamp } : {}),
        ...(typeof message.translated_text === 'string' ? { translatedText: message.translated_text } : {}),
        ...(translationStatus ? { translationStatus } : {}),
      }); }), target?.agent),
      discussion: discussionRows.map((turn): LanguageTurn => ({
        id: String(turn.turn_id), complete: Boolean(turn.complete),
        role: String(turn.role) as LanguageTurn['role'], text: String(turn.text),
        ...(typeof turn.attachments_json === 'string'?{attachments:parse<NonNullable<LanguageTurn['attachments']>>(turn.attachments_json)}:{}),
      })),
      ...(currentDraft && { currentDraft }),
      ...(typeof row.composer_draft_json === 'string' ? { composerDraft: parse<Draft>(row.composer_draft_json) } : {}),
      deliveries: deliveryRows.map((item): Delivery => ({
        id: String(item.id), draftId: String(item.draft_id), revision: Number(item.revision),
        target: parse<Target>(item.target_json), englishText: String(item.english_text),
        state: String(item.state) as Delivery['state'],
        ...(item.transport === 'channel' || item.transport === 'peer' ? { transport: item.transport } : {}),
        ...(typeof item.channel_generation === 'string' ? { channelGeneration: item.channel_generation } : {}),
        ...(typeof item.attachments_json === 'string' ? { attachments: parse<NonNullable<Delivery['attachments']>>(item.attachments_json) } : {}),
        ...(item.reference_format === 'manifest-v1' ? {referenceFormat:'manifest-v1' as const} : {}),
        ...(typeof item.native_after_revision === 'number' ? { nativeAfterRevision: item.native_after_revision } : {}),
        ...(typeof item.native_message_id === 'string' ? { nativeMessageId: item.native_message_id } : {}),
        ...(optionalString(item.reason) !== undefined && { reason: String(item.reason) }),
      })),
      language: String(row.language), languageSessionId: String(row.language_session_id),
      languageModel: String(row.language_model), sourceRevision: Number(row.source_revision),
      ...(optionalString(row.source_session_id) !== undefined ? { sourceSessionId: String(row.source_session_id) } : {}),
      ...(optionalString(row.source_cursor) !== undefined ? { sourceCursor: String(row.source_cursor) } : {}),
      ...(row.source_sequence !== null && row.source_sequence !== undefined ? { sourceSequence: Number(row.source_sequence) } : {}),
    };
  }

  save(snapshot: ConversationSnapshot): void {
    this.transaction(() => {
      const prior = this.database.prepare('SELECT target_json FROM conversations WHERE id = ?')
        .get(snapshot.id) as Row | undefined;
      const targetJson = snapshot.target ? json(snapshot.target) : null;
      const targetChanged = prior !== undefined && prior.target_json !== targetJson;
      this.database.prepare(`
        INSERT INTO conversations (
          id, target_json, project_id, coding_state, language, language_session_id, language_model, source_revision,
          source_session_id, source_cursor, source_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          target_json=excluded.target_json, project_id=excluded.project_id,
          coding_state=excluded.coding_state, language=excluded.language,
          language_session_id=excluded.language_session_id, language_model=excluded.language_model,
          source_revision=MAX(conversations.source_revision, excluded.source_revision),
          source_session_id=excluded.source_session_id, source_cursor=excluded.source_cursor, source_sequence=excluded.source_sequence
      `).run(
        snapshot.id, targetJson, snapshot.target?.projectId ?? null, snapshot.codingState,
        snapshot.language, snapshot.languageSessionId, snapshot.languageModel, snapshot.sourceRevision,
        snapshot.sourceSessionId ?? null, snapshot.sourceCursor ?? null, snapshot.sourceSequence ?? null,
      );
      this.database.prepare('UPDATE conversations SET source_gaps_json = ? WHERE id = ?').run(snapshot.sourceGaps ? json(snapshot.sourceGaps) : null, snapshot.id);
      if (targetChanged) {
        this.database.prepare('DELETE FROM source_messages WHERE conversation_id = ?').run(snapshot.id);
        this.database.prepare('UPDATE conversations SET source_revision = ? WHERE id = ?')
          .run(snapshot.sourceRevision, snapshot.id);
      }
      const currentMaximum = this.database.prepare(
        'SELECT COALESCE(MAX(position), -1) AS position FROM source_messages WHERE conversation_id = ?',
      ).get(snapshot.id) as Row;
      let nextPosition = Number(currentMaximum.position) + 1;
      const source = this.database.prepare(`
        INSERT INTO source_messages (conversation_id, source_id, revision, role, text, complete, position, translated_text, translation_status, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id, source_id) DO UPDATE SET
          revision=excluded.revision, role=excluded.role, text=excluded.text, complete=excluded.complete, translated_text=excluded.translated_text, translation_status=excluded.translation_status, timestamp=excluded.timestamp
        WHERE excluded.revision >= source_messages.revision
      `);
      const seen = new Set<string>();
      for (const message of snapshot.codingMessages) {
        if (seen.has(message.sourceId)) continue;
        seen.add(message.sourceId);
        source.run(snapshot.id, message.sourceId, message.revision, message.role, message.text, Number(message.complete), nextPosition++, message.translatedText ?? null, message.translationStatus ?? null, message.timestamp ?? null);
      }

      this.database.prepare('DELETE FROM discussion_turns WHERE conversation_id = ?').run(snapshot.id);
      const discussion = this.database.prepare(
        'INSERT INTO discussion_turns (conversation_id, position, role, text, attachments_json, turn_id, complete) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      snapshot.discussion.forEach((turn, position) => discussion.run(snapshot.id, position, turn.role, turn.text, turn.attachments?json(turn.attachments):null, turn.id ?? `${snapshot.id}:legacy:${position}`, Number(turn.complete ?? Boolean(turn.text.trim()))));

      this.database.prepare('UPDATE drafts SET is_current = 0 WHERE conversation_id = ?').run(snapshot.id);
      if (snapshot.currentDraft) {
        const draft = snapshot.currentDraft;
        this.database.prepare(`
          INSERT INTO drafts (
            id, revision, conversation_id, target_json, source_revision, language,
            localized_text, english_text, is_current
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
          ON CONFLICT(id, revision) DO UPDATE SET is_current=1,
            localized_text=excluded.localized_text, english_text=excluded.english_text
        `).run(
          draft.id, draft.revision, snapshot.id, json(draft.target), draft.sourceRevision,
          draft.language, draft.localizedText, draft.englishText,
        );
      }
      this.database.prepare('UPDATE conversations SET composer_draft_json = ? WHERE id = ?').run(snapshot.composerDraft ? json(snapshot.composerDraft) : null, snapshot.id);
      if (snapshot.composerDraft) {
        const d = snapshot.composerDraft;
        this.database.prepare('INSERT OR IGNORE INTO drafts (id, revision, conversation_id, target_json, source_revision, language, localized_text, english_text, is_current) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)').run(d.id, d.revision, snapshot.id, json(d.target), d.sourceRevision, d.language, d.localizedText, d.englishText);
      }
      if(snapshot.currentDraft) this.database.prepare('UPDATE drafts SET attachments_json = ? WHERE id = ? AND revision = ?').run(snapshot.currentDraft.attachments?json(snapshot.currentDraft.attachments):null,snapshot.currentDraft.id,snapshot.currentDraft.revision);
      if (snapshot.currentDraft) this.database.prepare('UPDATE drafts SET selected_discussion_json = ? WHERE id = ? AND revision = ?').run(snapshot.currentDraft.selectedDiscussion ? json(snapshot.currentDraft.selectedDiscussion) : null, snapshot.currentDraft.id, snapshot.currentDraft.revision);
      const deliveryInsert = this.database.prepare(`
        INSERT OR IGNORE INTO deliveries
          (id, draft_id, revision, target_json, english_text, state, reason, native_message_id, native_after_revision, attachments_json, reference_format, transport, channel_generation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of snapshot.deliveries) {
        deliveryInsert.run(
          item.id, item.draftId, item.revision, json(item.target), item.englishText,
          item.state, item.reason ?? null, item.nativeMessageId ?? null, item.nativeAfterRevision ?? null, item.attachments ? json(item.attachments) : null, item.referenceFormat ?? null, item.transport ?? null, item.channelGeneration ?? null,
        );
      }
    });
  }

  claimDelivery(delivery: Delivery): boolean {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO deliveries
        (id, draft_id, revision, target_json, english_text, state, reason, native_message_id, native_after_revision, attachments_json, reference_format, transport, channel_generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      delivery.id, delivery.draftId, delivery.revision, json(delivery.target),
      delivery.englishText, delivery.state, delivery.reason ?? null, delivery.nativeMessageId ?? null, delivery.nativeAfterRevision ?? null, delivery.attachments ? json(delivery.attachments) : null, delivery.referenceFormat ?? null, delivery.transport ?? null, delivery.channelGeneration ?? null,
    );
    return result.changes === 1;
  }

  updateDelivery(delivery: Delivery): void {
    this.database.prepare(`
      UPDATE deliveries SET target_json = ?, english_text = ?, state = ?, reason = ?, native_message_id = ?, native_after_revision = ?, attachments_json = ?, reference_format = ?, transport = ?, channel_generation = ?
      WHERE draft_id = ? AND revision = ?
    `).run(
      json(delivery.target), delivery.englishText, delivery.state, delivery.reason ?? null, delivery.nativeMessageId ?? null, delivery.nativeAfterRevision ?? null, delivery.attachments ? json(delivery.attachments) : null, delivery.referenceFormat ?? null, delivery.transport ?? null, delivery.channelGeneration ?? null,
      delivery.draftId, delivery.revision,
    );
  }

  getDelivery(draftId: string, revision: number): Delivery | undefined {
    const item = this.database.prepare('SELECT * FROM deliveries WHERE draft_id = ? AND revision = ?')
      .get(draftId, revision) as Row | undefined;
    if (!item) return undefined;
    return {
      id: String(item.id), draftId: String(item.draft_id), revision: Number(item.revision),
      target: parse<Target>(item.target_json), englishText: String(item.english_text),
      state: String(item.state) as Delivery['state'],
      ...(item.transport === 'channel' || item.transport === 'peer' ? { transport: item.transport } : {}),
      ...(typeof item.channel_generation === 'string' ? { channelGeneration: item.channel_generation } : {}),
        ...(typeof item.attachments_json === 'string' ? { attachments: parse<NonNullable<Delivery['attachments']>>(item.attachments_json) } : {}),
        ...(item.reference_format === 'manifest-v1' ? {referenceFormat:'manifest-v1' as const} : {}),
        ...(typeof item.native_after_revision === 'number' ? { nativeAfterRevision: item.native_after_revision } : {}),
        ...(typeof item.native_message_id === 'string' ? { nativeMessageId: item.native_message_id } : {}),
      ...(optionalString(item.reason) !== undefined && { reason: String(item.reason) }),
    };
  }

  recoverInFlightDeliveries(): number {
    const result = this.database.prepare(`
      UPDATE deliveries SET state = 'unconfirmed',
        reason = COALESCE(reason, 'Delivery was interrupted before confirmation')
      WHERE state = 'sending'
    `).run();
    return Number(result.changes);
  }

  getTranslation(key: TranslationKey): string | undefined {
    const row = this.database.prepare(`
      SELECT text FROM translations WHERE source_scope = ? AND source_id = ?
        AND source_revision = ? AND content_hash = ? AND language = ? AND model = ? AND prompt_version = ?
    `).get(
      key.sourceScope, key.sourceId, key.sourceRevision, key.contentHash,
      key.language, key.model, key.promptVersion,
    ) as Row | undefined;
    return row && String(row.text);
  }

  putTranslation(key: TranslationKey, text: string): void {
    this.database.prepare(`
      INSERT INTO translations (
        source_scope, source_id, source_revision, content_hash, language, model, prompt_version, text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET text=excluded.text
    `).run(
      key.sourceScope, key.sourceId, key.sourceRevision, key.contentHash,
      key.language, key.model, key.promptVersion, text,
    );
  }

  readContext(projectId: string): string | undefined {
    const row = this.database.prepare('SELECT text FROM project_context WHERE project_id = ?')
      .get(projectId) as Row | undefined;
    return row && String(row.text);
  }

  writeContext(projectId: string, text: string): void {
    this.database.prepare(`
      INSERT INTO project_context(project_id, text) VALUES (?, ?)
      ON CONFLICT(project_id) DO UPDATE SET text=excluded.text
    `).run(projectId, text);
  }

  deleteContext(projectId: string): void {
    this.database.prepare('DELETE FROM project_context WHERE project_id = ?').run(projectId);
  }

  private deleteConversationRows(id: string): void {
    this.database.prepare(`
      DELETE FROM deliveries WHERE draft_id IN (
        SELECT id FROM drafts WHERE conversation_id = ?
      )
    `).run(id);
    this.database.prepare('DELETE FROM translations WHERE source_scope = ?').run(id);
    this.database.prepare('DELETE FROM session_seen WHERE session_id = ?').run(id);
    this.database.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }

  deleteConversation(id: string): void {
    this.transaction(() => this.deleteConversationRows(id));
  }

  /** Removes a session from the app's history: conversation, panel row (cascading workspace and file rows, language override) and its ended launch records. Never touches agent transcripts. */
  deleteSession(id: string): void {
    this.transaction(() => {
      this.deleteConversationRows(id);
      this.database.prepare("DELETE FROM session_launches WHERE json_extract(data_json,'$.panelSessionId') = ? AND json_extract(data_json,'$.state') = 'ended'").run(id);
      this.database.prepare('DELETE FROM panel_sessions WHERE id = ?').run(id);
    });
  }

  list(projectId?: string): ConversationSummary[] {
    const rows = (projectId === undefined
      ? this.database.prepare('SELECT * FROM conversations ORDER BY rowid DESC').all()
      : this.database.prepare('SELECT * FROM conversations WHERE project_id = ? ORDER BY rowid DESC').all(projectId)
    ) as Row[];
    return rows.map((row) => {
      const target = row.target_json === null ? undefined : parse<Target>(row.target_json);
      return {
        id: String(row.id),
        ...(target && { target, projectId: target.projectId }),
        language: String(row.language), languageModel: String(row.language_model),
        sourceRevision: Number(row.source_revision),
      };
    });
  }

  close(): void {
    this.database.close();
  }
}
