import { recordOf, textBlocks, type JsonRecord } from '../../core/json-record.js';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createConnection } from 'node:net';
import {
  REQUEST_ID_SOURCE,
  type AgentAdapter,
  type Attachment,
  type CodingState,
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
import { randomUUID } from 'node:crypto';
import { orderAgentMessages, type AgentEvent, type AgentMessage } from '../../core/contracts.js';
import { createChannelRegistry } from './channel-registry.js';
import { createClaudeLiveness, pidExists, type Liveness } from './liveness.js';
import { ChannelStore } from './channel-store.js';
import { CHANNEL_MAX_TEXT_CHARS, type ChannelReply } from './channel-types.js';

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
  peerProtocol?: number | undefined;
  entrypoint?: string | undefined;
  startedAt?: number | undefined;
  updatedAt?: number | undefined;
  name?: unknown;
}
export function claudeActivity(status: unknown): CodingState {
  if (status === 'idle') return 'idle';
  if (status === 'approval-required' || status === 'waiting_for_approval')
    return 'approval-required';
  return 'working';
}
type ClaudeLiveness = ReturnType<typeof createClaudeLiveness>;
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
    try {
      const path = join(config, 'sessions', name);
      if ((await stat(path)).size > 65_536) continue;
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
        records.push({
          sessionId: r.sessionId,
          cwd: r.cwd,
          pid: r.pid,
          version: r.version,
          messagingSocketPath: optional(r.messagingSocketPath, 'string'),
          status: optional(r.status, 'string'),
          peerProtocol: optional(r.peerProtocol, 'number'),
          entrypoint: optional(r.entrypoint, 'string'),
          startedAt: optional(r.startedAt, 'number'),
          updatedAt: optional(r.updatedAt, 'number'),
          name: r.name,
        });
    } catch {
      /* Unreadable metadata does not establish a target. */
    }
  }
  return records;
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
      const activity = claudeActivity(record.status);
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
  if (origin?.kind !== 'channel' || origin.server !== CHANNEL_SERVER || typeof text !== 'string')
    return undefined;
  return CHANNEL_REQUEST_MARKER.exec(text)?.[1];
}
const CHANNEL_SERVER = 'language-assistant';
const CHANNEL_REQUEST_MARKER = new RegExp(
  `^<channel source="${CHANNEL_SERVER}" request_id="(${REQUEST_ID_SOURCE})"`,
);
const DELIVERY_MARKER = new RegExp(`^\\[Language Assistant delivery: (${REQUEST_ID_SOURCE})\\]\\n`);
export function parseClaudeRecord(record: JsonRecord, offset: number, sessionRef: string): Parsed {
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
  if (record.type === 'assistant' && message.stop_reason !== 'end_turn') return {};
  const peer = record.type === 'user' && origin?.kind === 'peer';
  let deliveryId = peer && typeof origin?.msg_id === 'string' ? origin.msg_id : undefined;
  if (record.isMeta && !peer) {
    const seen = record.type === 'user' ? channelRequest(origin, message.content) : undefined;
    return seen ? { channelSeen: seen } : {};
  }
  const body = message.content;
  let text = typeof body === 'string' ? body : textBlocks(body).join('\n');
  if (peer) {
    const prefix = 'Another Claude session sent a message:\n';
    const suffix = '\n\nThis came from another Claude session ';
    if (text.startsWith(prefix) && text.lastIndexOf(suffix) >= prefix.length)
      text = text.slice(prefix.length, text.lastIndexOf(suffix));
    else text = ''; // Unknown wrappers are context, never rendered as reviewed work.
    // Newer Claude versions omit origin.msg_id. Keep a per-request marker in
    // the peer payload so confirmation survives that transcript format change.
    const marker = DELIVERY_MARKER.exec(text);
    if (marker) {
      if (deliveryId && deliveryId !== marker[1]) return {};
      deliveryId = marker[1];
      text = text.slice(marker[0].length);
    }
  }
  return {
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
          content: `[Language Assistant delivery: ${requestId}]\n${claudeMessage(text, attachments)}`,
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
        options.pageSize,
      );
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
      const feed = {
        get caughtUp() {
          return transcript.caughtUp;
        },
        initialize: () => transcript.initialize(),
        takeInitial: () => [
          ...transcript.takeInitial(),
          ...pendingChannelEvents.splice(0),
          ...pollReplies(),
        ],
        async poll() {
          return [
            ...(await transcript.poll()),
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
        return claudeActivity(current.status);
      };
      const connection = await transcriptConnection({
        target,
        transcript: feed,
        options,
        status,
        capabilities: {
          history: true,
          liveMessages: true,
          attachExisting: true,
          imageAttachments: true,
          fileReferences: true,
          sendWhileBusy: false,
          channelSendWhileBusy: true,
          acknowledgement: 'accepted',
        },
        async dispatch(requestId, text, attachments = [], sendContext) {
          if (
            sendContext?.transport !== undefined &&
            !['channel', 'peer'].includes(sendContext.transport)
          )
            return { state: 'failed', reason: 'Invalid Claude transport' };
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
          if (
            !registry.messagingSocketPath ||
            (!credential && process.platform !== 'darwin' && process.platform !== 'linux')
          )
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
              nativeMessageId: requestId,
            };
          }
          return {
            state: 'unconfirmed',
            reason: 'Socket written; awaiting correlated native consumption',
            nativeMessageId: requestId,
          };
        },
      });
      connection.reconcileDelivery = async (delivery) => {
        if (
          delivery.target.agent !== target.agent ||
          delivery.target.sessionRef !== target.sessionRef ||
          delivery.target.projectId !== target.projectId
        )
          return false;
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
        let cursor: string | undefined;
        let matches = 0;
        do {
          const page = await transcript.history(cursor);
          matches += page.messages.filter(
            (message) => message.role === 'user' && message.clientId === delivery.nativeMessageId,
          ).length;
          cursor = page.next;
        } while (cursor && matches < 2);
        return matches === 1;
      };
      const detach = connection.detach.bind(connection);
      connection.detach = async () => {
        await detach();
        ownedLedger?.close();
        ownedLedger = undefined;
      };
      return connection;
    },
  };
}
