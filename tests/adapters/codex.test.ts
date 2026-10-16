import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createCodexAdapter,
  parseCodexRecord,
  codexMessage,
  CODEX_CLOSED_REASON,
} from '../../src/agents/codex/index.js';
import { runProcess, type ProcessRunner } from '../../src/runtime/process-runner.js';
import { harness, watch } from './agent-harness.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function setup(receipt?: string, protocol = '0.154.0') {
  const h = await harness('codex');
  cleanups.push(h.cleanup);
  if (protocol !== '0.154.0') {
    const db = new DatabaseSync(join(h.dir, 'state_5.sqlite'));
    db.prepare('UPDATE threads SET cli_version = ? WHERE id = ?').run(protocol, h.sessionRef);
    db.close();
    const native = await readFile(
      new URL(`../fixtures/codex-events-${protocol}.jsonl`, import.meta.url),
      'utf8',
    );
    await writeFile(
      h.transcript,
      (h.header + native.replaceAll('fixture-codex-session', h.sessionRef))
        .replace('"cli_version":"0.154.0"', `"cli_version":"${protocol}"`)
        .replace('"source":"cli"', '"source":"vscode"'),
    );
  }
  const queueArgs = join(h.dir, 'queue-argv.json');
  const cli = join(h.dir, 'fake-cli.mjs');
  await writeFile(
    cli,
    `import {writeFileSync} from 'node:fs'; const args=process.argv.slice(2); if(args[0]==='--version') console.log('codex-cli ${protocol}'); else { writeFileSync(${JSON.stringify(queueArgs)},JSON.stringify(args)); console.log(${JSON.stringify(receipt ?? `Queued message 44444444-4444-4444-8444-444444444444 for thread ${h.sessionRef}.`)}); }`,
  );
  const runner: ProcessRunner = (_executable, args, input, signal, options) =>
    runProcess(process.execPath, [cli, ...args], input, signal, options);
  let live = true;
  const adapter = createCodexAdapter({
    codexHome: h.dir,
    runner,
    observeLive: async () => live,
    pollMs: 5,
  });
  const connection = await adapter.attach(h.target);
  cleanups.push(() => connection.detach());
  return {
    h,
    connection,
    adapter,
    queueArgs,
    setLive(value: boolean) {
      live = value;
    },
  };
}
describe('Codex 0.154.0 queue', () => {
  it('forwards only final assistant records with native timestamps', () => {
    const record = {
      timestamp: '2026-09-24T08:00:00Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 's',
        item: {
          type: 'AgentMessage',
          id: 'm',
          phase: 'commentary',
          content: [{ type: 'Text', text: 'Progress' }],
        },
      },
    };
    expect(parseCodexRecord(record, 40, 's')).toEqual({});
    record.payload.item.phase = 'final_answer';
    expect(parseCodexRecord(record, 40, 's').message).toMatchObject({
      sourceId: 'm',
      revision: 41,
      timestamp: record.timestamp,
      complete: true,
    });
  });
  it('replays finals through the sink, retries failure, and captures new finals once', async () => {
    const h = await harness('codex');
    cleanups.push(h.cleanup);
    const received: string[] = [];
    let fail = true;
    const adapter = createCodexAdapter({
      codexHome: h.dir,
      observeLive: async () => true,
      pollMs: 5,
      pageSize: 1,
      sourceSink: {
        async send(message) {
          expect(message.agent).toBe('codex');
          if (fail) {
            fail = false;
            throw new Error('Temporary disconnect');
          }
          received.push(message.sourceId);
        },
      },
    });
    const connection = await adapter.attach(h.target);
    const w = watch(connection);
    cleanups.push(w.stop);
    await expect.poll(() => received).toEqual(['fixture-item-3']);
    await h.appendMessage('New final', 'new-final');
    await h.appendMessage('New final', 'new-final');
    await expect.poll(() => received).toEqual(['fixture-item-3', 'new-final']);
  });

  it('sends literal reviewed text and exact thread in shell-free arguments; receipt is queued only', async () => {
    const { h, connection, queueArgs } = await setup();
    const text = '--help\n$(touch should-never-exist)\nעברית';
    expect(await connection.send('request', text)).toMatchObject({
      state: 'queued',
      nativeMessageId: '44444444-4444-4444-8444-444444444444',
      nativeAfterRevision: expect.any(Number),
    });
    expect(JSON.parse(await readFile(queueArgs, 'utf8'))).toEqual([
      'queue',
      '--thread',
      h.sessionRef,
      `--message=${text}`,
    ]);
  });
  it('correlates native acceptance and recovers it after reattach, never from text alone', async () => {
    const { h, connection, adapter } = await setup();
    const result = await connection.send('request', 'Exact instruction');
    const delivery = {
      id: 'request',
      draftId: 'draft',
      revision: 1,
      target: h.target,
      englishText: 'Exact instruction',
      ...result,
    };
    expect(await connection.reconcileDelivery!(delivery)).toBe(false);
    const w = watch(connection);
    cleanups.push(w.stop);
    await appendFile(
      h.transcript,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: h.sessionRef,
          item: {
            type: 'UserMessage',
            id: 'accepted',
            client_id: 'different-client-id',
            content: [{ type: 'text', text: 'Exact instruction' }],
          },
        },
      }) + '\n',
    );
    await expect
      .poll(() =>
        w.events.some(
          (e) =>
            e.type === 'delivery' && e.requestId === 'different-client-id' && e.state === 'sent',
        ),
      )
      .toBe(true);
    const reopened = await adapter.attach(h.target);
    cleanups.push(() => reopened.detach());
    expect(await reopened.reconcileDelivery!(delivery)).toBe(true);
    expect(
      await reopened.reconcileDelivery!({
        ...delivery,
        nativeMessageId: 'wrong-id',
        nativeAfterRevision: Number.MAX_SAFE_INTEGER,
      }),
    ).toBe(false);
    expect(await reopened.reconcileDelivery!({ ...delivery, englishText: 'Wrong text' })).toBe(
      false,
    );
  });
  it('recovers legacy UUIDv7 receipts only from a unique exact acceptance after receipt creation', async () => {
    const { h, connection } = await setup();
    const receipt = {
      id: 'legacy',
      draftId: 'old',
      revision: 1,
      target: h.target,
      state: 'queued' as const,
      englishText: 'Legacy instruction',
      nativeMessageId: '01900000-0000-7000-8000-000000000001',
    };
    const timestamp = parseInt('019000000000', 16);
    const append = async (id: string, time: number) =>
      appendFile(
        h.transcript,
        JSON.stringify({
          timestamp: new Date(time).toISOString(),
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            thread_id: h.sessionRef,
            item: {
              type: 'UserMessage',
              id,
              client_id: id,
              content: [{ type: 'text', text: 'Legacy instruction' }],
            },
          },
        }) + '\n',
      );
    await append('earlier', timestamp - 1000);
    expect(await connection.reconcileDelivery!(receipt)).toBe(false);
    await append('accepted', timestamp + 1000);
    expect(await connection.reconcileDelivery!(receipt)).toBe(true);
    await append('ambiguous', timestamp + 2000);
    expect(await connection.reconcileDelivery!(receipt)).toBe(false);
  });
  it('delivers image references as files because queue rejects native image arguments', async () => {
    const { h, connection, queueArgs } = await setup();
    const attachment = {
      id: 'image',
      name: 'Reference.png',
      mime: 'image/png',
      size: 10,
      path: join(h.dir, 'reference image.png'),
    };
    const result = await connection.send('image-request', 'Use this reference', [attachment]);
    expect(result.state).toBe('queued');
    expect(JSON.parse(await readFile(queueArgs, 'utf8'))).toEqual([
      'queue',
      '--thread',
      h.sessionRef,
      `--message=${codexMessage('Use this reference', [attachment])}`,
    ]);
    const delivery = {
      id: 'image-request',
      draftId: 'draft',
      revision: 1,
      target: h.target,
      englishText: 'Use this reference',
      attachments: [attachment],
      ...result,
    };
    expect(await connection.reconcileDelivery!(delivery)).toBe(false);
    await appendFile(
      h.transcript,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: h.sessionRef,
          item: {
            type: 'UserMessage',
            id: 'image-accepted',
            client_id: 'different-native-id',
            content: [{ type: 'text', text: codexMessage('Use this reference', [attachment]) }],
          },
        },
      }) + '\n',
    );
    expect(await connection.reconcileDelivery!(delivery)).toBe(true);
    expect(await connection.reconcileDelivery!({ ...delivery, attachments: [] })).toBe(false);
  });
  it.each([
    '',
    'Queued successfully',
    'Queued message 44444444-4444-4444-8444-444444444444 for thread 33333333-3333-4333-8333-333333333333.',
  ])('does not infer acceptance from zero exit or wrong receipt: %s', async (receipt) => {
    const { connection } = await setup(receipt);
    expect((await connection.send('request', 'text')).state).toBe('unconfirmed');
  });
  it('queues while working but still blocks missing writer evidence', async () => {
    const { h, connection, queueArgs, setLive } = await setup();
    await appendFile(
      h.transcript,
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'pending-approval' },
      }) + '\n',
    );
    const w = watch(connection);
    cleanups.push(w.stop);
    await expect
      .poll(() => w.events.some((e) => e.type === 'status' && e.state === 'working'))
      .toBe(true);
    expect((await connection.send('request', 'text')).state).toBe('queued');
    await appendFile(
      h.transcript,
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n',
    );
    setLive(false);
    expect((await connection.send('request2', 'text')).state).toBe('failed');
  });
  it('permanently blocks sending after a mismatched appended native record even if later records say idle', async () => {
    const { h, connection, queueArgs } = await setup();
    await appendFile(
      h.transcript,
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', thread_id: '33333333-3333-4333-8333-333333333333' },
      }) + '\n',
    );
    expect((await connection.send('first', 'text')).state).toBe('failed');
    await appendFile(
      h.transcript,
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n',
    );
    expect((await connection.send('second', 'text')).state).toBe('failed');
    await expect(readFile(queueArgs, 'utf8')).rejects.toThrow();
  });
  it('does not run queue with an invalid installed CLI identity', async () => {
    const { h, connection, queueArgs } = await setup();
    const path = join(h.dir, 'fake-cli.mjs');
    await writeFile(
      path,
      (await readFile(path, 'utf8')).replace('codex-cli 0.154.0', 'other-cli 0.160.0'),
    );
    expect((await connection.send('request', 'text')).state).toBe('failed');
    await expect(readFile(queueArgs, 'utf8')).rejects.toThrow();
  });
  it('verifies source identity and version from the native session header', async () => {
    const { h, adapter } = await setup();
    const source = await readFile(h.transcript, 'utf8');
    await writeFile(
      h.transcript,
      source.replace('"cli_version":"0.154.0"', '"cli_version":"0.155.0"'),
    );
    await expect(adapter.attach(h.target)).rejects.toThrow(/identity|version/);
    await writeFile(
      h.transcript,
      source.replace(`"id":"${h.sessionRef}"`, '"id":"33333333-3333-4333-8333-333333333333"'),
    );
    await expect(adapter.attach(h.target)).rejects.toThrow(/identity/);
  });
});
it('requires the full normalized manifest after the recorded boundary and refuses duplicates on reopen', async () => {
  const { h, connection, adapter, queueArgs } = await setup();
  const attachments = [
    {
      id: 'file',
      sessionId: 'panel',
      kind: 'file' as const,
      index: 7,
      name: 'app.ts',
      path: join(h.dir, 'app.ts'),
      worktreePath: h.dir,
      source: 'worktree' as const,
      mime: 'text/plain',
      size: 3,
    },
  ];
  const text = codexMessage('Read', attachments);
  const append = async (id: string, message: string) =>
    appendFile(
      h.transcript,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: h.sessionRef,
          item: {
            type: 'UserMessage',
            id,
            client_id: '44444444-4444-4444-8444-444444444444',
            content: [{ type: 'text', text: message }],
          },
        },
      }) + '\n',
    );
  await append('before', text);
  const result = await connection.send('files', 'Read', attachments);
  const delivery = {
    id: 'files',
    draftId: 'draft',
    revision: 1,
    target: h.target,
    englishText: 'Read',
    attachments,
    ...result,
  };
  expect(JSON.parse(await readFile(queueArgs, 'utf8'))).toEqual([
    'queue',
    '--thread',
    h.sessionRef,
    `--message=${text}`,
  ]);
  const reopened = await adapter.attach(h.target);
  cleanups.push(() => reopened.detach());
  expect(await reopened.reconcileDelivery!(delivery)).toBe(false);
  await append('wrong', text.replace(attachments[0]!.path, '/wrong/path'));
  expect(await reopened.reconcileDelivery!(delivery)).toBe(false);
  await append('right', text);
  expect(await reopened.reconcileDelivery!(delivery)).toBe(true);
  await append('duplicate', text);
  expect(await reopened.reconcileDelivery!(delivery)).toBe(false);
});
it('reconciles old queued image manifests even when Task5 saved normalized image objects', async () => {
  const { h, connection } = await setup();
  const image = {
    id: 'image',
    sessionId: 'panel',
    kind: 'image' as const,
    index: 2,
    name: 'ref.png',
    path: join(h.dir, 'ref.png'),
    worktreePath: h.dir,
    source: 'upload' as const,
    mime: 'image/png',
    size: 1,
  };
  const result = await connection.send('legacy-normalized', 'Use image');
  const oldText = `Use image\n\nAttached image reference files (open each with the image viewing tool before answering):\nImage 2: ${JSON.stringify(image.path)}`;
  await appendFile(
    h.transcript,
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: h.sessionRef,
        item: {
          type: 'UserMessage',
          id: 'legacy-image',
          content: [{ type: 'text', text: oldText }],
        },
      },
    }) + '\n',
  );
  const receipt = {
    id: 'legacy-normalized',
    draftId: 'draft',
    revision: 1,
    target: h.target,
    englishText: 'Use image',
    attachments: [image],
    ...result,
  };
  expect(await connection.reconcileDelivery!(receipt)).toBe(true);
  expect(await connection.reconcileDelivery!({ ...receipt, referenceFormat: 'manifest-v1' })).toBe(
    false,
  );
});

it('keeps a verified writer conservatively working when a long tail omits lifecycle markers, but blocks partial records', async () => {
  const { h, adapter, queueArgs, setLive } = await setup();
  await appendFile(
    h.transcript,
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }) + '\n',
  );
  const commentary =
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: h.sessionRef,
        item: {
          type: 'AgentMessage',
          phase: 'commentary',
          id: 'progress',
          content: [{ type: 'Text', text: 'x'.repeat(8192) }],
        },
      },
    }) + '\n';
  await appendFile(h.transcript, commentary.repeat(140));
  const reopened = await adapter.attach(h.target);
  const watching = watch(reopened);
  cleanups.push(watching.stop);
  await expect
    .poll(() => watching.events.filter((event) => event.type === 'status').at(-1))
    .toEqual({ type: 'status', state: 'working' });
  expect((await reopened.send('long-turn', 'Long turn instruction')).state).toBe('queued');
  const sent = await readFile(queueArgs, 'utf8');
  await appendFile(h.transcript, '{"type":"event_msg","payload":');
  expect((await reopened.send('partial', 'Do not send partial')).state).toBe('failed');
  expect(await readFile(queueArgs, 'utf8')).toBe(sent);
  await appendFile(h.transcript, '{"type":"token_count"}}\n');
  expect((await reopened.send('recovered-record', 'Completed record instruction')).state).toBe(
    'queued',
  );
  setLive(false);
  expect((await reopened.send('no-writer', 'Do not send without writer')).state).toBe('failed');
});

it.each(['0.153.4', '0.157.1', '0.158.0', '0.159.3'])(
  'discovers, attaches, and strictly reconciles %s while using its verified queue CLI',
  async (protocol) => {
    const { h, adapter, connection, queueArgs } = await setup(undefined, protocol);
    expect(await adapter.discover(h.project)).toEqual([h.target]);
    expect(
      (await connection.history()).messages.map((message) => ({
        role: message.role,
        text: message.text,
      })),
    ).toEqual([
      { role: 'user', text: 'Reply READY for this protocol fixture.' },
      { role: 'assistant', text: 'READY' },
    ]);
    const result = await connection.send('new-protocol', 'Protocol audit instruction');
    expect(result).toMatchObject({ state: 'queued', nativeAfterRevision: expect.any(Number) });
    expect(JSON.parse(await readFile(queueArgs, 'utf8'))).toEqual([
      'queue',
      '--thread',
      h.sessionRef,
      '--message=Protocol audit instruction',
    ]);
    const delivery = {
      id: 'new-protocol',
      draftId: 'draft',
      revision: 1,
      target: h.target,
      englishText: 'Protocol audit instruction',
      ...result,
    };
    expect(await connection.reconcileDelivery!(delivery)).toBe(false);
    await appendFile(
      h.transcript,
      JSON.stringify({
        timestamp: '2026-09-28T12:00:00Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: h.sessionRef,
          item: {
            type: 'UserMessage',
            id: 'accepted-157',
            client_id: 'different-client-id',
            content: [{ type: 'text', text: 'Protocol audit instruction' }],
          },
        },
      }) + '\n',
    );
    expect(await connection.reconcileDelivery!(delivery)).toBe(true);
  },
);
it('reads and queues a session after an unfamiliar version upgrade', async () => {
  const { h, adapter } = await setup();
  const db = new DatabaseSync(join(h.dir, 'state_5.sqlite'));
  db.prepare('UPDATE threads SET cli_version = ? WHERE id = ?').run('0.160.0', h.sessionRef);
  db.close();
  await writeFile(
    h.transcript,
    (await readFile(h.transcript, 'utf8')).replace(
      '"cli_version":"0.154.0"',
      '"cli_version":"0.160.0"',
    ),
  );
  const cli = join(h.dir, 'fake-cli.mjs');
  await writeFile(
    cli,
    (await readFile(cli, 'utf8')).replace('codex-cli 0.154.0', 'codex-cli 0.160.0'),
  );
  const c = await adapter.attach(h.target);
  cleanups.push(() => c.detach());
  expect((await c.history()).messages.some((m) => m.text === 'READY')).toBe(true);
  expect((await c.send('upgraded', 'Version-independent delivery')).state).toBe('queued');
});
it('rejects metadata/header version mismatch even when both versions are supported', async () => {
  const { h, adapter } = await setup();
  await writeFile(
    h.transcript,
    (await readFile(h.transcript, 'utf8')).replace(
      '"cli_version":"0.154.0"',
      '"cli_version":"0.157.1"',
    ),
  );
  await expect(adapter.attach(h.target)).rejects.toThrow(/identity|version/);
});
it.each(['0.153.4', '0.157.1', '0.158.0', '0.159.3'])(
  'never treats a wrong-target %s queue receipt as queued or sent',
  async (protocol) => {
    const { connection } = await setup(
      'Queued message 44444444-4444-4444-8444-444444444444 for thread 33333333-3333-4333-8333-333333333333.',
      protocol,
    );
    expect((await connection.send('wrong-target', 'Protocol audit instruction')).state).toBe(
      'unconfirmed',
    );
  },
);

describe('closed Codex threads (no attached terminal)', () => {
  it('blocks sending with a clear reason and never queues', async () => {
    const { connection, queueArgs, setLive } = await setup();
    setLive(false);
    expect(await connection.send('closed', 'text')).toEqual({
      state: 'failed',
      reason: CODEX_CLOSED_REASON,
    });
    await expect(readFile(queueArgs, 'utf8')).rejects.toThrow();
  });
  async function terminalRig(h: Awaited<ReturnType<typeof harness>>) {
    await mkdir(join(h.dir, 'thread-writer-locks'));
    const lock = join(h.dir, 'thread-writer-locks', `${h.sessionRef}.lock`);
    await writeFile(lock, '');
    const state = {
      owner: '/opt/codex/bin/codex --model gpt',
      writerProbes: 0,
      now: 0,
    };
    const lines = (values: string[]) =>
      (async function* () {
        for (const line of values) yield { type: 'line' as const, line };
        yield {
          type: 'exit' as const,
          outcome: { code: 0, signal: null, reason: 'exited' as const, diagnostics: '' },
        };
      })();
    const runner: ProcessRunner = (command, args) => {
      if (command === '/usr/sbin/lsof' && args[0] === '-Fpcfn') {
        state.writerProbes++;
        return lines(['p900', 'ccodex', 'f20', `n${lock}`]);
      }
      if (command === '/usr/sbin/lsof') return lines([]);
      if (command === '/bin/ps') return lines([`900 05:00 codex ${state.owner}`]);
      throw new Error(`Unexpected process ${command}`);
    };
    const adapter = createCodexAdapter({
      codexHome: h.dir,
      runner,
      pollMs: 5,
      now: () => state.now,
    });
    return { state, adapter };
  }

  it.runIf(process.platform === 'darwin')(
    'shares one liveness round between discovery and status polls',
    async () => {
      const h = await harness('codex');
      cleanups.push(h.cleanup);
      const { state, adapter } = await terminalRig(h);
      const connection = await adapter.attach(h.target);
      cleanups.push(() => connection.detach());
      const w = watch(connection);
      cleanups.push(w.stop);
      await expect
        .poll(() => w.events.filter((e) => e.type === 'status').at(-1))
        .toEqual({ type: 'status', state: 'idle' });
      for (let i = 0; i < 3; i++) await adapter.discoverOpen!(new AbortController().signal);
      expect(state.writerProbes).toBe(1);
    },
  );

  it.runIf(process.platform === 'darwin')(
    'reuses a liveness round for 3 seconds after it finished',
    async () => {
      const h = await harness('codex');
      cleanups.push(h.cleanup);
      const { state, adapter } = await terminalRig(h);
      const discover = () => adapter.discoverOpen!(new AbortController().signal);
      await discover();
      expect(state.writerProbes).toBe(1);
      state.now = 2999;
      await discover();
      expect(state.writerProbes).toBe(1);
      state.now = 3001;
      await discover();
      expect(state.writerProbes).toBe(2);
    },
  );

  it.runIf(process.platform === 'darwin')('checks liveness afresh before every send', async () => {
    const h = await harness('codex');
    cleanups.push(h.cleanup);
    const { state, adapter } = await terminalRig(h);
    const connection = await adapter.attach(h.target);
    cleanups.push(() => connection.detach());
    const w = watch(connection);
    cleanups.push(w.stop);
    await expect
      .poll(() => w.events.filter((e) => e.type === 'status').at(-1))
      .toEqual({ type: 'status', state: 'idle' });
    state.owner =
      '/x/.codex/packages/app-server-daemon/bin/codex app-server --listen unix:// --managed-daemon';
    expect(await connection.send('closed', 'text')).toEqual({
      state: 'failed',
      reason: CODEX_CLOSED_REASON,
    });
  });

  it.runIf(process.platform === 'darwin')(
    'reports a daemon-held lock without a terminal as closed and a terminal-held lock as open',
    async () => {
      const h = await harness('codex');
      cleanups.push(h.cleanup);
      await mkdir(join(h.dir, 'thread-writer-locks'));
      const lock = join(h.dir, 'thread-writer-locks', `${h.sessionRef}.lock`);
      await writeFile(lock, '');
      const queueArgs = join(h.dir, 'queue-argv.json');
      const cli = join(h.dir, 'fake-cli.mjs');
      await writeFile(
        cli,
        `import {writeFileSync} from 'node:fs'; const args=process.argv.slice(2); if(args[0]==='--version') console.log('codex-cli 0.162.1'); else { writeFileSync(${JSON.stringify(queueArgs)},JSON.stringify(args)); console.log('Queued message 44444444-4444-4444-8444-444444444444 for thread ${h.sessionRef}.'); }`,
      );
      let owner =
        '/x/.codex/packages/app-server-daemon/bin/codex app-server --listen unix:// --managed-daemon';
      const lines = (values: string[]) =>
        (async function* () {
          for (const line of values) yield { type: 'line' as const, line };
          yield {
            type: 'exit' as const,
            outcome: { code: 0, signal: null, reason: 'exited' as const, diagnostics: '' },
          };
        })();
      const runner: ProcessRunner = (command, args, input, signal, options) => {
        if (command === '/usr/sbin/lsof' && args[0] === '-Fpcfn')
          return lines(['p900', 'ccodex', 'f20', `n${lock}`]);
        if (command === '/usr/sbin/lsof') return lines([]);
        if (command === '/bin/ps') return lines([`900 05:00 codex ${owner}`]);
        return runProcess(process.execPath, [cli, ...args], input, signal, options);
      };
      let now = 0;
      const adapter = createCodexAdapter({ codexHome: h.dir, runner, pollMs: 5, now: () => now });
      const connection = await adapter.attach(h.target);
      cleanups.push(() => connection.detach());
      const w = watch(connection);
      cleanups.push(w.stop);
      await expect
        .poll(() => w.events.filter((e) => e.type === 'status').at(-1))
        .toEqual({ type: 'status', state: 'disconnected' });
      expect(await connection.send('closed', 'text')).toEqual({
        state: 'failed',
        reason: CODEX_CLOSED_REASON,
      });
      await expect(readFile(queueArgs, 'utf8')).rejects.toThrow();
      owner = '/opt/codex/bin/codex --model gpt';
      now += 5000;
      await expect
        .poll(() => w.events.filter((e) => e.type === 'status').at(-1))
        .toEqual({ type: 'status', state: 'idle' });
      expect((await connection.send('open', 'text')).state).toBe('queued');
    },
  );
});
