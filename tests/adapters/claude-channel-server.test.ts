import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ChannelStore } from '../../src/agents/claude/channel-store.js';
import type { ChannelKey, ChannelRecord } from '../../src/agents/claude/channel-types.js';

const fixture = new URL('../fixtures/claude-channel-child.mjs', import.meta.url).pathname;
const roots: string[] = [];
const transports: StdioClientTransport[] = [];
class EarlyTransport extends StdioClientTransport {
  override async start() {
    if (!this.pid) await super.start();
  }
}
afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function jsonFile(path: string): Promise<any> {
  return JSON.parse(await readFile(path, 'utf8'));
}
async function waitFile(path: string) {
  await expect
    .poll(async () => readFile(path, 'utf8').catch(() => ''), { timeout: 5000 })
    .not.toBe('');
}
function rawPost(url: string, headers: Record<string, string>, body: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    // Explicitly stream without Content-Length to exercise the chunked byte cap.
    const req = request(url, { method: 'POST', headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const resultHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers))
          if (value !== undefined)
            resultHeaders.set(name, Array.isArray(value) ? value.join(',') : value);
        resolve(
          new Response(Buffer.concat(chunks), {
            status: response.statusCode!,
            headers: resultHeaders,
          }),
        );
      });
      response.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
async function setup(mode = 'normal', initialize = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'la-channel-server-')));
  roots.push(root);
  const record: ChannelRecord = {
    schemaVersion: 1,
    generation: randomUUID(),
    token: 'a'.repeat(64),
    port: 0,
    target: {
      agent: 'claude',
      sessionRef: randomUUID(),
      projectId: mode === 'store-failure' ? join(root, 'absent') : root,
    },
    transcriptPath: join(root, 'native.jsonl'),
    claudePid: 100,
    claudeStartedAt: 'native-start',
    channelPid: 101,
    channelStartedAt: 'channel-start',
  };
  await writeFile(join(root, 'input.json'), JSON.stringify(record));
  const transport = new EarlyTransport({
    command: process.execPath,
    args: ['--experimental-transform-types', fixture, root, mode],
    stderr: 'pipe',
  });
  transports.push(transport);
  const client = new Client({ name: 'channel-test', version: '1' });
  const errors: string[] = [];
  client.onerror = (error) => errors.push(error.message);
  const notifications: unknown[] = [];
  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method === 'notifications/claude/channel')
      notifications.push(notification.params);
  };
  let stderr = '';
  transport.stderr!.on('data', (data) => {
    stderr += data.toString();
  });
  await transport.start();
  await waitFile(join(root, 'bound.json'));
  const bound = await jsonFile(join(root, 'bound.json'));
  record.port = bound.record.port;
  const key: ChannelKey = {
    panelSessionId: 'panel',
    nativeSessionId: record.target.sessionRef,
    generation: record.generation,
    requestId: 'request',
  };
  const url = `http://127.0.0.1:${record.port}`;
  const headers = { Authorization: `Bearer ${record.token}`, 'Content-Type': 'application/json' };
  const health = () => fetch(`${url}/health`, { headers });
  const post = (body: unknown = { key, text: 'question' }, extraHeaders = {}) =>
    rawPost(`${url}/messages`, { ...headers, ...extraHeaders }, JSON.stringify(body));
  if (initialize) await client.connect(transport);
  if (initialize && mode === 'normal') await waitFile(join(root, 'started'));
  const ledger = () => new ChannelStore(join(root, 'state', 'claude-channel-ledger.db'));
  const barrier = async () => {
    await client.listTools();
    expect(errors).toEqual([]);
  };
  return {
    root,
    record,
    key,
    url,
    headers,
    client,
    transport,
    notifications,
    errors,
    health,
    post,
    ledger,
    barrier,
    stderr: () => stderr,
    stateDir: bound.stateDir,
  };
}

describe('experimental Claude channel process boundary', () => {
  it('waits for initialized notification even after registration returned', async () => {
    const f = await setup('normal', false);
    await waitFile(join(f.root, 'started'));
    expect(await (await f.health()).json()).toEqual({
      generation: f.record.generation,
      ready: false,
    });
    expect((await f.post()).status).toBe(503);
    const send = f.transport.send.bind(f.transport);
    f.transport.send = async (message) => {
      if ('method' in message && message.method === 'notifications/initialized') return;
      await send(message);
    };
    await f.client.connect(f.transport);
    // Receiving initialize is insufficient: the client must complete the handshake.
    expect((await (await f.health()).json()).ready).toBe(false);
    expect((await f.post()).status).toBe(503);
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await expect.poll(async () => (await (await f.health()).json()).ready).toBe(true);
    expect((await f.post()).status).toBe(202);
    await f.barrier();
    expect(f.notifications).toHaveLength(1);
  });

  it('does not activate a bound endpoint before registration returns, even with initialized MCP', async () => {
    const f = await setup('gated');
    const before = await f.health();
    expect(before.status).toBe(503);
    expect(await before.json()).toEqual({ generation: null, ready: false });
    expect((await f.post()).status).toBe(503);
    await f.barrier();
    expect(f.notifications).toEqual([]);
    await writeFile(join(f.root, 'release'), 'go');
    await expect.poll(async () => (await (await f.health()).json()).ready).toBe(true);
    expect((await f.post()).status).toBe(202);
  });

  it('exposes only the channel capability and a scoped reply tool', async () => {
    const f = await setup();
    expect(f.client.getServerCapabilities()).toEqual({
      experimental: { 'claude/channel': {} },
      tools: {},
    });
    const { tools } = await f.client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['reply']);
    expect(tools[0]!.inputSchema.required).toEqual(['request_id', 'text']);
    expect(tools[0]!.inputSchema.additionalProperties).toBe(false);
    // The answer is the agent's normal final message; the reply tool is only for interim status.
    expect(f.client.getInstructions()).toMatch(
      /Answer each one in your normal final message of the turn/,
    );
    expect(f.client.getInstructions()).toMatch(/Do not call the reply tool for the answer/);
    expect(await (await f.health()).json()).toEqual({
      generation: f.record.generation,
      ready: true,
    });
    expect(f.stateDir).toBe(join(f.root, 'state'));
    expect(
      (await fetch(`${f.url}/reply`, { method: 'POST', headers: f.headers, body: '{}' })).status,
    ).toBe(404);
  });

  it('rejects unauthorized, browser, rebound-host, malformed, and mismatched inputs before claiming', async () => {
    const f = await setup();
    const cases: Array<[unknown, Record<string, string>, number]> = [
      [{ key: f.key, text: 'question' }, { Authorization: 'Bearer wrong' }, 401],
      [{ key: f.key, text: 'question' }, { Origin: '' }, 403],
      [{ key: f.key, text: 'question' }, { Origin: 'null' }, 403],
      [{ key: f.key, text: 'question' }, { Host: `localhost:${f.record.port}` }, 403],
      [{ key: f.key, text: 'question' }, { Host: 'attacker.example' }, 403],
      [null, {}, 400],
      [{ key: f.key, text: 2 }, {}, 400],
      [{ key: { ...f.key, panelSessionId: '' }, text: 'question' }, {}, 400],
      [{ key: { ...f.key, requestId: 'bad\0id' }, text: 'question' }, {}, 400],
      [{ key: { ...f.key, nativeSessionId: 'invalid' }, text: 'question' }, {}, 400],
      [{ key: { ...f.key, requestId: undefined }, text: 'question' }, {}, 400],
      [{ key: { ...f.key, generation: randomUUID() }, text: 'question' }, {}, 409],
      [{ key: { ...f.key, nativeSessionId: randomUUID() }, text: 'question' }, {}, 409],
      [{ key: f.key, text: 'question', stateDir: '/tmp/override' }, {}, 400],
      [{ key: { ...f.key, projectId: '/tmp/override' }, text: 'question' }, {}, 400],
      [{ key: f.key, text: 'x'.repeat(160001) }, {}, 400],
    ];
    for (const [body, headers, status] of cases) {
      const response = await f.post(body, headers);
      expect(response.status, JSON.stringify(headers)).toBe(status);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(response.headers.get('location')).toBeNull();
      const error = await response.json();
      expect(error).toHaveProperty('error');
      expect(JSON.stringify(error)).not.toContain(f.record.token);
    }
    expect((await fetch(`${f.url}/health`)).status).toBe(401);
    expect(
      (await fetch(`${f.url}/messages`, { method: 'POST', headers: f.headers, body: '{' })).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${f.url}/messages`, {
          method: 'POST',
          headers: f.headers,
          body: 'x'.repeat(1048577),
        })
      ).status,
    ).toBe(413);
    expect((await rawPost(`${f.url}/messages`, f.headers, 'x'.repeat(1048577))).status).toBe(413);
    await f.barrier();
    expect(f.notifications).toEqual([]);
    const store = f.ledger();
    try {
      expect(store.lookupRequest(f.key.generation, f.key.requestId)).toBeUndefined();
    } finally {
      store.close();
    }
    expect((await f.post()).status).toBe(202);
  });

  it('accepts the exact one MiB byte limit and 160000-character text limit without truncation', async () => {
    const f = await setup();
    const text = 'א'.repeat(160000);
    const body = JSON.stringify({ key: f.key, text });
    const padded = body + ' '.repeat(1048576 - Buffer.byteLength(body));
    expect((await rawPost(`${f.url}/messages`, f.headers, padded)).status).toBe(202);
    await f.barrier();
    expect(f.notifications).toEqual([{ content: text, meta: { request_id: 'request' } }]);
  });

  it('durably claims once across concurrent duplicates; conflicts never emit', async () => {
    const f = await setup();
    const responses = await Promise.all(Array.from({ length: 8 }, () => f.post()));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 202]);
    for (const r of responses) expect(await r.text()).not.toMatch(/delivered/i);
    expect((await f.post({ key: f.key, text: 'different' })).status).toBe(409);
    await f.barrier();
    expect(f.notifications).toEqual([{ content: 'question', meta: { request_id: 'request' } }]);
    const store = f.ledger();
    try {
      expect(store.lookupRequest(f.key.generation, 'request')).toEqual(f.key);
    } finally {
      store.close();
    }
  });

  it('does not re-emit pre-existing durable claims or claims from an older generation', async () => {
    const f = await setup();
    const store = f.ledger();
    try {
      store.claim(f.key, 'question');
      const old = randomUUID();
      store.registerGeneration(old, f.record.target);
      store.claim({ ...f.key, generation: old, requestId: 'old-pending' }, 'question');
    } finally {
      store.close();
    }
    expect((await f.post()).status).toBe(200);
    expect(
      (await f.post({ key: { ...f.key, requestId: 'old-pending' }, text: 'question' })).status,
    ).toBe(409);
    await f.barrier();
    expect(f.notifications).toEqual([]);
  });

  it('records the immutable first reply, rejecting unknown, ambiguous, foreign, and overriding tool inputs', async () => {
    const f = await setup();
    const reply = (args: Record<string, unknown>) =>
      f.client.callTool({ name: 'reply', arguments: args });
    expect((await reply({ request_id: 'unknown', text: 'answer' })).isError).toBe(true);
    await f.post();
    for (const args of [
      { request_id: 'request', text: 'answer', panelSessionId: 'evil' },
      { request_id: 'request', text: 4 },
      { request_id: 'request', text: 'x'.repeat(160001) },
    ]) {
      expect((await reply(args)).isError).toBe(true);
    }
    const first = await reply({ request_id: 'request', text: 'שלום\0answer' });
    expect(first.isError).not.toBe(true);
    expect(JSON.stringify(first).length).toBeLessThan(300);
    expect(JSON.stringify(first)).not.toContain('answer');
    expect((await reply({ request_id: 'request', text: 'שלום\0answer' })).isError).not.toBe(true);
    expect((await reply({ request_id: 'request', text: 'replacement' })).isError).toBe(true);
    expect((await f.client.callTool({ name: 'permission', arguments: {} })).isError).toBe(true);
    const store = f.ledger();
    try {
      expect(store.readReply(f.key)?.text).toBe('שלום\0answer');
      expect(store.replies(f.record.target, 0, 100)).toHaveLength(1);
      const old = randomUUID();
      store.registerGeneration(old, f.record.target);
      store.claim({ ...f.key, generation: old, requestId: 'old' }, 'older');
      expect((await reply({ request_id: 'old', text: 'foreign' })).isError).toBe(true);
      await f.post({ key: { ...f.key, panelSessionId: 'other' }, text: 'another panel' });
      expect((await reply({ request_id: 'request', text: 'ambiguous' })).isError).toBe(true);
      expect(store.readReply(f.key)?.text).toBe('שלום\0answer');
    } finally {
      store.close();
    }
  });

  it('aborts incomplete body reads after five seconds without a durable claim', async () => {
    const f = await setup();
    const started = performance.now();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${f.url}/messages`,
        { method: 'POST', headers: { ...f.headers, 'Content-Length': '1000' } },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode!));
        },
      );
      req.on('error', reject);
      req.write('{');
    });
    expect(status).toBe(408);
    expect(performance.now() - started).toBeGreaterThanOrEqual(4800);
    expect(performance.now() - started).toBeLessThan(7000);
    await f.barrier();
    expect(f.notifications).toEqual([]);
  }, 10000);

  it('closes HTTP and unregisters precisely its generation on stdin EOF', async () => {
    const f = await setup();
    await f.post();
    await f.transport.close();
    expect(await jsonFile(join(f.root, 'removed.json'))).toEqual({
      generation: f.record.generation,
    });
    expect(await readFile(join(f.root, 'removed-count'), 'utf8')).toBe('1');
    await expect(f.health()).rejects.toThrow();
    const store = f.ledger();
    try {
      expect(store.lookupRequest(f.key.generation, 'request')).toEqual(f.key);
    } finally {
      store.close();
    }
  });

  it('supports idempotent explicit close without an initialized client', async () => {
    const f = await setup('close', false);
    await waitFile(join(f.root, 'removed.json'));
    expect(await readFile(join(f.root, 'removed-count'), 'utf8')).toBe('1');
    await expect(f.health()).rejects.toThrow();
  });

  it('closes a pending listener on EOF and retracts a late registration', async () => {
    const f = await setup('gated');
    const closing = f.transport.close();
    await expect
      .poll(async () =>
        f.health().then(
          () => false,
          () => true,
        ),
      )
      .toBe(true);
    await writeFile(join(f.root, 'release'), 'go');
    await closing;
    expect(await jsonFile(join(f.root, 'removed.json'))).toEqual({
      generation: f.record.generation,
    });
  });

  it('closes the listener on registration failure without exposing diagnostics', async () => {
    const f = await setup('reject');
    await writeFile(join(f.root, 'release'), 'go');
    await waitFile(join(f.root, 'failed'));
    await expect(f.health()).rejects.toThrow();
    expect(f.stderr()).not.toContain('PRIVATE-STARTUP-DETAIL');
  });

  it('unregisters and closes HTTP if ledger initialization fails after registration', async () => {
    const f = await setup('store-failure', false);
    await waitFile(join(f.root, 'failed'));
    expect(await jsonFile(join(f.root, 'removed.json'))).toEqual({
      generation: f.record.generation,
    });
    await expect(f.health()).rejects.toThrow();
  });

  it('dispatches the CLI channel before panel imports, database setup, or panel flag validation', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'la-channel-cli-')));
    roots.push(root);
    const child = spawn(process.execPath, ['--experimental-transform-types', fixture, root, 'cli']);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const [code] = await once(child, 'exit');
    expect(code, stderr).toBe(0);
    expect(stdout).toBe('');
    expect(await jsonFile(join(root, 'cli.json'))).toEqual({ started: true });
  });
});
