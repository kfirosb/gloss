import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, readFile, writeFile, access, chmod, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ChannelStore } from '../../src/agents/claude/channel-store.js';
import type { ChannelRecord } from '../../src/agents/claude/channel-types.js';
import type { AgentEvent } from '../../src/core/contracts.js';
import { join } from 'node:path';
import { createClaudeAdapter } from '../../src/agents/claude/index.js';
import {
  CLAUDE_PROTOCOL,
  supportsClaudeProtocol,
  parseClaudeRecord,
} from '../../src/agents/claude/index.js';
import type { ProcessRunner } from '../../src/runtime/process-runner.js';
import { harness, watch } from './agent-harness.js';
import { lsofPaths, lsofRunner, ownerLines } from './lsof-fixture.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

describe('Claude channel routing and feed', () => {
  it.each([
    [202, 'queued'],
    [200, 'unconfirmed'],
    [503, 'unconfirmed'],
  ] as const)(
    'distinguishes channel handoff from reply confirmation for HTTP %s',
    async (status, state) => {
      const h = await harness('claude');
      cleanups.push(h.cleanup);
      let writes = 0;
      const server = createHttpServer(async (req, res) => {
        for await (const chunk of req) {
          /* Consume the submitted message. */
        }
        writes++;
        res.writeHead(status);
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
      const generation = randomUUID();
      const c = await createClaudeAdapter({
        configDir: h.dir,
        stateDir: h.dir,
        transcriptPath: async () => h.transcript,
        observeLive: async () => true,
        channelRegistry: {
          resolveChannel: async () => ({
            schemaVersion: 1,
            target: h.target,
            transcriptPath: h.transcript,
            generation,
            port: (server.address() as { port: number }).port,
            token: 'fixture-token',
            claudePid: 1,
            claudeStartedAt: 'start',
            channelPid: 2,
            channelStartedAt: 'start',
          }),
        },
      }).attach(h.target, { panelSessionId: 'panel' });
      cleanups.push(() => c.detach());
      const receipt = await c.send('request', 'Question', [], {
        panelSessionId: 'panel',
        transport: 'channel',
      });
      expect(receipt).toMatchObject({ state, channelGeneration: generation });
      expect(
        await c.reconcileDelivery!({
          ...receipt,
          id: 'request',
          draftId: 'draft',
          revision: 1,
          target: h.target,
          englishText: 'Question',
          transport: 'channel',
        }),
      ).toBe(false);
      expect(writes).toBe(1);
    },
  );
  it.each(['initial', 'poll'] as const)(
    'retains native messages and receipts when the channel ledger fails once during %s, then retries it',
    async (phase) => {
      const h = await harness('claude');
      cleanups.push(h.cleanup);
      const ledger = new ChannelStore(join(h.dir, 'ledger.db'));
      cleanups.push(async () => ledger.close());
      const key = {
        panelSessionId: 'panel',
        nativeSessionId: h.sessionRef,
        generation: randomUUID(),
        requestId: 'channel-request',
      };
      ledger.registerGeneration(key.generation, h.target);
      ledger.claim(key, 'Question');
      const appendNative = () =>
        appendFile(
          h.transcript,
          [
            {
              type: 'assistant',
              uuid: 'native-new',
              sessionId: h.sessionRef,
              message: {
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: 'Native answer' }],
              },
            },
            {
              type: 'user',
              uuid: 'native-peer',
              sessionId: h.sessionRef,
              isMeta: true,
              origin: { kind: 'peer', msg_id: 'peer-receipt' },
              message: {
                content:
                  'Another Claude session sent a message:\nPeer question\n\nThis came from another Claude session — not typed by your user.',
              },
            },
          ]
            .map((r) => JSON.stringify(r) + '\n')
            .join(''),
        );
      let failNext = phase === 'initial';
      if (phase === 'initial') {
        await appendNative();
        ledger.recordReply(key, 'Channel answer');
      }
      const c = await createClaudeAdapter({
        configDir: h.dir,
        stateDir: h.dir,
        transcriptPath: async () => h.transcript,
        observeLive: async () => true,
        pollMs: 1,
        channelLedger: () => {
          if (phase === 'initial' && failNext) {
            failNext = false;
            throw new Error('Fixture ledger open failed');
          }
          return {
            readReply: (k) => ledger.readReply(k),
            replies: (...args) => {
              if (failNext) {
                failNext = false;
                throw new Error('Fixture ledger read failed');
              }
              return ledger.replies(...args);
            },
          };
        },
      }).attach(h.target, { panelSessionId: 'panel' });
      const abort = new AbortController();
      const events = c.events(abort.signal)[Symbol.asyncIterator]();
      const received: AgentEvent[] = [];
      const until = async (matches: (event: AgentEvent) => boolean) => {
        for (;;) {
          const next = await events.next();
          expect(next.done).not.toBe(true);
          received.push(next.value!);
          if (matches(next.value!)) return;
        }
      };
      try {
        if (phase === 'poll') {
          await until((e) => e.type === 'status' && e.state === 'idle');
          await appendNative();
          ledger.recordReply(key, 'Channel answer');
          failNext = true;
        }
        await until((e) => e.type === 'delivery' && e.requestId === 'channel-request');
        expect(
          received.filter((e) => e.type === 'message' && e.message.sourceId === 'native-new'),
        ).toHaveLength(1);
        expect(
          received.filter((e) => e.type === 'delivery' && e.requestId === 'peer-receipt'),
        ).toEqual([{ type: 'delivery', requestId: 'peer-receipt', state: 'sent' }]);
        expect(
          received.filter((e) => e.type === 'message' && e.message.sourceId.startsWith('channel:')),
        ).toHaveLength(1);
        expect(received.filter((e) => e.type === 'gap')).toEqual([
          { type: 'gap', reason: expect.stringMatching(/channel.*retry/i) },
        ]);
        expect(received.some((e) => e.type === 'status' && e.state === 'disconnected')).toBe(false);
      } finally {
        abort.abort();
        await c.detach();
        await events.return?.();
      }
    },
  );
  it('opens the default ledger read-only for history and reconciliation', async () => {
    const h = await harness('claude');
    cleanups.push(h.cleanup);
    const path = join(h.dir, 'claude-channel-ledger.db');
    const writer = new ChannelStore(path);
    const key = {
      panelSessionId: 'panel',
      nativeSessionId: h.sessionRef,
      generation: randomUUID(),
      requestId: 'request',
    };
    writer.registerGeneration(key.generation, h.target);
    writer.claim(key, 'Q');
    writer.recordReply(key, 'A');
    writer.close();
    await chmod(path, 0o400);
    const original = await readFile(path);
    const c = await createClaudeAdapter({
      configDir: h.dir,
      stateDir: h.dir,
      transcriptPath: async () => h.transcript,
      observeLive: async () => true,
    }).attach(h.target, { panelSessionId: 'panel' });
    cleanups.push(() => c.detach());
    expect(
      (await c.history()).messages.some((m) => m.sourceId === `channel:${key.generation}:request`),
    ).toBe(true);
    expect(
      await c.reconcileDelivery!({
        id: 'request',
        draftId: 'd',
        revision: 1,
        target: h.target,
        englishText: 'Q',
        state: 'unconfirmed',
        transport: 'channel',
        channelGeneration: key.generation,
      }),
    ).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o400);
    expect(await readFile(path)).toEqual(original);
  });
  it('fails with setup required by default without peer or CLI fallback and creates no ledger', async () => {
    const { h, frames } = await setup();
    const c = await createClaudeAdapter({
      configDir: h.dir,
      stateDir: join(h.dir, 'absent-state'),
      transcriptPath: async () => h.transcript,
      observeLive: async () => true,
      channelRegistry: { resolveChannel: async () => undefined },
      runner: async function* () {
        throw new Error('No CLI');
      },
    }).attach(h.target, { panelSessionId: 'panel' });
    cleanups.push(() => c.detach());
    expect(await c.send('missing', 'Hello')).toMatchObject({
      state: 'failed',
      reason: expect.stringMatching(/setup/i),
    });
    expect(frames).toEqual([]);
    await expect(access(join(h.dir, 'absent-state'))).rejects.toThrow();
  });

  it('uses verified HTTP keys, stays uncertain after possible claim, and cannot resend in a changed generation', async () => {
    const { h, frames } = await setup();
    const ledger = new ChannelStore(join(h.dir, 'ledger.db'));
    cleanups.push(async () => ledger.close());
    let generation = randomUUID();
    ledger.registerGeneration(generation, h.target);
    const bodies: any[] = [];
    let emitted = 0;
    let drop = true;
    const server = createHttpServer(async (req, res) => {
      expect(req.url).toBe('/messages');
      expect(req.headers.authorization).toBe('Bearer fixture-token');
      expect(req.headers.origin).toBeUndefined();
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      bodies.push(body);
      const claim = ledger.claim(body.key, body.text);
      if (claim === 'new') emitted++;
      if (drop) {
        drop = false;
        req.socket.destroy();
        return;
      }
      res.writeHead(claim === 'conflict' ? 409 : claim === 'new' ? 202 : 200, {
        'content-type': 'application/json',
      });
      res.end(JSON.stringify({ status: claim === 'new' ? 'written' : 'already-claimed' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;
    let resolutions = 0;
    const c = await createClaudeAdapter({
      configDir: h.dir,
      stateDir: h.dir,
      transcriptPath: async () => h.transcript,
      observeLive: async () => true,
      channelLedger: () => ledger,
      channelRegistry: {
        resolveChannel: async () => {
          resolutions++;
          return {
            schemaVersion: 1,
            target: h.target,
            transcriptPath: h.transcript,
            generation,
            port,
            token: 'fixture-token',
            claudePid: 1,
            claudeStartedAt: 'start',
            channelPid: 2,
            channelStartedAt: 'start',
          } satisfies ChannelRecord;
        },
      },
    }).attach(h.target, { panelSessionId: 'panel' });
    cleanups.push(() => c.detach());
    const context = { panelSessionId: 'panel', transport: 'channel' as const };
    const first = await c.send('request', 'Exact text', [], context);
    expect(first).toMatchObject({ state: 'unconfirmed', channelGeneration: generation });
    expect(bodies[0]).toEqual({
      key: {
        panelSessionId: 'panel',
        nativeSessionId: h.sessionRef,
        generation,
        requestId: 'request',
      },
      text: 'Exact text',
    });
    generation = randomUUID();
    ledger.registerGeneration(generation, h.target);
    expect(await c.send('request', 'Exact text', [], context)).toMatchObject({
      state: 'unconfirmed',
    });
    expect(resolutions).toBe(2);
    expect(emitted).toBe(1);
    expect(frames).toEqual([]);
  });

  it('replays scoped ledger replies once with stable IDs, composite cursors and source sink, ignoring native tool records', async () => {
    const h = await harness('claude');
    cleanups.push(h.cleanup);
    const ledger = new ChannelStore(join(h.dir, 'ledger.db'));
    cleanups.push(async () => ledger.close());
    const generation = randomUUID();
    ledger.registerGeneration(generation, h.target);
    const key = {
      panelSessionId: 'panel',
      nativeSessionId: h.sessionRef,
      generation,
      requestId: 'request',
    };
    ledger.claim(key, 'Question');
    const reply = ledger.recordReply(key, 'Answer');
    const foreign = { ...key, panelSessionId: 'other', requestId: 'foreign' };
    ledger.claim(foreign, 'Q');
    ledger.recordReply(foreign, 'Foreign');
    const otherTarget = { ...h.target, sessionRef: randomUUID() };
    const otherGeneration = randomUUID();
    ledger.registerGeneration(otherGeneration, otherTarget);
    const otherKey = {
      ...key,
      generation: otherGeneration,
      nativeSessionId: otherTarget.sessionRef,
      requestId: 'other-native',
    };
    ledger.claim(otherKey, 'Q');
    ledger.recordReply(otherKey, 'Wrong native');
    await appendFile(
      h.transcript,
      [
        {
          type: 'user',
          uuid: 'meta',
          sessionId: h.sessionRef,
          isMeta: true,
          origin: { kind: 'channel' },
          message: { content: '<channel>Question</channel>' },
        },
        {
          type: 'assistant',
          uuid: 'tool',
          sessionId: h.sessionRef,
          message: {
            stop_reason: 'tool_use',
            content: [
              {
                type: 'tool_use',
                name: 'mcp__language_assistant__reply',
                input: { request_id: 'request', text: 'Answer' },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'result',
          sessionId: h.sessionRef,
          message: { content: [{ type: 'tool_result', content: 'Reply recorded.' }] },
        },
        {
          type: 'assistant',
          uuid: 'independent',
          sessionId: h.sessionRef,
          timestamp: reply.timestamp,
          message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Answer' }] },
        },
      ]
        .map((r) => JSON.stringify(r) + '\n')
        .join(''),
    );
    const bridged: any[] = [];
    const adapter = createClaudeAdapter({
      configDir: h.dir,
      stateDir: h.dir,
      channelLedger: () => ledger,
      transcriptPath: async () => h.transcript,
      observeLive: async () => true,
      pageSize: 1,
      pollMs: 5,
      sourceSink: {
        send: async (message) => {
          bridged.push(message);
        },
      },
    });
    const c = await adapter.attach(h.target, { panelSessionId: 'panel' });
    cleanups.push(() => c.detach());
    const first = await c.history();
    expect(first.next).toBeDefined();
    const all = [...first.messages];
    let cursor = first.next;
    while (cursor) {
      const page = await c.history(cursor);
      all.push(...page.messages);
      cursor = page.next;
    }
    expect(all.filter((m) => m.sourceId.startsWith('channel:'))).toEqual([
      {
        sourceId: `channel:${generation}:request`,
        revision: reply.sequence,
        timestamp: reply.timestamp,
        role: 'assistant',
        text: 'Answer',
        complete: true,
      },
    ]);
    expect(all.filter((m) => ['meta', 'tool', 'result'].includes(m.sourceId))).toEqual([]);
    // The agent's finished turn text is its answer and is shown beside any interim channel reply.
    expect(all.find((m) => m.sourceId === 'independent')?.text).toBe('Answer');
    const other = await adapter.attach(h.target, { panelSessionId: 'other' });
    cleanups.push(() => other.detach());
    await expect(other.history(first.next)).rejects.toThrow(/cursor/i);
    const w = watch(c);
    cleanups.push(w.stop);
    await expect.poll(() => w.events.filter((e) => e.type === 'delivery')).toHaveLength(1);
    await expect
      .poll(() => bridged.filter((m) => m.sourceId.startsWith('channel:')))
      .toHaveLength(1);
    expect(w.events.filter((e) => e.type === 'delivery')).toEqual([
      { type: 'delivery', requestId: 'request', state: 'sent' },
    ]);
    expect(
      await c.reconcileDelivery!({
        id: 'request',
        draftId: 'd',
        revision: 1,
        target: h.target,
        englishText: 'Q',
        state: 'unconfirmed',
        transport: 'channel',
        channelGeneration: generation,
      }),
    ).toBe(true);
    expect(
      await c.reconcileDelivery!({
        id: 'request',
        draftId: 'd',
        revision: 1,
        target: h.target,
        englishText: 'Q',
        state: 'unconfirmed',
        transport: 'channel',
        channelGeneration: randomUUID(),
      }),
    ).toBe(false);
    // A crash can occur after the server's durable claim but before send returns metadata.
    expect(
      await c.reconcileDelivery!({
        id: 'request',
        draftId: 'd',
        revision: 1,
        target: h.target,
        englishText: 'Q',
        state: 'unconfirmed',
        transport: 'channel',
      }),
    ).toBe(true);
  });
});
async function setup(authenticated = true) {
  const h = await harness('claude');
  cleanups.push(h.cleanup);
  const frames: any[] = [];
  const socketPath = join(h.dir, 'inbox.sock');
  const server = createServer((socket) => {
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
      let end: number;
      while ((end = data.indexOf('\n')) >= 0) {
        frames.push(JSON.parse(data.slice(0, end)));
        data = data.slice(end + 1);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const credentials = {
    sessionRef: h.sessionRef,
    projectId: h.project,
    socketPath,
    token: 'private-test-token',
    version: '2.1.273' as const,
    peerProtocol: 1 as const,
  };
  const adapter = createClaudeAdapter({
    configDir: h.dir,
    transcriptPath: async () => h.transcript,
    observeLive: async () => true,
    ...(authenticated ? { credentials: async () => credentials } : {}),
    runner: async function* () {
      throw new Error('Must not launch another Claude process');
    },
    pollMs: 5,
  });
  const connection = await adapter.attach(h.target);
  cleanups.push(() => connection.detach());
  return { h, credentials, connection, frames, adapter };
}
describe('Claude native peer inbox', () => {
  it('correlates current Claude peer records without msg_id while ignoring human lookalikes', () => {
    const record = {
      type: 'user',
      uuid: 'native',
      sessionId: 'session',
      isMeta: true,
      origin: { kind: 'peer' },
      message: {
        content:
          'Another Claude session sent a message:\n[Language Assistant delivery: request-123]\nHello\n\nThis came from another Claude session — not typed by your user.',
      },
    };
    expect(parseClaudeRecord(record, 0, 'session')).toMatchObject({
      delivery: 'request-123',
      message: { clientId: 'request-123', text: 'Hello' },
    });
    expect(parseClaudeRecord({ ...record, origin: { kind: 'human' } }, 0, 'session')).toEqual({});
  });
  it('shows the finished turn text even when the turn also used the channel reply tool for interim status', () => {
    const parse = (record: object, offset: number) =>
      parseClaudeRecord({ sessionId: 'session', ...record }, offset, 'session');
    const user = (uuid: string, content: unknown, extra: object = {}) => ({
      type: 'user',
      uuid,
      message: { content },
      ...extra,
    });
    const assistant = (uuid: string, stop_reason: string, content: unknown[]) => ({
      type: 'assistant',
      uuid,
      message: { stop_reason, content },
    });
    expect(
      parse(
        user('channel', '<channel>Question</channel>', {
          isMeta: true,
          origin: { kind: 'channel' },
        }),
        0,
      ),
    ).toEqual({});
    expect(
      parse(
        assistant('progress', 'tool_use', [
          { type: 'text', text: 'Looking…' },
          { type: 'tool_use', name: 'Read', input: {} },
        ]),
        1,
      ),
    ).toEqual({});
    expect(
      parse(
        assistant('status', 'tool_use', [
          {
            type: 'tool_use',
            name: 'mcp__language-assistant__reply',
            input: { request_id: 'r', text: 'Not yet' },
          },
        ]),
        2,
      ),
    ).toEqual({});
    expect(parse(user('result', [{ type: 'tool_result', content: 'Reply recorded.' }]), 3)).toEqual(
      {},
    );
    expect(
      parse(assistant('answer', 'end_turn', [{ type: 'text', text: 'Done: the answer.' }]), 4),
    ).toMatchObject({ message: { sourceId: 'answer', text: 'Done: the answer.', complete: true } });
  });
  it('sends without credentials to the existing Unix socket and confirms only a matching receipt', async () => {
    const { h, connection, frames } = await setup(false);
    const result = await connection.send('fixture-delivery', 'Exact message', [], {
      panelSessionId: 'panel',
      transport: 'peer',
    });
    expect(result).toMatchObject({ state: 'unconfirmed', nativeMessageId: 'fixture-delivery' });
    await expect.poll(() => frames.length).toBe(1);
    expect(frames[0]).toEqual({
      msgV: 1,
      msg_id: 'fixture-delivery',
      type: 'user',
      message: {
        role: 'user',
        content: '[Language Assistant delivery: fixture-delivery]\nExact message',
      },
      priority: 'next',
      session_id: h.sessionRef,
    });
    const delivery = {
      id: 'fixture-delivery',
      draftId: 'draft',
      revision: 1,
      target: h.target,
      englishText: 'Exact message',
      ...result,
    };
    expect(await connection.reconcileDelivery!(delivery)).toBe(false);
    const native = (
      await readFile(new URL('../fixtures/claude-peer-2.1.273.jsonl', import.meta.url), 'utf8')
    )
      .replaceAll('fixture-claude-session', h.sessionRef)
      .replaceAll('/fixture/project', h.project);
    await appendFile(h.transcript, native);
    expect(await connection.reconcileDelivery!(delivery)).toBe(true);
    expect(
      await connection.reconcileDelivery!({ ...delivery, nativeMessageId: 'different-request' }),
    ).toBe(false);
  });
  it('accepts Claude versions outside the known-version list', () => {
    expect(CLAUDE_PROTOCOL.versions).toContain('2.1.280');
    expect(CLAUDE_PROTOCOL.versions).toContain('2.1.284');
    expect(supportsClaudeProtocol('2.1.280')).toBe(true);
    expect(supportsClaudeProtocol('2.1.284')).toBe(true);
    expect(supportsClaudeProtocol('2.1.288')).toBe(true);
    expect(supportsClaudeProtocol('2.2.0')).toBe(true);
    expect(supportsClaudeProtocol('')).toBe(false);
  });
  it('discovers a live current-version Claude session from its native registry', async () => {
    const h = await harness('claude');
    cleanups.push(h.cleanup);
    const registryPath = join(h.dir, 'sessions', 'own.json');
    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    registry.version = '2.1.280';
    registry.messagingSocketPath = join(h.dir, 'inbox.sock');
    await writeFile(registryPath, JSON.stringify(registry));
    const runner: ProcessRunner = async function* (executable, args) {
      expect(executable).toBe('/usr/sbin/lsof');
      expect(args).toEqual(['-Fpcfn', '+c', '0', '--', registry.messagingSocketPath]);
      for (const line of ownerLines(
        { [registry.messagingSocketPath]: [{ pid: registry.pid, command: 'claude' }] },
        lsofPaths(args),
      ))
        yield { type: 'line', line };
      yield { type: 'exit', outcome: { reason: 'exited', code: 0, signal: null, diagnostics: '' } };
    };
    const adapter = createClaudeAdapter({ configDir: h.dir, runner });
    await expect(adapter.discoverOpen?.(new AbortController().signal)).resolves.toEqual({
      complete: true,
      candidates: [{ target: h.target, support: 'supported', activity: 'idle' }],
    });
  });
  it('attaches the live registry when stale duplicate records share a Claude session ID', async () => {
    const h = await harness('claude');
    cleanups.push(h.cleanup);
    const currentPath = join(h.dir, 'sessions', 'own.json');
    const current = JSON.parse(await readFile(currentPath, 'utf8'));
    current.version = '2.1.288';
    current.messagingSocketPath = join(h.dir, 'current.sock');
    current.updatedAt = 2;
    await writeFile(currentPath, JSON.stringify(current));
    await writeFile(
      join(h.dir, 'sessions', 'stale.json'),
      JSON.stringify({
        ...current,
        pid: process.pid + 1,
        version: '2.1.284',
        messagingSocketPath: join(h.dir, 'stale.sock'),
        updatedAt: 1,
      }),
    );
    const runner: ProcessRunner = async function* (executable, args) {
      expect(executable).toBe('/usr/sbin/lsof');
      const paths = lsofPaths(args);
      for (const line of ownerLines(
        { [current.messagingSocketPath]: [{ pid: process.pid, command: 'claude' }] },
        paths,
      ))
        yield { type: 'line', line };
      yield {
        type: 'exit',
        outcome: {
          reason: 'exited',
          code: paths.every((path) => path === current.messagingSocketPath) ? 0 : 1,
          signal: null,
          diagnostics: '',
        },
      };
    };
    const adapter = createClaudeAdapter({
      configDir: h.dir,
      transcriptPath: async () => h.transcript,
      runner,
      observeLive: async () => true,
      pollMs: 5,
    });
    const c = await adapter.attach(h.target);
    cleanups.push(() => c.detach());
    const w = watch(c);
    cleanups.push(w.stop);
    await expect
      .poll(() => w.events.find((e) => e.type === 'status'))
      .toEqual({ type: 'status', state: 'idle' });
  });
  it.each([
    ['2.1.273', 0, 'idle'],
    ['claude', 0, 'idle'],
    ['2.1.274', 0, 'idle'],
    ['node', 0, 'disconnected'],
    ['2.1.273', 1, 'disconnected'],
  ] as const)(
    'accepts a live Claude owner regardless of version: %s / PID offset %s',
    async (command, pidOffset, expectedState) => {
      const h = await harness('claude');
      cleanups.push(h.cleanup);
      if (command === '2.1.274') {
        const path = join(h.dir, 'sessions', 'own.json');
        const registry = JSON.parse(await readFile(path, 'utf8'));
        registry.version = command;
        await writeFile(path, JSON.stringify(registry));
      }
      const runner: ProcessRunner = async function* (executable, args) {
        if (
          executable !== '/usr/sbin/lsof' ||
          JSON.stringify(args) !==
            JSON.stringify(['-Fpcfn', '+c', '0', '--', join(h.dir, 'inbox.sock')])
        )
          throw new Error('Wrong liveness query');
        for (const line of ownerLines(
          { [join(h.dir, 'inbox.sock')]: [{ pid: process.pid + pidOffset, command }] },
          lsofPaths(args),
        ))
          yield { type: 'line', line };
        yield {
          type: 'exit',
          outcome: { reason: 'exited', code: 0, signal: null, diagnostics: '' },
        };
      };
      const adapter = createClaudeAdapter({
        configDir: h.dir,
        transcriptPath: async () => h.transcript,
        runner,
        pollMs: 5,
      });
      const c = await adapter.attach(h.target);
      cleanups.push(() => c.detach());
      const w = watch(c);
      cleanups.push(w.stop);
      await expect
        .poll(() => w.events.find((e) => e.type === 'status'))
        .toEqual({
          type: 'status',
          state: process.platform === 'darwin' ? expectedState : 'disconnected',
        });
    },
  );
  it.runIf(process.platform === 'darwin')(
    'shares one cached liveness check across status polls',
    async () => {
      const h = await harness('claude');
      cleanups.push(h.cleanup);
      const { runner, calls } = lsofRunner({
        [join(h.dir, 'inbox.sock')]: [{ pid: process.pid, command: 'claude' }],
      });
      const adapter = createClaudeAdapter({
        configDir: h.dir,
        transcriptPath: async () => h.transcript,
        runner,
        pollMs: 5,
        clock: {
          sleep: async (ms) => {
            polls++;
            await new Promise((resolve) => setTimeout(resolve, ms));
          },
        },
      });
      let polls = 0;
      const c = await adapter.attach(h.target);
      cleanups.push(() => c.detach());
      const w = watch(c);
      cleanups.push(w.stop);
      await expect.poll(() => polls, { timeout: 2000 }).toBeGreaterThanOrEqual(10);
      expect(w.events).toContainEqual({ type: 'status', state: 'idle' });
      expect(calls.length).toBeLessThanOrEqual(2);
    },
  );
  it('publishes an appended message and exact delivery receipt when the subsequent status lookup fails once', async () => {
    const h = await harness('claude');
    cleanups.push(h.cleanup);
    let failOnce = true;
    const adapter = createClaudeAdapter({
      configDir: h.dir,
      transcriptPath: async () => h.transcript,
      pollMs: 5,
      observeLive: async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error('transient registry lookup');
        }
        return true;
      },
    });
    const c = await adapter.attach(h.target);
    cleanups.push(() => c.detach());
    const native = (
      await readFile(new URL('../fixtures/claude-peer-2.1.273.jsonl', import.meta.url), 'utf8')
    )
      .replaceAll('fixture-claude-session', h.sessionRef)
      .replaceAll('/fixture/project', h.project);
    await appendFile(h.transcript, native);
    const w = watch(c);
    cleanups.push(w.stop);
    await expect
      .poll(() => w.events.some((e) => e.type === 'status' && e.state === 'idle'))
      .toBe(true);
    expect(
      w.events.filter((e) => e.type === 'message' && e.message.sourceId === 'peer-message-1'),
    ).toHaveLength(1);
    expect(
      w.events.filter((e) => e.type === 'delivery' && e.requestId === 'fixture-delivery'),
    ).toEqual([{ type: 'delivery', requestId: 'fixture-delivery', state: 'sent' }]);
    expect(w.events.some((e) => e.type === 'status' && e.state === 'disconnected')).toBe(true);
  });
  it('writes authenticated exact payload to the original socket and waits for correlated consumption', async () => {
    const { h, connection, frames } = await setup();
    const w = watch(connection);
    cleanups.push(w.stop);
    const text =
      'For this disposable transport test, reply only LANGUAGE_ASSISTANT_V273_READY. Do not use tools.';
    expect(
      await connection.send('fixture-delivery', text, [], {
        panelSessionId: 'panel',
        transport: 'peer',
      }),
    ).toMatchObject({ state: 'unconfirmed' });
    await expect.poll(() => frames.length).toBe(2);
    expect(frames).toEqual([
      { type: 'auth', token: 'private-test-token' },
      {
        msgV: 1,
        msg_id: 'fixture-delivery',
        type: 'user',
        message: {
          role: 'user',
          content: '[Language Assistant delivery: fixture-delivery]\n' + text,
        },
        priority: 'next',
        session_id: h.sessionRef,
      },
    ]);
    expect(w.events.filter((e) => e.type === 'delivery')).toEqual([]);
    const native = (
      await readFile(new URL('../fixtures/claude-peer-2.1.273.jsonl', import.meta.url), 'utf8')
    )
      .replaceAll('fixture-claude-session', h.sessionRef)
      .replaceAll('/fixture/project', h.project);
    await appendFile(h.transcript, native);
    await expect
      .poll(() =>
        w.events.some(
          (e) => e.type === 'delivery' && e.requestId === 'fixture-delivery' && e.state === 'sent',
        ),
      )
      .toBe(true);
    expect(
      w.events.find((e) => e.type === 'message' && e.message.sourceId === 'peer-message-1'),
    ).toMatchObject({ message: { text } });
    expect(JSON.stringify(w.events)).not.toContain('private-test-token');
    expect(JSON.stringify(w.events)).not.toContain('permission laundering');
  });
  it('verifies the bounded first identity-bearing record after native metadata prelude', async () => {
    const { h, adapter } = await setup();
    const original = await readFile(h.transcript, 'utf8');
    const prelude =
      [
        { type: 'mode', mode: 'default', sessionId: h.sessionRef },
        { type: 'file-history-snapshot', messageId: 'snapshot', snapshot: {} },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n';
    await writeFile(h.transcript, prelude + original);
    const c = await adapter.attach(h.target);
    cleanups.push(() => c.detach());
    expect((await c.history()).messages.at(-1)?.text).toBe('READY');
    await writeFile(
      h.transcript,
      prelude.replace(h.sessionRef, '33333333-3333-4333-8333-333333333333') + original,
    );
    await expect(adapter.attach(h.target)).rejects.toThrow(/identity/);
  });
  it('rejects mismatched own-child credentials without touching the inbox', async () => {
    const { credentials, connection, frames } = await setup();
    credentials.sessionRef = '33333333-3333-4333-8333-333333333333';
    expect(
      (
        await connection.send('request', '--exact\n$(touch nope)', [], {
          panelSessionId: 'panel',
          transport: 'peer',
        })
      ).state,
    ).toBe('failed');
    expect(frames).toEqual([]);
  });
  it('observes native approval state and does not send through it', async () => {
    const { h, connection, frames } = await setup();
    const path = join(h.dir, 'sessions', 'own.json');
    const registry = JSON.parse(await readFile(path, 'utf8'));
    registry.status = 'approval-required';
    await writeFile(path, JSON.stringify(registry));
    const w = watch(connection);
    cleanups.push(w.stop);
    await expect
      .poll(() => w.events.some((e) => e.type === 'status' && e.state === 'approval-required'))
      .toBe(true);
    expect(
      (await connection.send('request', 'text', [], { panelSessionId: 'panel', transport: 'peer' }))
        .state,
    ).toBe('failed');
    expect(frames).toEqual([]);
  });
  it('accepts unknown source versions while rejecting transcript identity mismatch', async () => {
    const { h, adapter } = await setup();
    const original = await readFile(h.transcript, 'utf8');
    await writeFile(
      h.transcript,
      original.replaceAll(h.sessionRef, '33333333-3333-4333-8333-333333333333'),
    );
    await expect(adapter.attach(h.target)).rejects.toThrow(/identity/);
    const path = join(h.dir, 'sessions', 'own.json');
    const registry = JSON.parse(await readFile(path, 'utf8'));
    registry.version = '2.2.0';
    await writeFile(path, JSON.stringify(registry));
    await writeFile(h.transcript, original);
    const c = await adapter.attach(h.target);
    cleanups.push(() => c.detach());
    const history = await c.history();
    expect(history.messages.some((message) => message.text === 'READY')).toBe(true);
  });
  it('unknown status is conservative working and missing credentials preserve an unresolved delivery', async () => {
    const h = await harness('claude');
    cleanups.push(h.cleanup);
    const c = await h.adapter.attach(h.target);
    cleanups.push(() => c.detach());
    expect(
      (await c.send('request', 'text', [], { panelSessionId: 'panel', transport: 'peer' })).state,
    ).toBe('unconfirmed');
    const path = join(h.dir, 'sessions', 'own.json');
    const registry = JSON.parse(await readFile(path, 'utf8'));
    registry.status = 'shell';
    await writeFile(path, JSON.stringify(registry));
    const w = watch(c);
    cleanups.push(w.stop);
    await expect
      .poll(() => w.events.some((e) => e.type === 'status' && e.state === 'working'))
      .toBe(true);
  });
  it('preserves the instruction without launching a CLI when no socket is available', async () => {
    const h = await harness('claude');
    cleanups.push(h.cleanup);
    const calls: string[][] = [];
    const path = join(h.dir, 'sessions', 'own.json');
    const registry = JSON.parse(await readFile(path, 'utf8'));
    delete registry.messagingSocketPath;
    await writeFile(path, JSON.stringify(registry));
    const runner: ProcessRunner = async function* (executable, args) {
      if (executable === '/usr/sbin/lsof') {
        yield {
          type: 'exit',
          outcome: { code: 0, signal: null, reason: 'exited', diagnostics: '' },
        };
        return;
      }
      calls.push(args);
      yield {
        type: 'line',
        line: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' }),
      };
      yield { type: 'exit', outcome: { code: 0, signal: null, reason: 'exited', diagnostics: '' } };
    };
    const c = await createClaudeAdapter({
      configDir: h.dir,
      transcriptPath: async () => h.transcript,
      observeLive: async () => true,
      runner,
    }).attach(h.target);
    cleanups.push(() => c.detach());
    const receipt = await c.send('request', 'Send this through Claude', [], {
      panelSessionId: 'panel',
      transport: 'peer',
    });
    expect(receipt).toMatchObject({ state: 'failed' });
    expect(calls).toEqual([]);
  });
});
it('includes file references in the authenticated native message', async () => {
  const { connection, frames, h } = await setup();
  expect(connection.capabilities.fileReferences).toBe(true);
  const result = await connection.send(
    'with-file',
    'Use this',
    [
      {
        id: 'file',
        sessionId: 'panel',
        kind: 'file',
        index: 1,
        name: 'app.ts',
        path: join(h.dir, 'app.ts'),
        worktreePath: h.dir,
        source: 'worktree',
        mime: 'text/plain',
        size: 1,
      },
    ],
    { panelSessionId: 'panel', transport: 'peer' },
  );
  expect(result.state).toBe('unconfirmed');
  await expect.poll(() => frames.length).toBe(2);
  expect(frames[1]?.message.content).toContain('File 1:');
});
