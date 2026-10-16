import { opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { OpenSessionScan } from '../../core/session-catalog.js';
import { collectProcess, runProcess, type ProcessRunner } from '../../runtime/process-runner.js';
import { projectIdentity, uuid } from '../shared.js';
import { supportsCodexProtocol, type CodexAdapterOptions } from './index.js';
import { normalizeSessionTitle } from '../../core/session-title.js';
import { resolveLiveness, type LockedThread, type ThreadLiveness } from './liveness.js';

interface Metadata {
  id: string;
  cwd: string;
  cli_version: string;
  source: string;
  thread_source: string;
  agent_path: string | null;
  originator: string | null;
  title?: unknown;
  name?: unknown;
  created_at?: unknown;
  created_at_ms?: unknown;
}
function origin(row: Metadata): 'user' | 'internal' | 'unknown' {
  let source: unknown = row.source;
  try {
    source = JSON.parse(row.source);
  } catch {
    /* Native scalar sources are unquoted in SQLite. */
  }
  if (source === 'exec' || row.thread_source === 'subagent' || row.agent_path) return 'internal';
  if (source && typeof source === 'object' && ('subagent' in source || 'internal' in source))
    return 'internal';
  // Only established interactive native origins are admitted. A new origin must
  // be classified explicitly before its history can trigger language work.
  return (source === 'cli' || (source === 'vscode' && row.originator === 'codex-tui')) &&
    row.thread_source === 'user'
    ? 'user'
    : 'unknown';
}

/** Thread creation time in epoch milliseconds, from the same metadata row (no extra probe). */
function threadCreatedAt(row: Metadata): number | undefined {
  const ms = Number(row.created_at_ms);
  if (
    row.created_at_ms !== null &&
    row.created_at_ms !== undefined &&
    Number.isFinite(ms) &&
    ms > 0
  )
    return ms;
  const seconds = Number(row.created_at);
  return row.created_at !== null &&
    row.created_at !== undefined &&
    Number.isFinite(seconds) &&
    seconds > 0
    ? seconds * 1000
    : undefined;
}

/** Associate each exact file with its own process; never inherit ownership across records. */
async function ownedPaths(
  paths: string[],
  runner: ProcessRunner,
  signal: AbortSignal,
): Promise<Map<string, number>> {
  const result = await collectProcess(
    runner('/usr/sbin/lsof', ['-Fpcfn', '--', ...paths], '', signal, {
      timeoutMs: 3000,
      maxOutputBytes: 1024 * 1024,
    }),
  );
  if (
    result.outcome.reason !== 'exited' ||
    ![0, 1].includes(result.outcome.code ?? -1) ||
    result.outcome.diagnostics.trim()
  )
    throw new Error('Writer probe failed');
  const expected = new Set(paths);
  const owned = new Map<string, number>();
  let pid = 0;
  let processSeen = false;
  let command: string | undefined;
  let fileSeen = false;
  let awaitingName = false;
  const malformed = () => {
    throw new Error('Writer ownership output is incomplete');
  };
  const finishProcess = () => {
    if (processSeen && (command === undefined || !fileSeen || awaitingName)) malformed();
  };
  for (const line of result.lines) {
    if (/^p[1-9]\d*$/.test(line)) {
      finishProcess();
      pid = Number(line.slice(1));
      processSeen = true;
      command = undefined;
      fileSeen = false;
    } else if (line.startsWith('c') && line.length > 1) {
      if (!processSeen || command !== undefined || fileSeen) malformed();
      command = line.slice(1);
    } else if (line.startsWith('f') && line.length > 1) {
      if (!processSeen || command === undefined || awaitingName) malformed();
      fileSeen = true;
      awaitingName = true;
    } else if (line.startsWith('n')) {
      const path = line.slice(1);
      if (!awaitingName || !expected.has(path)) malformed();
      awaitingName = false;
      if (command === 'codex' && !owned.has(path)) owned.set(path, pid);
    } else malformed();
  }
  finishProcess();
  if (!processSeen && result.outcome.code === 0) malformed();
  return owned;
}

interface WriterScan {
  locks: string;
  owned: Map<string, number>;
  complete: boolean;
  error?: string;
  cancelled?: boolean;
}

/** Enumerates writer locks and the process holding each, without reading any transcript. */
async function scanWriters(options: CodexAdapterOptions, signal: AbortSignal): Promise<WriterScan> {
  const scan: WriterScan = { locks: '', owned: new Map(), complete: true };
  const fail = (error: string) => {
    scan.complete = false;
    scan.error ??= error;
  };
  const home = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  let locks = join(home, 'thread-writer-locks');
  const candidates: string[] = [];
  try {
    locks = await realpath(locks);
    const directory = await opendir(locks);
    for await (const entry of directory) {
      if (signal.aborted) return { ...scan, cancelled: true };
      if (!entry.isFile() || !entry.name.endsWith('.lock') || !uuid.test(entry.name.slice(0, -5)))
        continue;
      candidates.push(entry.name.slice(0, -5));
      if (candidates.length > 10_000) {
        fail('Codex writer enumeration exceeds bound');
        return scan;
      }
    }
  } catch {
    fail('Codex writer enumeration failed');
    return scan;
  }
  scan.locks = locks;
  // One lsof process walks the native process table for many exact files. Bound
  // both argv bytes and file count; a large inventory uses at most four concurrent probes.
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 0;
  for (const id of candidates) {
    const path = join(locks, `${id}.lock`);
    const size = Buffer.byteLength(path) + 1;
    if (size > 65536) {
      fail('Codex writer path exceeds bound');
      continue;
    }
    if (batch.length === 128 || bytes + size > 65536) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(path);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  let next = 0;
  const worker = async () => {
    while (!signal.aborted) {
      const paths = batches[next++];
      if (!paths) return;
      try {
        for (const [path, pid] of await ownedPaths(paths, options.runner ?? runProcess, signal))
          scan.owned.set(path.slice(locks.length + 1, -5), pid);
      } catch {
        fail('Codex writer ownership verification failed');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, batches.length) }, worker));
  if (signal.aborted) return { ...scan, cancelled: true };
  return scan;
}

type MetadataQuery = (id: string) => Metadata[];
function openMetadata(options: CodexAdapterOptions): { query: MetadataQuery; close(): void } {
  const home = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const db = new DatabaseSync(options.databasePath ?? join(home, 'state_5.sqlite'), {
    readOnly: true,
  });
  try {
    const columns = new Set(
      db
        .prepare('PRAGMA table_info(threads)')
        .all()
        .map((column) => column.name),
    );
    const optional = ['title', 'name', 'created_at', 'created_at_ms'].filter((name) =>
      columns.has(name),
    );
    const statement = db.prepare(
      `SELECT id,cwd,cli_version,source,thread_source,agent_path,originator${optional.map((name) => ',' + name).join('')} FROM threads WHERE id = ?`,
    );
    return { query: (id) => statement.all(id) as unknown as Metadata[], close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Decides liveness for every locked thread (see liveness.ts). Daemon-held threads use their metadata folder and creation time. */
async function writerLiveness(
  scan: WriterScan,
  query: MetadataQuery | undefined,
  options: CodexAdapterOptions,
  signal: AbortSignal,
): Promise<Map<string, ThreadLiveness>> {
  const threads: LockedThread[] = [...scan.owned].map(([id, ownerPid]) => {
    let row: Metadata | undefined;
    try {
      const rows = query?.(id) ?? [];
      if (rows.length === 1) row = rows[0];
    } catch {
      /* Missing metadata leaves the folder unknown. */
    }
    const createdAt = row ? threadCreatedAt(row) : undefined;
    return {
      id,
      ownerPid,
      ...(typeof row?.cwd === 'string' ? { cwd: row.cwd } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
    };
  });
  return resolveLiveness(threads, {
    runner: options.runner ?? runProcess,
    signal,
    now: options.now?.() ?? Date.now(),
    ...(options.launched ? { launched: options.launched } : {}),
  });
}

/** Liveness of every locked thread, for adapter status checks. Throws when it cannot be verified. */
export async function codexThreadLiveness(
  options: CodexAdapterOptions,
  signal: AbortSignal,
): Promise<Map<string, ThreadLiveness>> {
  if (process.platform !== 'darwin')
    throw new Error('Codex writer ownership verification is unavailable on this platform');
  const scan = await scanWriters(options, signal);
  if (scan.cancelled) throw new Error('Codex liveness check cancelled');
  if (!scan.complete && !scan.owned.size)
    throw new Error(scan.error ?? 'Codex writer enumeration failed');
  let metadata: ReturnType<typeof openMetadata> | undefined;
  try {
    metadata = openMetadata(options);
  } catch {
    /* Daemon-held threads then stay closed. */
  }
  try {
    return await writerLiveness(scan, metadata?.query, options, signal);
  } finally {
    metadata?.close();
  }
}

/** Metadata-only discovery: writer candidates first, attachment second, exact SQLite rows last. */
export async function discoverOpenCodex(
  options: CodexAdapterOptions,
  signal: AbortSignal,
): Promise<OpenSessionScan> {
  const result: OpenSessionScan = { candidates: [], complete: true };
  const fail = (error: string) => {
    result.complete = false;
    result.error ??= error;
  };
  const cancelled = (): OpenSessionScan => ({
    candidates: [],
    complete: false,
    error: 'Codex discovery cancelled',
  });
  if (signal.aborted) return cancelled();
  if (process.platform !== 'darwin')
    return {
      candidates: [],
      complete: false,
      error: 'Codex writer ownership verification is unavailable on this platform',
    };
  const scan = await scanWriters(options, signal);
  if (scan.cancelled || signal.aborted) return cancelled();
  if (!scan.complete) fail(scan.error!);
  if (!scan.owned.size) return result;
  let metadata: ReturnType<typeof openMetadata>;
  try {
    metadata = openMetadata(options);
  } catch {
    fail('Codex session metadata unavailable');
    return result;
  }
  try {
    let liveness: Map<string, ThreadLiveness>;
    try {
      liveness = await writerLiveness(scan, metadata.query, options, signal);
    } catch {
      if (signal.aborted) return cancelled();
      fail('Codex terminal attachment verification failed');
      return result;
    }
    if (signal.aborted) return cancelled();
    for (const [id, nativePid] of scan.owned) {
      if (signal.aborted) return cancelled();
      // A thread nobody is attached to cannot process a message: it is closed, not open.
      if (!liveness.get(id)?.open) continue;
      try {
        const rows = metadata.query(id);
        if (rows.length !== 1) {
          fail('Codex writer metadata pending or ambiguous');
          continue;
        }
        const row = rows[0]!;
        const classification = origin(row);
        if (classification === 'internal') continue;
        if (classification === 'unknown') {
          fail('Codex session origin is unverified');
          continue;
        }
        if (row.id !== id || typeof row.cwd !== 'string' || typeof row.cli_version !== 'string') {
          fail('Codex session identity is unverified');
          continue;
        }
        const projectId = await projectIdentity(row.cwd);
        if (signal.aborted) return cancelled();
        const sessionTitle = normalizeSessionTitle(row.name) ?? normalizeSessionTitle(row.title);
        const createdAt = threadCreatedAt(row);
        result.candidates.push({
          ...(sessionTitle ? { sessionTitle } : {}),
          target: { agent: 'codex', sessionRef: id, projectId },
          nativePid,
          ...(createdAt !== undefined ? { createdAt } : {}),
          ...(supportsCodexProtocol(row.cli_version)
            ? { support: 'supported' as const }
            : {
                support: 'unsupported' as const,
                reason: 'Unsupported Codex local protocol version',
              }),
        });
      } catch {
        fail('Codex writer or session metadata verification failed');
      }
    }
  } catch {
    fail('Codex session metadata schema unavailable');
  } finally {
    metadata.close();
  }
  if (signal.aborted) return cancelled();
  result.candidates.sort((a, b) => a.target.sessionRef.localeCompare(b.target.sessionRef));
  return result;
}
