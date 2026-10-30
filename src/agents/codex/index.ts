import { recordOf, textBlocks, type JsonRecord } from '../../core/json-record.js';
import {
  codexSnapshot,
  discoverOpenCodex,
  threadLiveness,
  type CodexSnapshot,
} from './discovery.js';
import { listCodexPastSessions } from './past-sessions.js';
import type { LaunchedLiveness, ThreadLiveness } from './liveness.js';
import { attachmentManifest, isFileReference } from '../../core/file-references.js';
import { stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { AgentAdapter, CodingState, Target, Attachment } from '../../core/contracts.js';
import { collectProcess, runProcess } from '../../runtime/process-runner.js';
import { parseCodexRateLimits } from '../../core/usage.js';
import {
  codexHomeDir,
  projectIdentity,
  Transcript,
  transcriptConnection,
  uuid,
  validateTarget,
  verifyFirstRecord,
  type AdapterOptions,
  type Parsed,
} from '../shared.js';

export function codexMessage(text: string, attachments: Attachment[] = []): string {
  if (!attachments.length) return text;
  if (attachments.every(isFileReference)) return `${text}\n\n${attachmentManifest(attachments)}`;
  return legacyImageMessage(text, attachments);
}
function legacyImageMessage(text: string, attachments: Attachment[]): string {
  return `${text}\n\nAttached image reference files (open each with the image viewing tool before answering):\n${attachments.map((image) => `${image.index ? `Image ${image.index}: ` : ''}${JSON.stringify(image.path)}`).join('\n')}`;
}

/** Historical probe versions, informational only. Identity and receipt validation establish compatibility. */
export const CODEX_PROTOCOL = {
  versions: ['0.153.4', '0.154.0', '0.157.1', '0.158.0', '0.159.3'],
  experimental: true,
} as const;
export function supportsCodexProtocol(version: unknown): boolean {
  return typeof version === 'string' && version.trim().length > 0;
}
interface Thread {
  id: string;
  cwd: string;
  rollout_path: string;
  cli_version: string;
}
export interface CodexAdapterOptions extends AdapterOptions {
  codexHome?: string;
  databasePath?: string;
  executable?: string;
  /** Trusted server hook: for threads Gloss launched, whether the launch's tmux session still runs. */
  launched?: LaunchedLiveness;
  now?: () => number;
}
/** Shown when a send targets a Codex thread with no attached terminal. */
export const CODEX_CLOSED_REASON =
  'Codex session is closed: no Codex terminal is attached, so a queued message would never be processed. Resume it in a terminal first.';
/**
 * How long one writer/attachment probe round is shared by discovery and every connection
 * of one adapter, in milliseconds after it finished. Sends always probe afresh.
 */
const CODEX_LIVENESS_TTL_MS = 3000;
/** Bound on one shared probe round, so a hung `ps`/`lsof` cannot stall every caller. */
const CODEX_PROBE_TIMEOUT_MS = 10_000;
export function parseCodexRecord(record: JsonRecord, offset: number, sessionRef: string): Parsed {
  const payload = recordOf(record.payload);
  if (record.type === 'session_meta') {
    if (
      payload?.id !== sessionRef ||
      (payload.session_id !== undefined && payload.session_id !== sessionRef)
    )
      throw new Error('Transcript identity mismatch');
    return {};
  }
  if (record.type !== 'event_msg') return {};
  const p = payload;
  if (!p || typeof p.type !== 'string') throw new Error('Malformed Codex event');
  if (p.thread_id !== undefined && p.thread_id !== sessionRef)
    throw new Error('Transcript identity mismatch');
  if (p.type === 'task_started') return { state: 'working' };
  if (p.type === 'task_complete' || p.type === 'turn_aborted') return { state: 'idle' };
  if (p.type === 'token_count') {
    const usage = parseCodexRateLimits(
      p.rate_limits,
      (typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN) || Date.now(),
    );
    return usage ? { usage } : {};
  }
  if (p.type !== 'item_completed') return {};
  const item = recordOf(p.item);
  if (!item || typeof item.type !== 'string') throw new Error('Malformed Codex item');
  if (item.type !== 'UserMessage' && item.type !== 'AgentMessage') return {};
  if (item.type === 'AgentMessage' && item.phase !== 'final_answer') return {};
  if (p.thread_id !== sessionRef || typeof item.id !== 'string' || !Array.isArray(item.content))
    throw new Error('Malformed Codex message');
  const text = textBlocks(item.content, ['text', 'Text']).join('\n');
  return text
    ? {
        ...(item.type === 'UserMessage' && typeof item.client_id === 'string'
          ? { delivery: item.client_id }
          : {}),
        message: {
          ...(typeof item.client_id === 'string' ? { clientId: item.client_id } : {}),
          sourceId: item.id,
          revision: offset + 1,
          role: item.type === 'UserMessage' ? 'user' : 'assistant',
          text,
          complete: true,
          ...(typeof record.timestamp === 'string' ? { timestamp: record.timestamp } : {}),
        },
      }
    : {};
}
export function createCodexAdapter(options: CodexAdapterOptions = {}): AgentAdapter {
  const home = codexHomeDir(options.codexHome);
  const database = options.databasePath ?? join(home, 'state_5.sqlite');
  const runner = options.runner ?? runProcess;
  const now = options.now ?? Date.now;
  let shared: { value: Promise<CodexSnapshot>; settled: boolean; expiresAt: number } | undefined;
  /** `fresh` skips a finished round but joins one still running, which started moments ago. */
  const snapshot = ({ fresh = false } = {}): Promise<CodexSnapshot> => {
    if (shared && (!shared.settled || (!fresh && now() <= shared.expiresAt))) return shared.value;
    const entry = {
      value: codexSnapshot(options, AbortSignal.timeout(CODEX_PROBE_TIMEOUT_MS)),
      settled: false,
      expiresAt: -Infinity,
    };
    shared = entry;
    // Only a fully verified round is reused; anything incomplete is probed again next time.
    entry.value.then(
      (result) => {
        entry.settled = true;
        if (result.scan.complete && result.liveness)
          entry.expiresAt = now() + CODEX_LIVENESS_TTL_MS;
        else if (shared === entry) shared = undefined;
      },
      () => {
        entry.settled = true;
        if (shared === entry) shared = undefined;
      },
    );
    return entry.value;
  };
  const isOpen = async (target: Target, fresh = false) =>
    options.observeLive
      ? options.observeLive(target)
      : threadLiveness(await snapshot({ fresh })).get(target.sessionRef)?.open === true;
  function rows(id?: string): Thread[] {
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      // Metadata only: never query transcript content or an unrelated rollout.
      return (id
        ? db.prepare('SELECT id,cwd,rollout_path,cli_version FROM threads WHERE id = ?').all(id)
        : db
            .prepare('SELECT id,cwd,rollout_path,cli_version FROM threads LIMIT 10001')
            .all()) as unknown as Thread[];
    } finally {
      db.close();
    }
  }
  async function exact(target: Target): Promise<Thread> {
    validateTarget(target, 'codex');
    const found = rows(target.sessionRef);
    if (
      found.length !== 1 ||
      (await projectIdentity(found[0]!.cwd)) !== (await projectIdentity(target.projectId))
    )
      throw new Error('Session project identity mismatch');
    if (!supportsCodexProtocol(found[0]!.cli_version))
      throw new Error('Unsupported Codex local protocol version');
    return found[0]!;
  }
  return {
    kind: 'codex',
    discoverOpen: (signal, { fresh = false } = {}) =>
      discoverOpenCodex(options, signal, () => snapshot({ fresh })),
    listPast: (projectPath) => listCodexPastSessions(database, projectPath),
    async discover(projectPath) {
      const project = await projectIdentity(projectPath);
      let threads: Thread[];
      try {
        threads = rows();
      } catch {
        return [];
      }
      if (threads.length > 10_000) throw new Error('Session metadata enumeration exceeds bound');
      const targets: Target[] = [];
      for (const thread of threads) {
        if (!supportsCodexProtocol(thread.cli_version)) continue;
        try {
          if ((await projectIdentity(thread.cwd)) === project)
            targets.push({ agent: 'codex', sessionRef: thread.id, projectId: project });
        } catch {
          /* deleted project */
        }
      }
      return targets;
    },
    async attach(target) {
      const metadata = await exact(target);
      const first = await verifyFirstRecord(metadata.rollout_path);
      const header = recordOf(first.payload);
      if (
        first.type !== 'session_meta' ||
        header?.id !== target.sessionRef ||
        (header.session_id !== undefined && header.session_id !== target.sessionRef) ||
        header.cli_version !== metadata.cli_version ||
        typeof header.cwd !== 'string' ||
        (await projectIdentity(header.cwd)) !== (await projectIdentity(target.projectId))
      )
        throw new Error('Transcript identity mismatch');
      const transcript = new Transcript(
        metadata.rollout_path,
        (record, offset) => parseCodexRecord(record, offset, target.sessionRef),
        options.pageSize,
      );
      const status = async (): Promise<CodingState> => {
        const current = await exact(target);
        if (current.rollout_path !== metadata.rollout_path) return 'disconnected';
        // Open only while a Codex terminal is attached; a thread the shared app-server merely keeps loaded is closed.
        if (!(await isOpen(target).catch(() => false))) return 'disconnected';
        // A long active turn can keep appending while the initial history is still
        // being read. Verified writer ownership is enough to report working; waiting
        // for caughtUp would incorrectly mark a live session unavailable forever.
        return transcript.state === 'disconnected' ? 'working' : transcript.state;
      };
      const connection = await transcriptConnection({
        target,
        transcript,
        options,
        status,
        capabilities: {
          history: true,
          liveMessages: true,
          attachExisting: true,
          imageAttachments: true,
          fileReferences: true,
          sendWhileBusy: true,
          acknowledgement: 'queued',
        },
        async beforeSend() {
          try {
            if (!(await isOpen(target, true))) return CODEX_CLOSED_REASON;
          } catch {
            return 'Codex session liveness could not be verified';
          }
          const version = await collectProcess(
            runner(options.executable ?? 'codex', ['--version'], '', new AbortController().signal, {
              timeoutMs: 3000,
              maxOutputBytes: 4096,
            }),
          );
          return version.outcome.reason !== 'exited' ||
            version.outcome.code !== 0 ||
            !/^codex-cli \S+$/.test(version.lines.join('\n').trim())
            ? 'Installed Codex CLI identity could not be verified'
            : undefined;
        },
        async dispatch(_requestId, text, attachments = []) {
          try {
            const nativeAfterRevision = (await stat(metadata.rollout_path)).size;
            const result = await collectProcess(
              runner(
                options.executable ?? 'codex',
                [
                  'queue',
                  '--thread',
                  target.sessionRef,
                  `--message=${codexMessage(text, attachments)}`,
                ],
                '',
                new AbortController().signal,
                {
                  cwd: target.projectId,
                  env: { ...process.env, CODEX_HOME: home },
                  timeoutMs: 10_000,
                  maxOutputBytes: 16_384,
                },
              ),
            );
            const receipt = result.lines.find((line) => {
              const match = /^Queued message ([0-9a-f-]+) for thread ([0-9a-f-]+)\.$/i.exec(line);
              return match && uuid.test(match[1]!) && match[2] === target.sessionRef;
            });
            if (result.outcome.reason === 'exited' && result.outcome.code === 0 && receipt)
              return {
                state: 'queued',
                nativeAfterRevision,
                nativeMessageId: /^Queued message ([0-9a-f-]+)/i.exec(receipt)![1]!,
              };
            if (result.outcome.reason === 'spawn-error')
              return { state: 'failed', reason: 'Codex queue CLI unavailable' };
            return {
              state: 'unconfirmed',
              reason: 'No exact target queue receipt; do not retry automatically',
            };
          } catch {
            return {
              state: 'unconfirmed',
              reason: 'Queue outcome unknown; do not retry automatically',
            };
          }
        },
      });
      connection.reconcileDelivery = async (delivery) => {
        if (!delivery.nativeMessageId || delivery.target.sessionRef !== target.sessionRef)
          return false;
        let cursor: string | undefined;
        let candidates = 0;
        const expected = new Set([codexMessage(delivery.englishText, delivery.attachments)]);
        if (
          !delivery.referenceFormat &&
          delivery.attachments?.length &&
          delivery.attachments.every((file) => file.kind !== 'file')
        )
          expected.add(legacyImageMessage(delivery.englishText, delivery.attachments));
        // Older saved receipts lack a transcript boundary. Native UUIDv7 receipts
        // carry their creation time, which excludes earlier identical messages.
        const legacyReceiptTime =
          delivery.nativeAfterRevision === undefined &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            delivery.nativeMessageId,
          )
            ? parseInt(delivery.nativeMessageId.replaceAll('-', '').slice(0, 12), 16)
            : undefined;
        do {
          const page = await transcript.history(cursor);
          candidates += page.messages.filter(
            (m) =>
              m.role === 'user' &&
              (delivery.nativeAfterRevision !== undefined
                ? m.revision > delivery.nativeAfterRevision
                : legacyReceiptTime !== undefined &&
                  !!m.timestamp &&
                  Date.parse(m.timestamp) >= legacyReceiptTime) &&
              expected.has(m.text),
          ).length;
          cursor = page.next;
        } while (cursor);
        // The queue row ID and accepted UserMessage client ID are distinct in Codex.
        // A receipt plus a unique exact native acceptance after dispatch is evidence;
        // historical copies and ambiguous duplicate content are never accepted.
        return (
          (delivery.nativeAfterRevision !== undefined || legacyReceiptTime !== undefined) &&
          candidates === 1
        );
      };
      return connection;
    },
  };
}
