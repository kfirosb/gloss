/** Append-only schema history. Never edit an applied migration to change existing data. */
export const MIGRATIONS = [
  {
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
  },
  {
    version: 2,
    sql: 'ALTER TABLE conversations ADD COLUMN source_gaps_json TEXT;',
  },
  {
    version: 3,
    sql: 'ALTER TABLE source_messages ADD COLUMN translated_text TEXT; ALTER TABLE source_messages ADD COLUMN translation_status TEXT;',
  },
  {
    version: 4,
    sql: 'ALTER TABLE conversations ADD COLUMN source_session_id TEXT; ALTER TABLE conversations ADD COLUMN source_cursor TEXT; ALTER TABLE conversations ADD COLUMN source_sequence INTEGER;',
  },
  {
    version: 5,
    sql: 'ALTER TABLE source_messages ADD COLUMN timestamp TEXT;',
  },
  {
    version: 6,
    // Regenerate derived Hebrew translations once under the revised terminology style.
    sql: `UPDATE source_messages SET translated_text = NULL, translation_status = NULL
    WHERE conversation_id IN (SELECT id FROM conversations WHERE lower(language) IN ('he', 'hebrew') OR lower(language) LIKE 'he-%');`,
  },
  { version: 7, sql: 'ALTER TABLE drafts ADD COLUMN selected_discussion_json TEXT;' },
  { version: 8, sql: 'ALTER TABLE deliveries ADD COLUMN native_message_id TEXT;' },
  { version: 9, sql: 'ALTER TABLE conversations ADD COLUMN composer_draft_json TEXT;' },
  { version: 10, sql: 'ALTER TABLE deliveries ADD COLUMN native_after_revision INTEGER;' },
  { version: 11, sql: 'ALTER TABLE deliveries ADD COLUMN attachments_json TEXT;' },
  {
    version: 12,
    sql: 'ALTER TABLE discussion_turns ADD COLUMN attachments_json TEXT; ALTER TABLE drafts ADD COLUMN attachments_json TEXT;',
  },
  {
    version: 13,
    sql: `
  UPDATE discussion_turns AS reply SET attachments_json = (
    SELECT source.attachments_json FROM discussion_turns AS source
    WHERE source.conversation_id = reply.conversation_id
      AND source.position = reply.position - 1 AND source.role = 'user'
  ) WHERE reply.role = 'assistant';
`,
  },
  {
    version: 14,
    sql: `
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
`,
  },
  {
    version: 15,
    sql: `
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
`,
  },
  { version: 16, sql: 'ALTER TABLE deliveries ADD COLUMN reference_format TEXT;' },
  { version: 17, sql: 'ALTER TABLE panel_sessions ADD COLUMN session_title TEXT;' },
  {
    version: 18,
    sql: `
  ALTER TABLE discussion_turns ADD COLUMN turn_id TEXT;
  ALTER TABLE discussion_turns ADD COLUMN complete INTEGER;
  UPDATE discussion_turns SET turn_id = conversation_id || ':legacy:' || position,
    complete = CASE WHEN length(trim(text)) > 0 THEN 1 ELSE 0 END;
  CREATE TABLE response_summaries (cache_key TEXT PRIMARY KEY, text TEXT NOT NULL);
`,
  },
  {
    version: 19,
    sql: 'ALTER TABLE deliveries ADD COLUMN transport TEXT; ALTER TABLE deliveries ADD COLUMN channel_generation TEXT;',
  },
  {
    version: 20,
    sql: `
  CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
  ALTER TABLE panel_sessions ADD COLUMN language_override_json TEXT;
`,
  },
  {
    version: 21,
    sql: 'CREATE TABLE session_launches (id TEXT PRIMARY KEY, data_json TEXT NOT NULL);',
  },
  {
    version: 22,
    sql: 'CREATE TABLE connected_folders (path TEXT PRIMARY KEY, project_key TEXT NOT NULL, kind TEXT NOT NULL, created_by_app INTEGER NOT NULL, connected_at INTEGER NOT NULL);',
  },
  {
    version: 23,
    sql: 'CREATE TABLE session_seen (session_id TEXT PRIMARY KEY, seen_sequence INTEGER NOT NULL, seen_at INTEGER NOT NULL);',
  },
  {
    version: 24,
    sql: 'CREATE TABLE language_spend (scope TEXT NOT NULL, provider TEXT NOT NULL, usd REAL, input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL, PRIMARY KEY (scope, provider));',
  },
  {
    version: 25,
    sql: 'CREATE TABLE file_reviews (cache_key TEXT PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL);',
  },
  {
    version: 26,
    sql: 'ALTER TABLE source_messages ADD COLUMN translation_language TEXT;',
  },
  {
    version: 27,
    // The request id a native user record carries (a peer message's Gloss tag), so a reload still matches its delivery.
    sql: 'ALTER TABLE source_messages ADD COLUMN client_id TEXT;',
  },
] as const;
