import { timingSafeEqual } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { uuid } from '../shared.js';
import { createChannelRegistry } from './channel-registry.js';
import { ChannelStore } from './channel-store.js';
import type { ChannelKey, ChannelRecord } from './channel-types.js';

type Registry = Pick<ReturnType<typeof createChannelRegistry>, 'registerChannel' | 'removeChannel'>;
export interface ClaudeChannelOptions {
  /** Trusted process configuration only; never sourced from HTTP or model input. */
  stateDir?: string;
  registryFactory?: (context: { port: number; stateDir: string }) => Registry;
}
const MAX_BODY = 1_048_576;
const MAX_TEXT = 160_000;
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !value.includes('\0');
const textValue = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_TEXT;
function fields(value: unknown, names: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name))
  );
}
function validKey(value: unknown): value is ChannelKey {
  return (
    fields(value, ['panelSessionId', 'nativeSessionId', 'generation', 'requestId']) &&
    Object.values(value).every(identifier) &&
    uuid.test(value.nativeSessionId as string) &&
    uuid.test(value.generation as string)
  );
}
class HttpFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function respond(res: ServerResponse, status: number, body: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Connection: 'close',
  });
  res.end(JSON.stringify(body));
}
/** Bounded wall-clock read, including chunked bodies. Never await an unbounded stream. */
function readBody(req: IncomingMessage): Promise<unknown> {
  if (Number(req.headers['content-length']) > MAX_BODY)
    return Promise.reject(new HttpFailure(413, 'Body too large'));
  return new Promise((accept, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', data);
      req.off('end', end);
      req.off('error', aborted);
      req.off('aborted', aborted);
    };
    const fail = (error: HttpFailure) => {
      cleanup();
      req.pause();
      reject(error);
    };
    const aborted = () => fail(new HttpFailure(400, 'Incomplete body'));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) fail(new HttpFailure(413, 'Body too large'));
      else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try {
        accept(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
      } catch {
        reject(new HttpFailure(400, 'Invalid JSON'));
      }
    };
    const timer = setTimeout(() => fail(new HttpFailure(408, 'Body read timed out')), 5000);
    req.on('data', data);
    req.once('end', end);
    req.once('error', aborted);
    req.once('aborted', aborted);
  });
}

/** Experimental macOS channel. Readiness proves local initialization, not Claude
 * consent, processing or delivery. Stdio is exclusively MCP; HTTP never supplies
 * identity, credentials, filesystem paths, or permission decisions.
 */
export async function startClaudeChannel(
  options: ClaudeChannelOptions = {},
): Promise<{ close(): Promise<void> }> {
  const stateDir = resolve(options.stateDir ?? join(homedir(), '.language-assistant'));
  let registry: Registry | undefined;
  let record: ChannelRecord | undefined;
  let store: ChannelStore | undefined;
  let initialized = false;
  let closed = false;
  let port = 0;
  let closePromise: Promise<void> | undefined;
  let finishStartup!: () => void;
  const startupFinished = new Promise<void>((done) => {
    finishStartup = done;
  });
  const ready = () => !closed && initialized && !!record && !!store;
  const mcp = new Server(
    { name: 'language-assistant', version: '0.0.0' },
    {
      capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
      instructions:
        'Experimental local channel. Messages have a request_id attribute and come from the user of the Gloss app. Answer each one in your normal final message of the turn, written to the user: the app reads that message from this session and shows it to them. Do not call the reply tool for the answer; it exists only for an optional short interim status (with the request_id) while you keep working. A transport write is not proof of delivery.',
    },
  );
  mcp.oninitialized = () => {
    initialized = mcp.getClientVersion() !== undefined;
  };
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reply',
        description: 'Record the response to a request in this channel generation.',
        inputSchema: {
          type: 'object',
          properties: {
            request_id: { type: 'string', minLength: 1 },
            text: { type: 'string', maxLength: MAX_TEXT },
          },
          required: ['request_id', 'text'],
          additionalProperties: false,
        },
      },
    ],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    const fail = () => ({
      isError: true,
      content: [{ type: 'text' as const, text: 'Reply rejected.' }],
    });
    const args = request.params.arguments;
    if (
      !ready() ||
      request.params.name !== 'reply' ||
      !fields(args, ['request_id', 'text']) ||
      !identifier(args.request_id) ||
      !textValue(args.text)
    )
      return fail();
    try {
      const key = store!.lookupRequest(record!.generation, args.request_id);
      if (!key) return fail();
      const reply = store!.recordReply(key, args.text);
      if (reply.text !== args.text) return fail();
      return { content: [{ type: 'text' as const, text: 'Reply recorded.' }] };
    } catch {
      return fail();
    }
  });

  const handleHttp = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.headersDistinct.origin !== undefined) throw new HttpFailure(403, 'Origin forbidden');
      if (req.headersDistinct.host?.length !== 1 || req.headers.host !== `127.0.0.1:${port}`)
        throw new HttpFailure(403, 'Host forbidden');
      if (!record) {
        if (req.method === 'GET' && req.url === '/health') {
          respond(res, 503, { generation: null, ready: false });
          return;
        }
        throw new HttpFailure(503, 'Channel not ready');
      }
      const expected = Buffer.from(`Bearer ${record.token}`);
      const supplied = Buffer.from(req.headers.authorization ?? '');
      if (
        req.headersDistinct.authorization?.length !== 1 ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        throw new HttpFailure(401, 'Unauthorized');
      if (req.method === 'GET' && req.url === '/health') {
        respond(res, 200, { generation: record.generation, ready: ready() });
        return;
      }
      if (req.method !== 'POST' || req.url !== '/messages') throw new HttpFailure(404, 'Not found');
      if (!ready()) throw new HttpFailure(503, 'Channel not ready');
      if (
        !/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] ?? '') ||
        req.headers['content-encoding'] !== undefined
      )
        throw new HttpFailure(400, 'Invalid content type or encoding');
      const body = await readBody(req);
      if (!fields(body, ['key', 'text']) || !validKey(body.key) || !textValue(body.text))
        throw new HttpFailure(400, 'Invalid message');
      if (
        body.key.generation !== record.generation ||
        body.key.nativeSessionId !== record.target.sessionRef
      )
        throw new HttpFailure(409, 'Channel identity conflict');
      // EOF/shutdown can occur while the body is being read. Recheck immediately
      // before the synchronous durable claim; no await separates these operations.
      if (!ready()) throw new HttpFailure(503, 'Channel not ready');
      const claim = store!.claim(body.key, body.text);
      if (claim === 'conflict') throw new HttpFailure(409, 'Request conflict');
      if (claim === 'existing') {
        respond(res, 200, { status: 'already-claimed' });
        return;
      }
      // A failure after claim deliberately leaves a pending durable request. A
      // retry must never re-emit an event whose write outcome is uncertain.
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: { content: body.text, meta: { request_id: body.key.requestId } },
      });
      respond(res, 202, { status: 'written' });
    } catch (error) {
      respond(res, error instanceof HttpFailure ? error.status : 503, {
        error: error instanceof HttpFailure ? error.message : 'Channel unavailable',
      });
    }
  };
  const http = createServer((req, res) => {
    void handleHttp(req, res);
  });
  http.headersTimeout = 5000;
  http.requestTimeout = 5000;

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
    // Close the listener now, even if the registry is still checking identity.
    const httpClosed = new Promise<void>((done) => http.close(() => done()));
    http.closeAllConnections();
    // Defer cleanup until the promise is assigned: mcp.close synchronously fires
    // onclose, which can re-enter this function.
    closePromise = Promise.resolve().then(async () => {
      process.stdin.off('end', shutdown);
      process.stdin.off('error', shutdown);
      process.stdout.off('error', shutdown);
      await mcp.close();
      await startupFinished;
      try {
        if (record) await registry!.removeChannel(record.generation);
      } finally {
        store?.close();
        await httpClosed;
      }
    });
    return closePromise;
  }
  function shutdown() {
    void close().catch(() => {
      process.stderr.write('Claude channel shutdown failed\n');
    });
  }
  mcp.onclose = shutdown;
  mcp.onerror = shutdown;
  try {
    await new Promise<void>((accept, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => {
        http.off('error', reject);
        accept();
      });
    });
    port = (http.address() as { port: number }).port;
    http.on('error', shutdown);
    process.stdin.once('end', shutdown);
    process.stdin.once('error', shutdown);
    process.stdout.once('error', shutdown);
    if (process.stdin.readableEnded || process.stdin.destroyed) throw new Error('Stdio closed');
    registry =
      options.registryFactory?.({ port, stateDir }) ??
      createChannelRegistry({ registryDir: join(stateDir, 'claude-channels'), port });
    await mcp.connect(new StdioServerTransport());
    record = await registry.registerChannel(port);
    if (closed) throw new Error('Stdio closed during registration');
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const info = await lstat(stateDir);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o777) !== 0o700 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error('Unsafe channel state directory');
    if (closed) throw new Error('Stdio closed during startup');
    store = new ChannelStore(join(stateDir, 'claude-channel-ledger.db'));
    store.registerGeneration(record.generation, record.target);
    finishStartup();
    return { close };
  } catch {
    finishStartup();
    await close();
    throw new Error('Claude channel startup failed; disconnected');
  }
}
