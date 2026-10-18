import { recordOf, textBlocks, type JsonRecord } from '../../core/json-record.js';
import { parseClaudeActivity } from './activity.js';
import { validateBackgroundOutputPath } from './background-output.js';
import { findSubagentFile, streamSubagent, subagentsDir } from './subagents.js';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import {
  REQUEST_ID_SOURCE,
  isAwaitingEvidence,
  isDeliveryTransport,
  type AgentAdapter,
  type Attachment,
  type CodingState,
  type Delivery,
  type DeliveryRoute,
  type SendContext,
  type Target,
} from '../../core/contracts.js';
import { attachmentManifest, isFileReference } from '../../core/file-references.js';
import type { OpenSessionScan } from '../../core/session-catalog.js';
import {
  claudeConfigDir,
  projectIdentity,
  Transcript,
  transcriptConnection,
  validateTarget,
  verifyFirstRecord,
  type AdapterOptions,
  type Parsed,
} from '../shared.js';
import { collectProcess, runProcess } from '../../runtime/process-runner.js';
import { normalizeSessionTitle } from '../../core/session-title.js';
import { createHash, randomUUID } from 'node:crypto';
import { orderAgentMessages, type AgentEvent, type AgentMessage } from '../../core/contracts.js';
import { claudeActivity } from './coding-state.js';
import { createChannelRegistry } from './channel-registry.js';
import { createClaudeLiveness, pidExists, type Liveness } from './liveness.js';
import { ChannelStore } from './channel-store.js';
import { isChannelServer } from './channel-names.js';
import { CHANNEL_MAX_TEXT_CHARS, type ChannelReply } from './channel-types.js';
import { SESSION_GONE_REASON, selectClaudeRoute } from './route.js';
import {
  NO_TYPING_RECORD_REASON,
  SESSION_SWITCHED_REASON,
  TERMINAL_GONE_REASON,
  TMUX_CONFIRM_POLL_MS,
  TMUX_CONFIRM_TIMEOUT_MS,
  TMUX_UNCONFIRMED_REASON,
  assignTypedMessages,
  createTypingQueue,
  sameTypedText,
  typeIntoTerminal,
  typedMessagesAfter,
  type GlossTerminal,
  type TypedSend,
} from './tmux-delivery.js';

/** A typed delivery's evidence names the transcript record that showed it. */
const TYPED_EVIDENCE_PREFIX = 'transcript:';
/** A message this adapter typed into a session, and the transcript record that confirmed it once one did. */
interface TypedInFlight {
  send: TypedSend;
  sourceId?: string | undefined;
}
/**
 * Messages typed into one session, including pastes whose outcome is uncertain. The workflow's `earlier` is a
 * snapshot taken when a send is claimed, so it can miss a send typed just before; this keeps identical texts
 * confirming in typing order. Kept while any terminal send to the session is in progress (queued for its typing turn,
 * typing, or waiting for confirmation) and for a grace period after the last one returns.
 */
interface SessionTyping {
  typed: Map<string, TypedInFlight>;
  /** Terminal sends to the session that have not returned yet. */
  inProgress: number;
  /** When the last of them returned, in epoch milliseconds. */
  idleSince: number;
}
/**
 * How long a session's typing memory outlives its last terminal send, in milliseconds. It only has to bridge the
 * moment between a later send's claim (its snapshot) and its arrival at the adapter; generous on purpose.
 */
const TYPED_MEMORY_GRACE_MS = 30_000;

/** Known local versions, retained for diagnostics; version is not a compatibility gate. */
export const CLAUDE_PROTOCOL = {
  versions: ['2.1.273', '2.1.280', '2.1.284'],
  peerProtocol: 1,
  experimental: true,
} as const;
export type ClaudeProtocolVersion = string;
export function supportsClaudeProtocol(version: unknown): version is ClaudeProtocolVersion {
  return typeof version === 'string' && version.trim().length > 0;
}
interface Registry {
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
}
export { claudeActivity } from './coding-state.js';
type ClaudeLiveness = ReturnType<typeof createClaudeLiveness>;
/** Bounded memory of background output files named in the transcript. */
const MAX_REMEMBERED_OUTPUTS = 200;

function claudeLiveness(options: ClaudeAdapterOptions): ClaudeLiveness {
  return createClaudeLiveness({
    ...(options.runner ? { runner: options.runner } : {}),
    processExists: options.processExists ?? (options.runner ? () => true : pidExists),
  });
}
/** A native Claude binary is named after its version; the npm package runs as `claude.exe`. Older terminals may have no messaging socket. */
async function liveClaude(
  record: Registry,
  liveness: ClaudeLiveness,
  runner: ClaudeAdapterOptions['runner'],
): Promise<Liveness> {
  const { messagingSocketPath } = record;
  if (messagingSocketPath) return liveness.check({ ...record, messagingSocketPath });
  return (await psOwnsPid(record, runner)) ? 'alive' : 'not-alive';
}
async function psOwnsPid(
  record: Registry,
  runner: ClaudeAdapterOptions['runner'],
): Promise<boolean> {
  const names = ['claude', 'claude.exe', record.version];
  if (process.platform !== 'darwin') return false;
  const result = await collectProcess(
    (runner ?? runProcess)(
      '/bin/ps',
      ['-o', 'comm=', '-p', String(record.pid)],
      '',
      new AbortController().signal,
      { timeoutMs: 3000, maxOutputBytes: 4096 },
    ),
  );
  return (
    result.outcome.reason === 'exited' &&
    result.outcome.code === 0 &&
    result.lines.some((line) => names.includes(basename(line.trim())))
  );
}
/** A session's messaging socket can be written: with own-child credentials, or directly on a Unix platform. */
function canWritePeerSocket(hasCredentials: boolean): boolean {
  return hasCredentials || process.platform === 'darwin' || process.platform === 'linux';
}
export interface ClaudeCredentials {
  sessionRef: string;
  projectId: string;
  socketPath: string;
  token: string;
  version: ClaudeProtocolVersion;
  peerProtocol: 1;
}
export interface ClaudeAdapterOptions extends AdapterOptions {
  /** Trusted host configuration only; never accepted from a browser action. */
  stateDir?: string;
  channelRegistry?: Pick<ReturnType<typeof createChannelRegistry>, 'resolveChannel'>;
  /** Borrowed ledger reader; its lifecycle belongs to the injecting host. */
  channelLedger?: () => Pick<ChannelStore, 'replies' | 'readReply'> | undefined;
  configDir?: string;
  executable?: string;
  /** Exact SessionStart hook pointer; default enumerates only native transcript filenames. */
  transcriptPath?: (target: Target) => Promise<string>;
  /** Own-child credentials, supplied by trusted server bootstrap; never a browser API. */
  credentials?: (target: Target) => Promise<ClaudeCredentials | undefined>;
  /** Trusted server hook: the tmux pane Gloss launched this session in, while it lives. Never from a browser. */
  glossTerminal?: (sessionRef: string) => Promise<GlossTerminal | undefined>;
  /**
   * Pre-check before the socket-owner probe; only "gone" is decided here. Defaults to
   * `kill(pid, 0)`, or to "exists" when `runner` is injected, because an injected
   * runner stands in for the whole process table.
   */
  processExists?: (pid: number) => boolean;
}
function optional(value: unknown, type: 'string'): string | undefined;
function optional(value: unknown, type: 'number'): number | undefined;
function optional(value: unknown, type: 'string' | 'number') {
  return typeof value === type ? value : undefined;
}
/** One `sessions/*.json` record; undefined when it is missing, too large or malformed. */
async function readRegistry(path: string): Promise<Registry | undefined> {
  try {
    if ((await stat(path)).size > 65_536) return undefined;
    const r = recordOf(JSON.parse(await readFile(path, 'utf8')));
    if (
      typeof r?.sessionId === 'string' &&
      typeof r.cwd === 'string' &&
      typeof r.pid === 'number' &&
      Number.isInteger(r.pid) &&
      r.pid > 0 &&
      typeof r.version === 'string' &&
      // Preserve legacy missing fields without turning malformed values into discovery fallbacks.
      (!('entrypoint' in r) || typeof r.entrypoint === 'string') &&
      (!('messagingSocketPath' in r) || typeof r.messagingSocketPath === 'string')
    )
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
      };
  } catch {
    /* Unreadable metadata does not establish a target. */
  }
  return undefined;
}
async function registries(config: string): Promise<Registry[]> {
  let names: string[];
  try {
    names = await readdir(join(config, 'sessions'));
  } catch {
    return [];
  }
  if (names.length > 10_000) throw new Error('Session metadata enumeration exceeds bound');
  const records: Registry[] = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const record = await readRegistry(join(config, 'sessions', name));
    if (record) records.push(record);
  }
  return records;
}
/**
 * Whether the process `pid` runs session `sessionRef` now, by Claude's own record for it, `sessions/<pid>.json`.
 * `/resume` and `/clear` switch sessions inside the same process: the pid stays and the record names the new session.
 */
async function pidRunsSession(config: string, pid: number, sessionRef: string): Promise<boolean> {
  const record = await readRegistry(join(config, 'sessions', `${pid}.json`));
  return record?.pid === pid && record.sessionId === sessionRef;
}
async function locateTranscript(config: string, id: string): Promise<string> {
  const root = join(config, 'projects');
  const dirs = await readdir(root, { withFileTypes: true });
  if (dirs.length > 10_000) throw new Error('Project metadata enumeration exceeds bound');
  const candidates: string[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const path = join(root, dir.name, `${id}.jsonl`);
    try {
      if ((await stat(path)).isFile()) candidates.push(path);
    } catch {
      /* filename absent */
    }
  }
  if (candidates.length !== 1) throw new Error('Exact transcript pointer unavailable or ambiguous');
  return candidates[0]!;
}
export async function discoverOpenClaude(
  options: ClaudeAdapterOptions,
  signal: AbortSignal,
  liveness: ClaudeLiveness = claudeLiveness(options),
): Promise<OpenSessionScan> {
  if (signal.aborted)
    return { candidates: [], complete: false, error: 'Claude discovery cancelled' };
  const config = claudeConfigDir(options.configDir);
  let records: Registry[];
  try {
    records = await registries(config);
  } catch {
    return { candidates: [], complete: false, error: 'Claude session metadata unavailable' };
  }
  const result: OpenSessionScan = { candidates: [], complete: true };
  // Language workers run Claude through the SDK entrypoint; only terminal sessions are destinations.
  const terminals = records.filter((r) => r.entrypoint === undefined || r.entrypoint === 'cli');
  // One batched socket-owner probe covers every terminal that has a socket.
  const socketed = terminals.flatMap((record) =>
    record.messagingSocketPath
      ? [{ record, socket: { ...record, messagingSocketPath: record.messagingSocketPath } }]
      : [],
  );
  const checked = await liveness.checkMany(socketed.map(({ socket }) => socket));
  const states = new Map(socketed.map(({ record }, i) => [record, checked[i] ?? 'failed']));
  let next = 0;
  const workers = Array.from({ length: Math.min(4, terminals.length) }, async () => {
    while (!signal.aborted) {
      const record = terminals[next++];
      if (!record) return;
      let state: Liveness;
      try {
        state = states.get(record) ?? (await liveClaude(record, liveness, options.runner));
      } catch {
        state = 'failed';
      }
      if (state === 'failed') {
        result.complete = false;
        result.error ??= 'Claude liveness verification failed';
        continue;
      }
      if (state !== 'alive' || signal.aborted) continue;
      let projectId: string;
      try {
        projectId = await projectIdentity(record.cwd);
      } catch {
        continue;
      }
      const target: Target = { agent: 'claude', sessionRef: record.sessionId, projectId };
      const activity = claudeActivity(record.status, record.waitingFor);
      const sessionTitle = normalizeSessionTitle(record.name);
      result.candidates.push({
        target,
        support: 'supported',
        activity,
        ...(sessionTitle ? { sessionTitle } : {}),
      });
    }
  });
  await Promise.all(workers);
  if (signal.aborted)
    return { candidates: [], complete: false, error: 'Claude discovery cancelled' };
  result.candidates.sort((a, b) => a.target.sessionRef.localeCompare(b.target.sessionRef));
  return result;
}
/** The agent's finished turn text is its answer; the channel's reply tool only carries optional interim status. */
/** The Gloss delivery id of a channel message, when this record is Claude reading one into its context. */
function channelRequest(value: unknown, text: unknown): string | undefined {
  const origin = recordOf(value);
  if (origin?.kind !== 'channel' || !isChannelServer(origin.server) || typeof text !== 'string')
    return undefined;
  const match = CHANNEL_REQUEST_MARKER.exec(text);
  // Both names are Gloss's own; Claude may not repeat the origin's name in the source attribute.
  return match && isChannelServer(match[1]) ? match[2] : undefined;
}
const CHANNEL_REQUEST_MARKER = new RegExp(
  `^<channel source="([^"]+)" request_id="(${REQUEST_ID_SOURCE})"`,
);
const PEER_PREFIXES = [
  'Another Claude session sent a message while you were working:',
  'A peer session sent a message while you were working:',
  'Another Claude session sent a message:',
];
const PEER_SUFFIX = '\n\nThis came from another Claude session ';
const CROSS_SESSION_TAG = /^<cross-session-message\b[^>]*>\n([\s\S]*)\n<\/cross-session-message>$/;
/** The text Gloss sent, from inside Claude's peer wrapper; undefined for a wrapper this version doesn't know. */
export function peerBody(text: string): string | undefined {
  const prefix = PEER_PREFIXES.find((candidate) => text.startsWith(candidate));
  const end = text.lastIndexOf(PEER_SUFFIX);
  if (!prefix || end < prefix.length) return undefined;
  const body = text.slice(prefix.length, end).replace(/^\n/, '');
  return CROSS_SESSION_TAG.exec(body)?.[1] ?? body;
}
/** Hex characters of the request id's SHA-256 that name one delivery inside a peer message. */
const PEER_TAG_HEX_CHARS = 8;
/** Names one delivery inside a peer message; newer Claude versions no longer record our msg_id. */
export function peerTag(requestId: string): string {
  return createHash('sha256').update(requestId).digest('hex').slice(0, PEER_TAG_HEX_CHARS);
}
const PEER_MARKER = new RegExp(
  `^\\[(?:gloss:([0-9a-f]{${PEER_TAG_HEX_CHARS}})|Language Assistant delivery: (${REQUEST_ID_SOURCE}))\\]\\n`,
);
export function parseClaudeRecord(
  record: JsonRecord,
  offset: number,
  sessionRef: string,
  depth = 0,
): Parsed {
  if (record.sessionId !== undefined && record.sessionId !== sessionRef)
    throw new Error('Transcript identity mismatch');
  // A channel message that arrives during a running turn is queued into it as an attachment.
  if (record.type === 'attachment') {
    const attachment = recordOf(record.attachment);
    const seen =
      attachment?.type === 'queued_command'
        ? channelRequest(attachment.origin, attachment.prompt)
        : undefined;
    return seen ? { channelSeen: seen } : {};
  }
  if (record.type !== 'user' && record.type !== 'assistant') return {};
  const message = recordOf(record.message);
  const origin = recordOf(record.origin);
  if (record.sessionId !== sessionRef || typeof record.uuid !== 'string' || !message)
    throw new Error('Malformed Claude message');
  const activity = parseClaudeActivity(record, offset, depth);
  const carried = activity.length ? { activity } : {};
  if (record.type === 'assistant' && message.stop_reason !== 'end_turn') return carried;
  const peer = record.type === 'user' && origin?.kind === 'peer';
  let deliveryId = peer && typeof origin?.msg_id === 'string' ? origin.msg_id : undefined;
  if (record.isMeta && !peer) {
    const seen = record.type === 'user' ? channelRequest(origin, message.content) : undefined;
    return seen ? { ...carried, channelSeen: seen } : carried;
  }
  const body = message.content;
  let text = typeof body === 'string' ? body : textBlocks(body).join('\n');
  if (peer) {
    const inner = peerBody(text);
    // Unknown wrappers are context, never rendered as reviewed work.
    text = inner ?? '';
    const marker = PEER_MARKER.exec(text);
    const markerId = marker?.[1] ?? marker?.[2];
    if (marker && markerId) {
      // Older Claude versions also record our msg_id (the full request id); it must name the same delivery.
      if (deliveryId && deliveryId !== markerId && peerTag(deliveryId) !== markerId) return carried;
      deliveryId = markerId;
      text = text.slice(marker[0].length);
    }
  }
  return {
    ...carried,
    ...(text
      ? {
          message: {
            ...(deliveryId ? { clientId: deliveryId } : {}),
            sourceId: record.uuid,
            revision: offset + 1,
            role: record.type,
            text,
            complete: record.type === 'user' || message.stop_reason === 'end_turn',
            ...(typeof record.timestamp === 'string' ? { timestamp: record.timestamp } : {}),
          },
        }
      : {}),
    ...(deliveryId ? { delivery: deliveryId } : {}),
  };
}
/**
 * What can confirm a message typed into Gloss's terminal: the user records the conversation shows, and, from Claude
 * 2.1.302 (tests/fixtures/tmux-screens/claude-queued-tool-2.1.302.jsonl), a prompt a person typed while Claude ran a
 * tool call. Claude folds that prompt into the running turn as a `queued_command` attachment and writes no user
 * record for it. Only terminal confirmation reads this; the conversation view reads `parseClaudeRecord`.
 */
export function parseTypedEvidence(record: JsonRecord, offset: number, sessionRef: string): Parsed {
  const parsed = parseClaudeRecord(record, offset, sessionRef);
  if (record.type !== 'attachment' || parsed.channelSeen) return parsed;
  const attachment = recordOf(record.attachment);
  const prompt = attachment?.prompt;
  if (
    attachment?.type !== 'queued_command' ||
    recordOf(attachment.origin)?.kind !== 'human' ||
    typeof prompt !== 'string' ||
    // A channel message's wrapper is never a person's typing, whatever origin the record names.
    CHANNEL_REQUEST_MARKER.test(prompt) ||
    record.sessionId !== sessionRef ||
    typeof record.uuid !== 'string'
  )
    return parsed;
  return {
    message: {
      sourceId: record.uuid,
      revision: offset + 1,
      role: 'user',
      text: prompt,
      complete: true,
      ...(typeof record.timestamp === 'string' ? { timestamp: record.timestamp } : {}),
    },
  };
}
export function claudeMessage(text: string, attachments: Attachment[] = []): string {
  if (!attachments.length) return text;
  if (attachments.every(isFileReference)) return `${text}\n\n${attachmentManifest(attachments)}`;
  return `${text}\n\nAttached image reference files (open each with the image viewing tool before answering):\n${attachments.map((image) => `${'index' in image && image.index ? `Image ${image.index}: ` : ''}${JSON.stringify(image.path)}`).join('\n')}`;
}
async function socketWrite(
  credentials: Pick<ClaudeCredentials, 'socketPath' | 'sessionRef'> & { token?: string },
  requestId: string,
  text: string,
  attachments: Attachment[] = [],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(credentials.socketPath);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      error ? reject(error) : resolve();
    };
    const timeout = setTimeout(() => finish(new Error('Inbox transport timed out')), 3000);
    socket.once('error', () => finish(new Error('Inbox transport unavailable')));
    socket.once('connect', () => {
      const auth = credentials.token
        ? JSON.stringify({ type: 'auth', token: credentials.token }) + '\n'
        : '';
      const message = JSON.stringify({
        msgV: 1,
        msg_id: requestId,
        type: 'user',
        message: {
          role: 'user',
          content: `[gloss:${peerTag(requestId)}]\n${claudeMessage(text, attachments)}`,
        },
        priority: 'next',
        session_id: credentials.sessionRef,
      });
      socket.write(`${auth}${message}\n`, (error) => finish(error ?? undefined));
    });
  });
}
export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): AgentAdapter {
  const config = claudeConfigDir(options.configDir);
  const liveness = claudeLiveness(options);
  /** Shared by every connection to a session, so two sends never type into the same pane at once. */
  const typeInTurn = createTypingQueue();
  const typingBySession = new Map<string, SessionTyping>();
  const now = () => options.clock?.now?.() ?? Date.now();
  /** The session's typing memory, dropping any session idle past the grace period. */
  const typingMemory = (sessionRef: string): SessionTyping | undefined => {
    for (const [ref, session] of typingBySession)
      if (!session.inProgress && now() - session.idleSince > TYPED_MEMORY_GRACE_MS)
        typingBySession.delete(ref);
    return typingBySession.get(sessionRef);
  };
  async function exact(target: Target): Promise<Registry> {
    validateTarget(target, 'claude');
    const project = await projectIdentity(target.projectId);
    const matches = (await registries(config)).filter((r) => r.sessionId === target.sessionRef);
    const projectMatches: Registry[] = [];
    for (const record of matches) {
      try {
        if ((await projectIdentity(record.cwd)) === project) projectMatches.push(record);
      } catch {
        /* missing project */
      }
    }
    if (!projectMatches.length) throw new Error('Session project identity mismatch');
    if (projectMatches.length === 1) return projectMatches[0]!;
    const ranked = await Promise.all(
      projectMatches.map(async (record, index) => ({
        record,
        index,
        live: await liveClaude(record, liveness, options.runner).then(
          (state) => state === 'alive',
          () => false,
        ),
      })),
    );
    ranked.sort(
      (a, b) =>
        Number(b.live) - Number(a.live) ||
        (b.record.updatedAt ?? b.record.startedAt ?? 0) -
          (a.record.updatedAt ?? a.record.startedAt ?? 0) ||
        b.record.pid - a.record.pid ||
        a.index - b.index,
    );
    return ranked[0]!.record;
  }
  return {
    kind: 'claude',
    discoverOpen: (signal) => discoverOpenClaude(options, signal, liveness),
    async discover(projectPath) {
      const project = await projectIdentity(projectPath);
      const targets: Target[] = [];
      for (const r of await registries(config)) {
        try {
          if ((await projectIdentity(r.cwd)) === project)
            targets.push({ agent: 'claude', sessionRef: r.sessionId, projectId: project });
        } catch {
          /* missing project */
        }
      }
      return targets;
    },
    async attach(target, context) {
      const registry = await exact(target);
      const path = options.transcriptPath
        ? await options.transcriptPath(target)
        : await locateTranscript(config, target.sessionRef);
      const first = await verifyFirstRecord(path, (record) => {
        if (record.sessionId !== undefined && record.sessionId !== target.sessionRef)
          throw new Error('Transcript identity mismatch');
        return record.sessionId === target.sessionRef && typeof record.cwd === 'string';
      });
      if (
        first.sessionId !== target.sessionRef ||
        typeof first.cwd !== 'string' ||
        (await projectIdentity(first.cwd)) !== (await projectIdentity(target.projectId))
      )
        throw new Error('Transcript identity mismatch');
      const transcript = new Transcript(
        path,
        (record, offset) => parseClaudeRecord(record, offset, target.sessionRef),
        {
          ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
          activityLookback: true,
        },
      );
      /** Reads the transcript for terminal confirmation only, where a queued prompt also counts. */
      const parseTyped = (record: JsonRecord, offset: number) =>
        parseTypedEvidence(record, offset, target.sessionRef);
      const stateDir = options.stateDir ?? join(homedir(), '.language-assistant');
      const channelRegistry =
        options.channelRegistry ??
        createChannelRegistry({
          configDir: config,
          registryDir: join(stateDir, 'claude-channels'),
        });
      let ownedLedger: ChannelStore | undefined;
      const ledger = () => {
        if (!context?.panelSessionId) return undefined;
        if (options.channelLedger) return options.channelLedger();
        const ledgerPath = join(stateDir, 'claude-channel-ledger.db');
        if (!ownedLedger) {
          try {
            ownedLedger = new ChannelStore(ledgerPath, { readOnly: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        return ownedLedger;
      };
      const message = (reply: ChannelReply): AgentMessage => ({
        sourceId: `channel:${reply.key.generation}:${reply.key.requestId}`,
        revision: reply.sequence,
        role: 'assistant',
        text: reply.text,
        complete: true,
        timestamp: reply.timestamp,
      });
      let afterSequence = 0;
      let channelUnavailable = false;
      const pendingChannelEvents: AgentEvent[] = [];
      const channelGap = (): AgentEvent[] => {
        if (channelUnavailable) return [];
        channelUnavailable = true;
        return [
          {
            type: 'gap',
            reason: 'Channel replies temporarily unavailable; will retry without resending.',
          },
        ];
      };
      const pollReplies = (): AgentEvent[] => {
        try {
          const replies =
            ledger()?.replies(target, afterSequence, 100, context!.panelSessionId) ?? [];
          const events = replies.flatMap(
            (reply) =>
              [
                { type: 'message', message: message(reply) },
                { type: 'delivery', requestId: reply.key.requestId, state: 'sent' },
              ] as AgentEvent[],
          );
          if (replies.length) afterSequence = replies.at(-1)!.sequence;
          channelUnavailable = false;
          return events;
        } catch {
          // Native polling has already advanced. Preserve those events and retry
          // only the channel cursor; do not disconnect the native subscription.
          return channelGap();
        }
      };
      const cursorScope = randomUUID();
      type Cursor = {
        scope: string;
        native?: string;
        nativeDone: boolean;
        after: number;
        channelDone: boolean;
      };
      // Background output paths come only from the transcript, keyed by the starting tool_use id.
      const outputs = new Map<string, { taskId: string; outputPath: string }>();
      const rememberOutputs = (events: AgentEvent[]) => {
        for (const event of events) {
          if (event.type !== 'activity' || event.event.kind !== 'task-output') continue;
          const { id, taskId, outputPath } = event.event;
          outputs.delete(id);
          outputs.set(id, { taskId, outputPath });
          if (outputs.size > MAX_REMEMBERED_OUTPUTS) outputs.delete(outputs.keys().next().value!);
        }
        return events;
      };
      const feed = {
        get caughtUp() {
          return transcript.caughtUp;
        },
        initialize: () => transcript.initialize(),
        takeInitial: () => [
          ...rememberOutputs(transcript.takeInitial()),
          ...pendingChannelEvents.splice(0),
          ...pollReplies(),
        ],
        async poll() {
          return [
            ...rememberOutputs(await transcript.poll()),
            ...pendingChannelEvents.splice(0),
            ...pollReplies(),
          ];
        },
        async history(cursor?: string) {
          let position: Cursor = {
            scope: cursorScope,
            nativeDone: false,
            after: 0,
            channelDone: false,
          };
          if (cursor !== undefined) {
            try {
              position = JSON.parse(cursor);
            } catch {
              throw new Error('Invalid history cursor');
            }
            if (
              !position ||
              position.scope !== cursorScope ||
              typeof position.nativeDone !== 'boolean' ||
              typeof position.channelDone !== 'boolean' ||
              !Number.isSafeInteger(position.after) ||
              position.after < 0 ||
              (position.native !== undefined && typeof position.native !== 'string')
            )
              throw new Error('Invalid history cursor');
          }
          const native = position.nativeDone
            ? { messages: [] }
            : await transcript.history(position.native);
          let replies: ChannelReply[] = [];
          let channelFailed = false;
          try {
            if (!position.channelDone)
              replies =
                ledger()?.replies(
                  target,
                  position.after,
                  options.pageSize ?? 100,
                  context!.panelSessionId,
                ) ?? [];
          } catch {
            channelFailed = true;
            pendingChannelEvents.push(...channelGap());
          }
          const next: Cursor = {
            scope: cursorScope,
            ...(native.next ? { native: native.next } : {}),
            nativeDone: !native.next,
            after: replies.at(-1)?.sequence ?? position.after,
            channelDone:
              position.channelDone ||
              (!channelFailed && replies.length < Math.min(options.pageSize ?? 100, 100)),
          };
          return {
            messages: orderAgentMessages([...native.messages, ...replies.map(message)], 'claude'),
            ...(!next.nativeDone || !next.channelDone ? { next: JSON.stringify(next) } : {}),
          };
        },
      };
      /** Claude's record for the pane's process still names this session; `/resume` and `/clear` keep the pid. */
      const paneRunsSession = (terminal: GlossTerminal) =>
        pidRunsSession(config, terminal.panePid, target.sessionRef);
      /** Gloss's own pane for this session, and whether the process in it still runs this session. */
      const glossPane = async (current: Registry) => {
        const terminal = await options.glossTerminal?.(target.sessionRef).catch(() => undefined);
        if (!terminal) return undefined;
        return {
          terminal,
          runsSession: terminal.panePid === current.pid && (await paneRunsSession(terminal)),
        };
      };
      const typedSend = (delivery: Delivery): TypedSend | undefined =>
        delivery.transport === 'tmux' && delivery.nativeAfterRevision !== undefined
          ? {
              id: delivery.id,
              body: claudeMessage(delivery.englishText, delivery.attachments),
              after: delivery.nativeAfterRevision,
            }
          : undefined;
      /**
       * Other typed sends known for this session: the workflow's snapshot first (claimed before `send`), then this
       * adapter's memory in typing order. `precedes` marks the ones typed before `send`, which take records first.
       */
      const otherTyped = (send: TypedSend, earlier: readonly Delivery[]) => {
        const entries = new Map<string, TypedInFlight & { awaiting: boolean; precedes: boolean }>();
        for (const delivery of earlier) {
          const typed = typedSend(delivery);
          if (!typed || typed.id === send.id) continue;
          const sourceId =
            delivery.state === 'sent' && delivery.nativeMessageId?.startsWith(TYPED_EVIDENCE_PREFIX)
              ? delivery.nativeMessageId.slice(TYPED_EVIDENCE_PREFIX.length)
              : undefined;
          entries.set(typed.id, {
            send: typed,
            sourceId,
            awaiting: isAwaitingEvidence(delivery),
            precedes: true,
          });
        }
        const remembered = [...(typingMemory(target.sessionRef)?.typed.values() ?? [])];
        const position = remembered.findIndex((entry) => entry.send.id === send.id);
        remembered.forEach((entry, index) => {
          if (entry.send.id === send.id) return;
          const known = entries.get(entry.send.id);
          // The snapshot decides for a delivery it describes; memory only adds a confirmation it has not seen yet.
          if (known) {
            if (!known.sourceId && entry.sourceId)
              entries.set(entry.send.id, { ...known, sourceId: entry.sourceId, awaiting: false });
            return;
          }
          // Without `send` in memory (it settled earlier), only a strictly earlier paste can come before it.
          const precedes = position >= 0 ? index < position : entry.send.after < send.after;
          entries.set(entry.send.id, { ...entry, awaiting: !entry.sourceId, precedes });
        });
        return [...entries.values()];
      };
      /** The transcript record confirming `send`: earlier identical sends still pending take records first. */
      const confirmTyped = async (
        send: TypedSend,
        earlier: readonly Delivery[],
      ): Promise<string | undefined> => {
        const identical = otherTyped(send, earlier).filter((entry) =>
          sameTypedText(entry.send.body, send.body),
        );
        const taken = new Set(identical.flatMap(({ sourceId }) => (sourceId ? [sourceId] : [])));
        const sends = [
          ...identical
            .filter((entry) => entry.precedes && entry.awaiting)
            .map((entry) => entry.send),
          send,
        ];
        const messages = await typedMessagesAfter(
          (cursor) => transcript.history(cursor, parseTyped),
          Math.min(...sends.map((item) => item.after)),
        );
        return assignTypedMessages(sends, messages, taken).get(send.id);
      };
      /** Keeps the session's memory while this send is in progress, from before it queues for its turn until it returns. */
      const beginTerminalSend = (): SessionTyping => {
        const session = typingMemory(target.sessionRef) ?? {
          typed: new Map(),
          inProgress: 0,
          idleSince: 0,
        };
        session.inProgress += 1;
        typingBySession.set(target.sessionRef, session);
        return session;
      };
      const endTerminalSend = (session: SessionTyping) => {
        session.inProgress -= 1;
        if (!session.inProgress) session.idleSince = now();
      };
      /** Ends the confirmation wait when the connection detaches. */
      const confirmationStop = new AbortController();
      const pause = (ms: number) =>
        (options.clock
          ? options.clock.sleep(ms, confirmationStop.signal)
          : delay(ms, undefined, { signal: confirmationStop.signal })
        ).catch(() => undefined);
      /**
       * Spec 2.2-2.3: type once into Gloss's pane, then wait up to 30 s for the transcript to show it. The record and
       * the screen are read inside the session's typing turn, after any earlier message's Enter; the wait is not.
       */
      const sendThroughTerminal = async (
        requestId: string,
        text: string,
        attachments: Attachment[],
        sendContext: SendContext,
      ) => {
        const { onTyping } = sendContext;
        if (!onTyping) return { state: 'failed' as const, reason: NO_TYPING_RECORD_REASON };
        const session = beginTerminalSend();
        try {
          return await typeAndConfirm(session, requestId, claudeMessage(text, attachments), {
            onTyping,
            earlier: sendContext.earlier ?? [],
          });
        } finally {
          endTerminalSend(session);
        }
      };
      const typeAndConfirm = async (
        session: SessionTyping,
        requestId: string,
        body: string,
        {
          onTyping,
          earlier,
        }: { onTyping: NonNullable<SendContext['onTyping']>; earlier: readonly Delivery[] },
      ) => {
        const typed = await typeInTurn(target.sessionRef, async () => {
          const current = await exact(target);
          const pane = await glossPane(current);
          if (!pane) return { state: 'failed' as const, reason: TERMINAL_GONE_REASON };
          if (!pane.runsSession)
            return { state: 'failed' as const, reason: SESSION_SWITCHED_REASON };
          const { terminal } = pane;
          const result = await typeIntoTerminal({
            terminal,
            requestId,
            body,
            session: current,
            paneRunsSession: () => paneRunsSession(terminal),
            transcriptSize: async () => (await stat(path)).size,
            onTyping,
            clock: { now, sleep: pause },
          });
          // Registered inside the turn, so the next send's confirmation already sees this one. An uncertain paste may
          // still reach Claude, so it keeps its place in typing order and can take its record from a later send.
          if (result.state === 'typed' || result.state === 'unconfirmed')
            session.typed.set(requestId, {
              send: { id: requestId, body, after: result.nativeAfterRevision },
            });
          return result;
        });
        if (typed.state !== 'typed') return typed;
        const send = { id: requestId, body, after: typed.nativeAfterRevision };
        const deadline = now() + TMUX_CONFIRM_TIMEOUT_MS;
        for (;;) {
          const sourceId = await confirmTyped(send, earlier).catch(() => undefined);
          if (sourceId) {
            const entry = session.typed.get(requestId);
            if (entry) entry.sourceId = sourceId;
            return {
              state: 'sent' as const,
              nativeAfterRevision: send.after,
              nativeMessageId: TYPED_EVIDENCE_PREFIX + sourceId,
            };
          }
          if (now() >= deadline || confirmationStop.signal.aborted) break;
          await pause(TMUX_CONFIRM_POLL_MS);
        }
        return {
          state: 'unconfirmed' as const,
          reason: TMUX_UNCONFIRMED_REASON,
          nativeAfterRevision: send.after,
        };
      };
      const status = async (): Promise<CodingState> => {
        const current = await exact(target);
        if (
          current.pid !== registry.pid ||
          current.messagingSocketPath !== registry.messagingSocketPath
        )
          return 'disconnected';
        const live = options.observeLive
          ? await options.observeLive(target)
          : (await liveClaude(current, liveness, options.runner)) === 'alive';
        if (!live) return 'disconnected';
        return claudeActivity(current.status, current.waitingFor);
      };
      // A send must not rely on a cached answer: the session may have closed inside the window.
      const beforeSend = async (): Promise<string | undefined> => {
        if (options.observeLive) return undefined;
        const current = await exact(target);
        const { messagingSocketPath } = current;
        if (!messagingSocketPath) return undefined;
        const state = await liveness.check({ ...current, messagingSocketPath }, { fresh: true });
        return state === 'alive'
          ? undefined
          : 'Agent is disconnected, busy, or requires native approval';
      };
      const connection = await transcriptConnection({
        target,
        transcript: feed,
        options,
        status,
        beforeSend,
        capabilities: {
          history: true,
          liveMessages: true,
          attachExisting: true,
          imageAttachments: true,
          fileReferences: true,
          sendWhileBusy: false,
          channelSendWhileBusy: true,
          peerSendWhileBusy: true,
          tmuxSendWhileBusy: true,
          acknowledgement: 'accepted',
        },
        async dispatch(requestId, text, attachments = [], sendContext) {
          if (sendContext?.transport !== undefined && !isDeliveryTransport(sendContext.transport))
            return { state: 'failed', reason: 'Invalid Claude transport' };
          if (sendContext?.transport === 'tmux')
            return sendThroughTerminal(requestId, text, attachments, sendContext);
          if (sendContext?.transport !== 'peer') {
            if (
              !context?.panelSessionId ||
              (sendContext && sendContext.panelSessionId !== context.panelSessionId)
            )
              return {
                state: 'failed',
                reason:
                  'Claude channel setup requires a matching panel session; instruction preserved',
              };
            const body = claudeMessage(text, attachments);
            if (body.length > CHANNEL_MAX_TEXT_CHARS)
              return {
                state: 'failed',
                reason: `Channel message exceeds ${CHANNEL_MAX_TEXT_CHARS} characters; instruction preserved`,
              };
            const record = await channelRegistry.resolveChannel(target).catch(() => undefined);
            if (!record)
              return {
                state: 'failed',
                reason: 'Experimental Claude channel setup required; instruction preserved',
              };
            const channelGeneration = record.generation;
            try {
              const response = await fetch(`http://127.0.0.1:${record.port}/messages`, {
                method: 'POST',
                redirect: 'error',
                signal: AbortSignal.timeout(10_000),
                headers: {
                  authorization: `Bearer ${record.token}`,
                  'content-type': 'application/json',
                },
                body: JSON.stringify({
                  key: {
                    panelSessionId: context.panelSessionId,
                    nativeSessionId: target.sessionRef,
                    generation: channelGeneration,
                    requestId,
                  },
                  text: body,
                }),
              });
              await response.body?.cancel();
              if (response.status === 202) return { state: 'queued', channelGeneration };
              return {
                state: 'unconfirmed',
                channelGeneration,
                reason: 'Channel outcome is unresolved; do not retry automatically',
              };
            } catch {
              return {
                state: 'unconfirmed',
                channelGeneration,
                reason:
                  'Channel outcome is unknown after possible claim; do not retry automatically',
              };
            }
          }
          const credential = await options.credentials?.(target);
          if (
            credential &&
            (credential.sessionRef !== target.sessionRef ||
              (await projectIdentity(credential.projectId)) !==
                (await projectIdentity(target.projectId)) ||
              credential.socketPath !== registry.messagingSocketPath ||
              !supportsClaudeProtocol(credential.version) ||
              credential.peerProtocol !== 1 ||
              !credential.token)
          )
            return {
              state: 'failed',
              reason: 'Claude session credentials do not match; instruction preserved',
            };
          if (!registry.messagingSocketPath || !canWritePeerSocket(!!credential))
            return {
              state: 'failed',
              reason: 'Claude live messaging connection unavailable; instruction preserved',
            };
          const destination = credential ?? {
            socketPath: registry.messagingSocketPath,
            sessionRef: target.sessionRef,
          };
          try {
            await socketWrite(destination, requestId, text, attachments);
          } catch {
            return {
              state: 'unconfirmed',
              reason: 'Inbox delivery outcome is unknown; do not retry automatically',
              nativeMessageId: peerTag(requestId),
            };
          }
          return {
            state: 'unconfirmed',
            reason: 'Socket written; awaiting correlated native consumption',
            nativeMessageId: peerTag(requestId),
          };
        },
      });
      connection.activity = {
        async *subagent(taskId, signal) {
          const file = await findSubagentFile(subagentsDir(path, target.sessionRef), taskId);
          if (!file) {
            yield { kind: 'gap', reason: 'Subagent transcript not found yet' };
            return;
          }
          yield* streamSubagent(file.path, target.sessionRef, file.meta.spawnDepth, signal);
        },
        async outputPath(id) {
          const output = outputs.get(id);
          const uid = process.getuid?.();
          if (!output || uid === undefined) throw new Error('Output unavailable');
          return validateBackgroundOutputPath(output.outputPath, {
            projectDirName: basename(dirname(path)),
            sessionRef: target.sessionRef,
            taskId: output.taskId,
            uid,
          });
        },
      };
      connection.reconcileDelivery = async (delivery, earlier) => {
        if (
          delivery.target.agent !== target.agent ||
          delivery.target.sessionRef !== target.sessionRef ||
          delivery.target.projectId !== target.projectId
        )
          return false;
        if (delivery.transport === 'tmux') {
          const send = typedSend(delivery);
          if (!send) return false;
          const sourceId = await confirmTyped(send, earlier ?? []);
          return sourceId ? { nativeMessageId: TYPED_EVIDENCE_PREFIX + sourceId } : false;
        }
        if (delivery.transport === 'channel') {
          if (!context?.panelSessionId) return false;
          const reader = ledger();
          if (!reader) return false;
          if (delivery.channelGeneration)
            return !!reader.readReply({
              panelSessionId: context.panelSessionId,
              nativeSessionId: target.sessionRef,
              generation: delivery.channelGeneration,
              requestId: delivery.id,
            });
          // The process may have died after claim and before returning generation metadata.
          // The ledger's panel/native/request uniqueness still supplies exact reply evidence.
          let after = 0;
          for (;;) {
            const page = reader.replies(target, after, 100, context.panelSessionId);
            if (page.some((reply) => reply.key.requestId === delivery.id)) return true;
            if (page.length < 100) return false;
            after = page.at(-1)!.sequence;
          }
        }
        if (!delivery.nativeMessageId || delivery.target.sessionRef !== target.sessionRef)
          return false;
        // Older Claude records our msg_id (the request id); newer Claude only the in-text tag.
        const ids = new Set([delivery.id, delivery.nativeMessageId]);
        let cursor: string | undefined;
        let matches = 0;
        do {
          const page = await transcript.history(cursor);
          matches += page.messages.filter(
            (message) =>
              message.role === 'user' &&
              message.clientId !== undefined &&
              ids.has(message.clientId),
          ).length;
          cursor = page.next;
        } while (cursor && matches < 2);
        return matches === 1;
      };
      connection.deliveryRoute = async (): Promise<DeliveryRoute> => {
        const current = await exact(target).catch(() => undefined);
        if (!current) return { transport: null, reason: SESSION_GONE_REASON };
        const channel = await channelRegistry.resolveChannel(target).then(
          (record) => !!record,
          () => false,
        );
        return selectClaudeRoute({
          entrypoint: current.entrypoint,
          glossTerminal: !!(await glossPane(current))?.runsSession,
          channel: channel && !!context?.panelSessionId,
          peer: !!current.messagingSocketPath && canWritePeerSocket(!!options.credentials),
        });
      };
      const detach = connection.detach.bind(connection);
      connection.detach = async () => {
        confirmationStop.abort();
        await detach();
        ownedLedger?.close();
        ownedLedger = undefined;
      };
      return connection;
    },
  };
}
