import { recordOf, type JsonRecord } from '../core/json-record.js';
import { open, realpath } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { canSendWhileWorking, orderAgentMessages } from '../core/contracts.js';
import type {
  AgentCapabilities,
  AgentEvent,
  AgentMessage,
  CodingConnection,
  CodingState,
  Target,
} from '../core/contracts.js';
import type { ProviderUsage } from '../core/usage.js';
import { collectProcess, runProcess, type ProcessRunner } from '../runtime/process-runner.js';

/** Claude's config directory: explicit option, then a nonempty CLAUDE_CONFIG_DIR, then ~/.claude. */
export const claudeConfigDir = (configDir?: string, home = homedir()) =>
  configDir ?? (process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'));
/** Codex's home directory: explicit option, then a nonempty CODEX_HOME, then ~/.codex. */
export const codexHomeDir = (codexHome?: string, home = homedir()) =>
  codexHome ?? (process.env.CODEX_HOME || join(home, '.codex'));

export interface AdapterOptions {
  runner?: ProcessRunner;
  pollMs?: number;
  pageSize?: number;
  /** Optional host bridge for completed assistant messages only. */
  sourceSink?: SourceSink;
  /** A server-owned verified liveness probe. Never trust a browser-provided boolean. */
  observeLive?: (target: Target) => Promise<boolean>;
  clock?: { sleep(ms: number, signal: AbortSignal): Promise<void> };
}
export interface SourceSink {
  send(message: {
    agent: Target['agent'];
    sourceSessionId: string;
    sourceId: string;
    sequence: number;
    role: 'assistant';
    text: string;
    complete: true;
    cursor: string;
    timestamp?: string;
  }): Promise<void>;
}
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function projectIdentity(path: string): Promise<string> {
  return realpath(path);
}
export function validateTarget(target: Target, kind: Target['agent']) {
  if (target.agent !== kind || !uuid.test(target.sessionRef))
    throw new Error('Invalid target identity');
}
export interface SocketOwner {
  pid: number;
  command: string;
}
export type OwnerResult = { ok: true; owners: SocketOwner[] } | { ok: false };
const OWNER_PROBE_TIMEOUT_MS = 3000;
const OWNER_OUTPUT_BYTES_PER_PATH = 32_768;
const OWNER_OUTPUT_MAX_BYTES = 1024 * 1024;
const OWNER_BATCH_PATHS = 128;
const OWNER_BATCH_ARGV_BYTES = 65_536;
// A stale record whose socket file is gone must not fail every other path in its batch.
const MISSING_PATH_DIAGNOSTIC = /^lsof: status error on .+: No such file or directory$/;

/**
 * Holders of each exact path, from as few read-only `lsof` walks of the process
 * table as the argv bounds allow. A failed walk fails only its own paths.
 */
export async function observedOwners(
  paths: readonly string[],
  runner: ProcessRunner = runProcess,
  signal: AbortSignal = new AbortController().signal,
): Promise<Map<string, OwnerResult>> {
  const results = new Map<string, OwnerResult>();
  const unique = [...new Set(paths)];
  if (process.platform !== 'darwin') {
    for (const path of unique) results.set(path, { ok: true, owners: [] });
    return results;
  }
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 0;
  for (const path of unique) {
    const size = Buffer.byteLength(path) + 1;
    if (size > OWNER_BATCH_ARGV_BYTES) {
      results.set(path, { ok: false });
      continue;
    }
    if (batch.length === OWNER_BATCH_PATHS || bytes + size > OWNER_BATCH_ARGV_BYTES) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(path);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  for (const paths of batches) {
    const owners = await ownersOfBatch(paths, runner, signal).catch(() => undefined);
    for (const path of paths)
      results.set(path, owners ? { ok: true, owners: owners.get(path) ?? [] } : { ok: false });
  }
  return results;
}

async function ownersOfBatch(
  paths: string[],
  runner: ProcessRunner,
  signal: AbortSignal,
): Promise<Map<string, SocketOwner[]>> {
  // `+c 0` keeps the full command name; lsof otherwise truncates it to 9 characters, clipping `claude.exe`.
  const result = await collectProcess(
    runner('/usr/sbin/lsof', ['-Fpcfn', '+c', '0', '--', ...paths], '', signal, {
      timeoutMs: OWNER_PROBE_TIMEOUT_MS,
      maxOutputBytes: Math.min(OWNER_OUTPUT_BYTES_PER_PATH * paths.length, OWNER_OUTPUT_MAX_BYTES),
    }),
  );
  const { outcome } = result;
  if (
    outcome.reason !== 'exited' ||
    (outcome.code !== 0 && outcome.code !== 1) ||
    outcome.diagnostics
      .split('\n')
      .some((line) => line.trim() && !MISSING_PATH_DIAGNOSTIC.test(line.trim()))
  )
    throw new Error('Socket owner probe failed');
  const expected = new Set(paths);
  const owners = new Map<string, SocketOwner[]>();
  const malformed = () => {
    throw new Error('Socket owner output is malformed');
  };
  // Strict p -> c -> (f -> n)+ records; ownership is never inherited across processes.
  let pid = 0;
  let command: string | undefined;
  let processSeen = false;
  let fileSeen = false;
  let awaitingName = false;
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
      if (!awaitingName || !expected.has(path) || command === undefined) return malformed();
      awaitingName = false;
      const list = owners.get(path) ?? [];
      list.push({ pid, command });
      owners.set(path, list);
    } else malformed();
  }
  finishProcess();
  return owners;
}
export type Parsed = {
  message?: AgentMessage;
  state?: CodingState;
  delivery?: string;
  usage?: ProviderUsage;
  channelSeen?: string;
};
export type RecordParser = (value: JsonRecord, offset: number) => Parsed;
const CHUNK = 1024 * 1024;
const MAX_SCAN = 8;
/** Resolves after `ms`, or early (without rejecting) when the signal aborts. */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  delay(ms, undefined, { signal }).catch(() => undefined);

/** Versioned append-only JSONL reader. Positions are byte offsets, not JS character offsets. */
export class Transcript {
  private identity = '';
  private offset = 0;
  private checkpoint = { offset: 0, data: Buffer.alloc(0) };
  private pending = Buffer.alloc(0);
  private pendingStart = 0;
  private broken = false;
  private seen = new Map<string, { signature: string; revision: number }>();
  private initial: AgentEvent[] = [];
  private cursorScope = randomUUID();
  private fullyRead = false;
  state: CodingState = 'disconnected';
  /** A missing lifecycle marker is only safe to interpret after a complete, valid read. */
  get caughtUp(): boolean {
    return !this.broken && this.fullyRead && this.pending.length === 0;
  }
  constructor(
    readonly path: string,
    readonly parse: RecordParser,
    private readonly pageSize = 100,
  ) {}
  private failure(reason: string): never {
    this.broken = true;
    this.state = 'disconnected';
    throw new Error(reason);
  }
  private async checkedFile() {
    if (this.broken) throw new Error('Transcript changed or has a gap; reattach required');
    const file = await open(this.path, 'r');
    try {
      const stat = await file.stat();
      const id = `${stat.dev}:${stat.ino}`;
      if (!stat.isFile() || (this.identity && (id !== this.identity || stat.size < this.offset)))
        this.failure('Transcript changed');
      const checkpoint = this.checkpoint;
      if (checkpoint.data.length) {
        const buffer = Buffer.alloc(checkpoint.data.length);
        await file.read(buffer, 0, buffer.length, checkpoint.offset - buffer.length);
        if (!buffer.equals(checkpoint.data)) this.failure('Transcript changed');
      }
      this.identity = id;
      return { file, size: stat.size };
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  async initialize() {
    const { file, size } = await this.checkedFile();
    try {
      if (size > CHUNK) {
        const first = Buffer.alloc(CHUNK);
        const start = size - CHUNK;
        await file.read(first, 0, CHUNK, start);
        const newline = first.indexOf(10);
        if (newline < 0) this.failure('Transcript record exceeds read bound');
        this.offset = start + newline + 1;
        this.initial.push({
          type: 'gap',
          reason:
            'Live replay starts in a bounded tail; older messages are available through history.',
        });
      }
      this.pendingStart = this.offset;
    } finally {
      await file.close();
    }
    this.initial.push(...(await this.poll()));
  }
  /** History reads old, bounded windows; their failures must not end the live tail. */
  private lookbackFailure(reason: string): never {
    throw new Error(reason);
  }
  private decode(
    line: Buffer,
    position: number,
    fail: (reason: string) => never = (reason) => this.failure(reason),
  ): Parsed {
    if (!line.toString('utf8').trim()) return {};
    let record: JsonRecord | undefined;
    try {
      record = recordOf(JSON.parse(line.toString('utf8')));
    } catch {
      return fail('Malformed transcript record');
    }
    if (!record) return fail('Malformed transcript record');
    try {
      return this.parse(record, position);
    } catch {
      return fail('Malformed record or transcript identity mismatch');
    }
  }
  private canonicalMessage(
    message: AgentMessage,
    index: Map<string, { signature: string; revision: number }>,
  ): AgentMessage {
    const signature = JSON.stringify([message.role, message.text, message.complete]);
    const previous = index.get(message.sourceId);
    // Reuse only the current uninterrupted content revision, never an earlier X in X -> Y -> X.
    const revision =
      previous?.signature === signature && previous.revision <= message.revision
        ? previous.revision
        : message.revision;
    index.set(message.sourceId, { signature, revision });
    if (index.size > 10_000) index.delete(index.keys().next().value!);
    return { ...message, revision };
  }
  takeInitial(): AgentEvent[] {
    return this.initial.splice(0);
  }
  async poll(): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    const { file, size } = await this.checkedFile();
    try {
      const count = Math.min(CHUNK, size - this.offset);
      const chunk = Buffer.alloc(count);
      if (count) {
        const { bytesRead } = await file.read(chunk, 0, count, this.offset);
        this.offset += bytesRead;
        this.pending = Buffer.concat([this.pending, chunk.subarray(0, bytesRead)]);
      }
      let end: number;
      while ((end = this.pending.indexOf(10)) >= 0) {
        const line = this.pending.subarray(0, end);
        const position = this.pendingStart;
        this.pending = this.pending.subarray(end + 1);
        this.pendingStart += end + 1;
        const parsed = this.decode(line, position);
        if (parsed.state) this.state = parsed.state;
        if (parsed.message) {
          const signature = JSON.stringify([
            parsed.message.role,
            parsed.message.text,
            parsed.message.complete,
          ]);
          const previous = this.seen.get(parsed.message.sourceId);
          if (!previous && this.seen.size === 10_000)
            events.push({
              type: 'gap',
              reason: 'Live deduplication window exceeded; reconcile source IDs.',
            });
          const message = this.canonicalMessage(parsed.message, this.seen);
          if (previous?.signature !== signature) events.push({ type: 'message', message });
        }
        if (parsed.delivery)
          events.push({ type: 'delivery', requestId: parsed.delivery, state: 'sent' });
        if (parsed.usage) events.push({ type: 'usage', usage: parsed.usage });
        if (parsed.channelSeen)
          events.push({ type: 'channel-seen', requestId: parsed.channelSeen });
      }
      if (this.pending.length > CHUNK) this.failure('Transcript record exceeds read bound');
      this.fullyRead = this.offset === size;
      if (!this.fullyRead || this.pending.length) this.state = 'disconnected';
      const checkpoint = Buffer.alloc(Math.min(64, this.offset));
      await file.read(checkpoint, 0, checkpoint.length, this.offset - checkpoint.length);
      this.checkpoint = { offset: this.offset, data: checkpoint };
      return events;
    } finally {
      await file.close();
    }
  }
  async history(cursor?: string): Promise<{ messages: AgentMessage[]; next?: string }> {
    const { file, size } = await this.checkedFile();
    try {
      let end = size;
      if (cursor !== undefined) {
        const parts = cursor.split(':');
        if (parts[0] !== this.cursorScope || !/^\d+$/.test(parts[1] ?? ''))
          throw new Error('Invalid history cursor');
        end = Number(parts[1]);
        if (!Number.isSafeInteger(end) || end > size) throw new Error('Invalid history cursor');
      }
      const found = new Map<string, AgentMessage>();
      let scans = 0;
      const revisions = new Map(this.seen);
      while (end > 0 && scans++ < MAX_SCAN) {
        const previousEnd = end;
        let window = CHUNK;
        let start: number;
        let chunk: Buffer;
        let first: number;
        // A record larger than the normal window can leave only its trailing
        // newline in view. Expand the lookback until a complete row is present;
        // returning the same cursor here would make replay loop forever.
        for (;;) {
          start = Math.max(0, end - window);
          chunk = Buffer.alloc(end - start);
          await file.read(chunk, 0, chunk.length, start);
          first = start > 0 ? chunk.indexOf(10) + 1 : 0;
          if (!start || (first > 0 && first < chunk.length)) break;
          if (window >= CHUNK * MAX_SCAN)
            this.lookbackFailure('Transcript record exceeds read bound');
          window *= 2;
        }
        const rows: { start: number; line: Buffer }[] = [];
        let at = first;
        let newline: number;
        while ((newline = chunk.indexOf(10, at)) >= 0) {
          rows.push({ start: start + at, line: chunk.subarray(at, newline) });
          at = newline + 1;
        }
        // Normalize this bounded window forward before selecting the latest records backward.
        // Otherwise the last identical physical row would invent a newer semantic revision.
        const normalized = rows.map((row) => {
          const message = this.decode(row.line, row.start, (reason) =>
            this.lookbackFailure(reason),
          ).message;
          return {
            start: row.start,
            message: message ? this.canonicalMessage(message, revisions) : undefined,
          };
        });
        // An unfinished final line is intentionally left to the next live poll.
        for (const row of normalized.reverse()) {
          const message = row.message;
          if (message && !found.has(message.sourceId)) found.set(message.sourceId, message);
          end = row.start;
          if (found.size >= this.pageSize) break;
        }
        if (found.size >= this.pageSize) break;
        end = start + first;
        if (!start) end = 0;
        if (end >= previousEnd) this.lookbackFailure('Transcript history did not advance');
      }
      return {
        messages: [...found.values()].reverse(),
        ...(end > 0 ? { next: `${this.cursorScope}:${end}` } : {}),
      };
    } finally {
      await file.close();
    }
  }
}

export async function verifyFirstRecord(
  path: string,
  accept: (record: JsonRecord) => boolean = () => true,
): Promise<JsonRecord> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    let start = 0;
    let newline: number;
    while ((newline = buffer.subarray(0, bytesRead).indexOf(10, start)) >= 0) {
      const record = recordOf(JSON.parse(buffer.subarray(start, newline).toString('utf8')));
      if (!record) throw new Error('Malformed transcript header');
      if (accept(record)) return record;
      start = newline + 1;
    }
    throw new Error('Transcript identity unavailable within bounded header');
  } finally {
    await file.close();
  }
}

export async function transcriptConnection(spec: {
  target: Target;
  transcript: Pick<Transcript, 'initialize' | 'takeInitial' | 'poll' | 'history' | 'caughtUp'>;
  capabilities: AgentCapabilities;
  options: AdapterOptions;
  status(): Promise<CodingState>;
  beforeSend?(): Promise<string | undefined>;
  dispatch: CodingConnection['send'];
}): Promise<CodingConnection> {
  const { transcript, options } = spec;
  const bridged = new Map<string, number>();
  let bridgePending: AgentEvent[] = [];
  const bridge = async (events: AgentEvent[]) => {
    if (!options.sourceSink) return;
    const queue = [...bridgePending, ...events];
    bridgePending = [];
    for (const [index, event] of queue.entries()) {
      if (event.type !== 'message' || event.message.role !== 'assistant' || !event.message.complete)
        continue;
      const prior = bridged.get(event.message.sourceId);
      if (prior !== undefined && prior >= event.message.revision) continue;
      try {
        await options.sourceSink.send({
          agent: spec.target.agent,
          sourceSessionId: spec.target.sessionRef,
          sourceId: event.message.sourceId,
          sequence: event.message.revision,
          role: 'assistant',
          text: event.message.text,
          complete: true,
          cursor: String(event.message.revision),
          ...(event.message.timestamp ? { timestamp: event.message.timestamp } : {}),
        });
        bridged.set(event.message.sourceId, event.message.revision);
      } catch {
        bridgePending = queue.slice(index);
        break;
      }
    }
  };
  await transcript.initialize();
  let detached = false;
  let watching = false;
  let lastState: CodingState | undefined;
  const stop = new AbortController();
  let serial = Promise.resolve<AgentEvent[]>([]);
  let bridgeTail = Promise.resolve();
  const enqueueBridge = (events: AgentEvent[]) => {
    bridgeTail = bridgeTail.then(() => bridge(events));
  };
  const refresh = () => {
    serial = serial.then(async () => {
      let events: AgentEvent[];
      try {
        events = await transcript.poll();
      } catch {
        lastState = 'disconnected';
        return [
          {
            type: 'gap',
            reason: 'Transcript unavailable, malformed, or changed; reattach required.',
          },
          { type: 'status', state: 'disconnected' },
        ];
      }
      try {
        const state = await spec.status();
        if (state !== lastState) {
          events.push({ type: 'status', state });
          lastState = state;
        }
      } catch {
        // Poll already consumed these native messages and receipts. Publish them even when
        // independent registry/liveness metadata is temporarily unavailable.
        lastState = 'disconnected';
        events.push(
          {
            type: 'gap',
            reason: 'Agent status temporarily unavailable; source messages retained.',
          },
          { type: 'status', state: 'disconnected' },
        );
      }
      return events;
    });
    return serial;
  };
  const pendingEvents: AgentEvent[] = [];
  return {
    target: structuredClone(spec.target),
    capabilities: spec.capabilities,
    history: (cursor) => transcript.history(cursor),
    async *events(signal) {
      if (watching) throw new Error('Only one live subscription is supported');
      watching = true;
      const abort = () => stop.abort();
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (signal.aborted || detached) return;
        // Consumers may reconcile historical delivery receipts while handling
        // replayed messages. Establish liveness first so discovery does not
        // repeatedly tear down a healthy connection during that work.
        try {
          lastState = await spec.status();
        } catch {
          lastState = 'disconnected';
        }
        if (signal.aborted || detached) return;
        yield { type: 'status', state: lastState };
        const initial = transcript.takeInitial();
        if (options.sourceSink) {
          void (async () => {
            const recovered = new Map<string, AgentMessage>();
            let cursor: string | undefined;
            do {
              const page = await transcript.history(cursor);
              for (const message of page.messages)
                if (!recovered.has(message.sourceId)) recovered.set(message.sourceId, message);
              // An optional source may retain a retryable cursor during an outage.
              // Finish this bootstrap pass; live polling will recover that source.
              if (page.next && page.next === cursor) break;
              cursor = page.next;
            } while (cursor && !stop.signal.aborted);
            if (!stop.signal.aborted)
              enqueueBridge(
                orderAgentMessages([...recovered.values()], spec.target.agent).map((message) => ({
                  type: 'message',
                  message,
                })),
              );
          })().catch(() => {});
        }
        enqueueBridge(initial);
        for (const event of initial) yield event;
        while (!stop.signal.aborted && !detached) {
          const events = [...pendingEvents.splice(0), ...(await refresh())];
          enqueueBridge(events);
          for (const event of events) {
            if (stop.signal.aborted || detached) return;
            yield event;
          }
          await (options.clock?.sleep ?? sleep)(options.pollMs ?? 750, stop.signal);
        }
      } finally {
        signal.removeEventListener('abort', abort);
        watching = false;
      }
    },
    async send(requestId, englishText, attachments, context) {
      if (
        attachments?.some((file) =>
          file.kind === 'file'
            ? !spec.capabilities.fileReferences
            : !spec.capabilities.imageAttachments && !spec.capabilities.fileReferences,
        )
      )
        return {
          state: 'failed',
          reason: 'File references are unsupported; instruction preserved',
        };
      if (detached || stop.signal.aborted)
        return { state: 'failed', reason: 'Connection detached' };
      if (!requestId.trim() || !englishText.trim() || englishText.length > 240_000)
        return { state: 'failed', reason: 'Invalid delivery payload' };
      if (spec.beforeSend) {
        try {
          const reason = await spec.beforeSend();
          if (reason) return { state: 'failed', reason };
        } catch {
          return { state: 'failed', reason: 'Send capability could not be verified' };
        }
      }
      pendingEvents.push(...(await refresh()));
      if (!transcript.caughtUp)
        return { state: 'failed', reason: 'Transcript is still syncing; instruction preserved' };
      if (
        lastState !== 'idle' &&
        !(lastState === 'working' && canSendWhileWorking(spec.capabilities, context?.transport))
      )
        return {
          state: 'failed',
          reason: 'Agent is disconnected, busy, or requires native approval',
        };
      if (detached || stop.signal.aborted)
        return { state: 'failed', reason: 'Connection detached' };
      return spec.dispatch(requestId, englishText, attachments, context);
    },
    async detach() {
      detached = true;
      stop.abort();
      pendingEvents.length = 0;
    },
  };
}
