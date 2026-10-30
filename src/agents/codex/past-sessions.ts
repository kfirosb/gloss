import { DatabaseSync } from 'node:sqlite';
import { latestFirst, type AgentPastSession } from '../../core/past-sessions.js';
import { normalizeSessionTitle } from '../../core/session-title.js';
import { projectIdentity } from '../shared.js';
import { threadOrigin } from './discovery.js';
import { supportsCodexProtocol } from './index.js';

const MAX_ENTRIES = 10_000;

interface PastRow {
  id: string;
  cwd: string;
  cli_version: string;
  source: string;
  thread_source: string;
  agent_path: string | null;
  originator: string | null;
  title?: unknown;
  first_user_message?: unknown;
  updated_at?: unknown;
  updated_at_ms?: unknown;
  git_branch?: unknown;
}

/** Last activity in epoch milliseconds: a `_ms` column when present, else seconds, as for thread creation. */
function updatedAt(row: PastRow): number | undefined {
  for (const [value, scale] of [
    [row.updated_at_ms, 1],
    [row.updated_at, 1000],
  ] as const) {
    const n = Number(value);
    if (value !== null && value !== undefined && Number.isFinite(n) && n > 0) return n * scale;
  }
  return undefined;
}

/** Non-archived `user` threads of the folder with a first user message; title from `title` then `first_user_message`; lastActiveAt from `updated_at` (seconds or ms, same rule as threadCreatedAt). */
export async function listCodexPastSessions(
  databasePath: string,
  projectPath: string,
): Promise<AgentPastSession[]> {
  let rows: PastRow[];
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const columns = new Set(
      db
        .prepare('PRAGMA table_info(threads)')
        .all()
        .map((column) => column.name),
    );
    const optional = [
      'title',
      'first_user_message',
      'updated_at',
      'updated_at_ms',
      'git_branch',
    ].filter((name) => columns.has(name));
    const where = [
      ...(columns.has('archived') ? ['COALESCE(archived,0) = 0'] : []),
      ...(columns.has('first_user_message') ? ["COALESCE(first_user_message,'') <> ''"] : []),
    ];
    rows = db
      .prepare(
        `SELECT id,cwd,cli_version,source,thread_source,agent_path,originator${optional.map((name) => ',' + name).join('')} FROM threads${where.length ? ' WHERE ' + where.join(' AND ') : ''} LIMIT ${MAX_ENTRIES + 1}`,
      )
      .all() as unknown as PastRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
  if (rows.length > MAX_ENTRIES) throw new Error('Session metadata enumeration exceeds bound');
  const folder = await projectIdentity(projectPath);
  const sessions: AgentPastSession[] = [];
  for (const row of rows) {
    if (
      typeof row.cwd !== 'string' ||
      !supportsCodexProtocol(row.cli_version) ||
      threadOrigin(row) !== 'user'
    )
      continue;
    // A thread without a usable timestamp is still listed, without a time, after dated ones.
    const lastActiveAt = updatedAt(row);
    try {
      if ((await projectIdentity(row.cwd)) !== folder) continue;
    } catch {
      continue; // deleted folder
    }
    const title = normalizeSessionTitle(row.title) ?? normalizeSessionTitle(row.first_user_message);
    const branch = normalizeSessionTitle(row.git_branch);
    sessions.push({
      agent: 'codex',
      sessionRef: row.id,
      ...(title ? { title } : {}),
      ...(lastActiveAt !== undefined ? { lastActiveAt } : {}),
      ...(branch ? { branch } : {}),
    });
  }
  return sessions.sort(latestFirst);
}
