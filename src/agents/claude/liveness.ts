import { observedOwners } from '../shared.js';
import type { ProcessRunner } from '../../runtime/process-runner.js';

export type Liveness = 'alive' | 'not-alive' | 'failed';
/**
 * How long one socket-owner answer is reused, in milliseconds. A closed session is
 * noticed within about this plus one 750 ms status poll, in exchange for one `lsof`
 * walk of the process table per window instead of one per socket per poll.
 */
export const CLAUDE_LIVENESS_TTL_MS = 3000;
const MAX_ENTRIES = 500;

export interface SocketRecord {
  pid: number;
  version: string;
  messagingSocketPath: string;
}
export interface ClaudeLivenessOptions {
  runner?: ProcessRunner;
  /** Only a definite "no such process" counts; lsof still decides every "alive". */
  processExists?: (pid: number) => boolean;
  now?: () => number;
  ttlMs?: number;
}

/** `kill(pid, 0)` sends nothing; only ESRCH proves the process is gone. Callers pass validated positive PIDs. */
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

interface Entry {
  record: SocketRecord;
  state?: Liveness;
  expiresAt: number;
  lastRequested: number;
  pending?: Promise<Liveness> | undefined;
}

/**
 * Shared, short-lived answers to "is this socket held by this session's own Claude
 * process?". Keys include PID, socket and version, so an identity change is always a
 * fresh check. Status polls run on independent phases, so each flush refreshes every
 * recently requested record together and the whole working set shares one `lsof`.
 */
export function createClaudeLiveness(options: ClaudeLivenessOptions = {}) {
  const {
    runner,
    processExists = pidExists,
    now = Date.now,
    ttlMs = CLAUDE_LIVENESS_TTL_MS,
  } = options;
  const entries = new Map<string, Entry>();
  let queued: { batch: Set<Entry>; done: Promise<void> } | undefined;

  const keyOf = (r: SocketRecord) => JSON.stringify([r.messagingSocketPath, r.pid, r.version]);

  async function judge(batch: readonly Entry[]): Promise<Map<Entry, Liveness>> {
    const states = new Map<Entry, Liveness>();
    const probed = batch.filter((entry) => {
      const exists = processExists(entry.record.pid);
      if (!exists) states.set(entry, 'not-alive');
      return exists;
    });
    if (!probed.length) return states;
    const owners = await observedOwners(
      probed.map((entry) => entry.record.messagingSocketPath),
      runner,
    );
    for (const entry of probed) {
      const { pid, version, messagingSocketPath } = entry.record;
      const result = owners.get(messagingSocketPath);
      if (!result?.ok) continue;
      const names = ['claude', 'claude.exe', version];
      const owned = result.owners.some((o) => o.pid === pid && names.includes(o.command));
      states.set(entry, owned ? 'alive' : 'not-alive');
    }
    return states;
  }

  async function flush(batch: Set<Entry>) {
    if (queued?.batch === batch) queued = undefined;
    const states = await judge([...batch]).catch(() => new Map<Entry, Liveness>());
    const expiresAt = now() + ttlMs;
    for (const entry of batch) {
      // Anything not positively judged, including a failed or thrown probe, fails closed.
      entry.state = states.get(entry) ?? 'failed';
      entry.expiresAt = expiresAt;
      entry.pending = undefined;
    }
  }

  function enqueue(entry: Entry): Promise<Liveness> {
    if (!queued) {
      const batch = new Set<Entry>();
      const done = new Promise<void>((resolve) => setImmediate(resolve)).then(() => flush(batch));
      queued = { batch, done };
    }
    queued.batch.add(entry);
    return (entry.pending = queued.done.then(() => entry.state ?? 'failed'));
  }

  function request(record: SocketRecord): Promise<Liveness> {
    const key = keyOf(record);
    const at = now();
    const entry = entries.get(key) ?? { record, expiresAt: -Infinity, lastRequested: at };
    entries.delete(key);
    entries.set(key, entry);
    entry.lastRequested = at;
    if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    if (entry.pending) return entry.pending;
    if (entry.state && at <= entry.expiresAt) return Promise.resolve(entry.state);
    const pending = enqueue(entry);
    // Refresh the rest of the working set in the same walk; forget records nobody asked about lately.
    for (const [otherKey, other] of entries) {
      if (other.pending) continue;
      if (other.lastRequested < at - 2 * ttlMs) entries.delete(otherKey);
      else enqueue(other);
    }
    return pending;
  }

  return {
    check: request,
    checkMany: (records: readonly SocketRecord[]) => Promise.all(records.map(request)),
  };
}
