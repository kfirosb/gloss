import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { recordOf } from '../../core/json-record.js';
import { belongsToProject } from '../shared.js';
import { OWN_PID_DOMAIN } from './pid-domain.js';

/** One Claude `sessions/<pid>.json` record, as far as Gloss reads it. */
export interface ClaudeSessionRecord {
  sessionId: string;
  cwd: string;
  pid: number;
  version: string;
  messagingSocketPath?: string | undefined;
  status?: string | undefined;
  waitingFor?: unknown;
  peerProtocol?: number | undefined;
  entrypoint?: string | undefined;
  startedAt?: number | undefined;
  updatedAt?: number | undefined;
  name?: unknown;
  /** The process start time as `ps -o lstart=` prints it in UTC and the C locale; tells a reused pid apart. */
  procStart?: string | undefined;
  /** The process table `pid` and `procStart` belong to; only this host's own domain is comparable with its `ps`. */
  pidDomain?: string | undefined;
}
/** A record larger than this is not a session record, in bytes. */
const MAX_RECORD_BYTES = 65_536;
/** More entries than this in `sessions/` is treated as a broken directory. */
const MAX_RECORDS = 10_000;

function optional(value: unknown, type: 'string'): string | undefined;
function optional(value: unknown, type: 'number'): number | undefined;
function optional(value: unknown, type: 'string' | 'number') {
  return typeof value === type ? value : undefined;
}
export const sessionRecordPath = (config: string, pid: number) =>
  join(config, 'sessions', `${pid}.json`);
/** The fields of one parsed session record; undefined when a required field is missing or malformed. */
export function sessionRecordOf(value: unknown): ClaudeSessionRecord | undefined {
  const r = recordOf(value);
  if (
    typeof r?.sessionId !== 'string' ||
    typeof r.cwd !== 'string' ||
    typeof r.pid !== 'number' ||
    !Number.isInteger(r.pid) ||
    r.pid <= 0 ||
    typeof r.version !== 'string' ||
    // Preserve legacy missing fields without turning malformed values into discovery fallbacks.
    ('entrypoint' in r && typeof r.entrypoint !== 'string') ||
    ('messagingSocketPath' in r && typeof r.messagingSocketPath !== 'string')
  )
    return undefined;
  return {
    sessionId: r.sessionId,
    cwd: r.cwd,
    pid: r.pid,
    version: r.version,
    messagingSocketPath: optional(r.messagingSocketPath, 'string'),
    status: optional(r.status, 'string'),
    waitingFor: r.waitingFor,
    peerProtocol: optional(r.peerProtocol, 'number'),
    entrypoint: optional(r.entrypoint, 'string'),
    startedAt: optional(r.startedAt, 'number'),
    updatedAt: optional(r.updatedAt, 'number'),
    name: r.name,
    // A non-string or empty start time cannot identify the process; it reads as absent.
    procStart: optional(r.procStart, 'string') || undefined,
    pidDomain: optional(r.pidDomain, 'string'),
  };
}
/**
 * The record's process start time, when it can be compared with this host's `ps`: the record says its pid lives in
 * this host's own pid domain. Anything else cannot tell a reused pid apart, so it is not trusted.
 */
export function trustedProcStart(
  record: Pick<ClaudeSessionRecord, 'pidDomain' | 'procStart'>,
  ownDomain: string = OWN_PID_DOMAIN,
): string | undefined {
  return record.pidDomain === ownDomain ? record.procStart : undefined;
}
/** A session run in a terminal: Claude Desktop and SDK language workers write other entrypoints; older Claude wrote none. */
export function isTerminalRecord(record: Pick<ClaudeSessionRecord, 'entrypoint'>): boolean {
  return record.entrypoint === undefined || record.entrypoint === 'cli';
}
/** One `sessions/*.json` record; undefined when it is missing, too large or malformed. */
export async function readSessionRecord(path: string): Promise<ClaudeSessionRecord | undefined> {
  try {
    if ((await stat(path)).size > MAX_RECORD_BYTES) return undefined;
    return sessionRecordOf(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    /* Unreadable metadata does not establish a target. */
  }
  return undefined;
}
export async function readSessionRecords(config: string): Promise<ClaudeSessionRecord[]> {
  let names: string[];
  try {
    names = await readdir(join(config, 'sessions'));
  } catch {
    return [];
  }
  if (names.length > MAX_RECORDS) throw new Error('Session metadata enumeration exceeds bound');
  const records: ClaudeSessionRecord[] = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const record = await readSessionRecord(join(config, 'sessions', name));
    if (record) records.push(record);
  }
  return records;
}
/**
 * This session's records whose folder is the project `projectId`, compared by real path; a record whose folder is gone
 * matches nothing. Throws when `projectId` itself does not resolve.
 */
export async function projectSessionRecords(
  config: string,
  sessionRef: string,
  projectId: string,
): Promise<ClaudeSessionRecord[]> {
  const matches: ClaudeSessionRecord[] = [];
  for (const record of await readSessionRecords(config)) {
    if (record.sessionId !== sessionRef) continue;
    try {
      if (await belongsToProject(projectId, record.cwd)) matches.push(record);
    } catch {
      /* missing project */
    }
  }
  return matches;
}
/**
 * Whether the process `pid` runs session `sessionRef` now, by Claude's own record for it, `sessions/<pid>.json`.
 * `/resume` and `/clear` switch sessions inside the same process: the pid stays and the record names the new session.
 */
export async function pidRunsSession(
  config: string,
  pid: number,
  sessionRef: string,
): Promise<boolean> {
  const record = await readSessionRecord(sessionRecordPath(config, pid));
  return record?.pid === pid && record.sessionId === sessionRef;
}
