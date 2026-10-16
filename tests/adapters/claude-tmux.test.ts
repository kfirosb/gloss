import { afterEach, expect, it } from 'vitest';
import { appendFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createClaudeAdapter } from '../../src/agents/claude/index.js';
import type { ChannelRecord } from '../../src/agents/claude/channel-types.js';
import { NO_ROUTE_REASON } from '../../src/agents/claude/route.js';
import {
  NO_TYPING_RECORD_REASON,
  TERMINAL_GONE_REASON,
  TMUX_UNCONFIRMED_REASON,
  TYPING_UNCERTAIN_REASON,
  type GlossTerminal,
} from '../../src/agents/claude/tmux-delivery.js';
import { DIALOG_OPEN_REASON, type Delivery, type SendContext } from '../../src/core/contracts.js';
import { harness } from './agent-harness.js';
import { fixtureTerminal } from './tmux-fixtures.js';

type Harness = Awaited<ReturnType<typeof harness>>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function claudeSession(record: Record<string, unknown> = {}) {
  const h = await harness('claude');
  cleanups.push(h.cleanup);
  await writeFile(
    join(h.dir, 'sessions', 'own.json'),
    JSON.stringify({
      sessionId: h.sessionRef,
      cwd: h.project,
      pid: process.pid,
      version: '2.1.301',
      status: 'idle',
      ...record,
    }),
  );
  return h;
}
/** Stands in for Claude writing the typed message to its transcript. */
const recordTyped = (h: Harness) => async (text: string) => {
  await appendFile(
    h.transcript,
    JSON.stringify({
      type: 'user',
      uuid: randomUUID(),
      sessionId: h.sessionRef,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: text },
    }) + '\n',
  );
};
const channelRecord = (h: Harness): ChannelRecord => ({
  schemaVersion: 1,
  target: h.target,
  transcriptPath: h.transcript,
  generation: randomUUID(),
  port: 1,
  token: 'fixture-token',
  claudePid: process.pid,
  claudeStartedAt: 'start',
  channelPid: 2,
  channelStartedAt: 'start',
});
async function connect(
  h: Harness,
  terminal: GlossTerminal | undefined,
  channel = false,
  sleep = async () => {},
) {
  const connection = await createClaudeAdapter({
    configDir: h.dir,
    stateDir: h.dir,
    transcriptPath: async () => h.transcript,
    observeLive: async () => true,
    pollMs: 5,
    clock: { sleep },
    glossTerminal: async () => terminal,
    channelRegistry: { resolveChannel: async () => (channel ? channelRecord(h) : undefined) },
  }).attach(h.target, { panelSessionId: 'panel' });
  cleanups.push(() => connection.detach());
  return connection;
}
const typedDelivery = (h: Harness, id: string, text: string, after: number): Delivery => ({
  id,
  draftId: 'composer-' + id,
  revision: 1,
  target: h.target,
  englishText: text,
  state: 'unconfirmed',
  transport: 'tmux',
  nativeAfterRevision: after,
});
const tmux = { panelSessionId: 'panel', transport: 'tmux' as const, onTyping: () => undefined };

it('routes to Gloss’s own terminal first, and away from it when the pane no longer runs this session', async () => {
  const h = await claudeSession();
  const own = fixtureTerminal('2.1.301', 'empty').terminal;
  expect(await (await connect(h, own, true)).deliveryRoute?.()).toEqual({ transport: 'tmux' });
  // `/resume` inside the pane: its process is no longer this session's Claude.
  const resumed = fixtureTerminal('2.1.301', 'empty', { panePid: process.pid + 1 });
  const moved = await connect(h, resumed.terminal, true);
  expect(await moved.deliveryRoute?.()).toEqual({ transport: 'channel' });
  expect(await moved.send('delivery-1', 'Hi', [], tmux)).toEqual({
    state: 'failed',
    reason: TERMINAL_GONE_REASON,
  });
  expect(resumed.log.calls).toEqual([]);
  expect(await (await connect(h, undefined)).deliveryRoute?.()).toEqual({
    transport: null,
    reason: NO_ROUTE_REASON,
  });
});
it('offers peer for an outside session with a messaging socket', async () => {
  const h = await claudeSession({ messagingSocketPath: '/tmp/gloss-test-inbox.sock' });
  expect(await (await connect(h, undefined)).deliveryRoute?.()).toEqual({ transport: 'peer' });
});
it('types into the terminal, reports typing-started first, and confirms by the transcript record', async () => {
  const h = await claudeSession();
  const { terminal, log } = fixtureTerminal('2.1.301', 'empty', { onEnter: recordTyped(h) });
  const connection = await connect(h, terminal);
  const before = (await stat(h.transcript)).size;
  const typing: number[] = [];
  const result = await connection.send('delivery-1', 'Fix the login bug', [], {
    ...tmux,
    onTyping: (evidence) => {
      log.calls.push('typing');
      typing.push(evidence.nativeAfterRevision);
    },
  });
  expect(result).toMatchObject({ state: 'sent', nativeAfterRevision: before });
  expect(result.nativeMessageId).toMatch(/^transcript:/);
  expect(typing).toEqual([before]);
  expect(log.calls.slice(-4)).toEqual([
    'load:gloss-delivery-1',
    'typing',
    'paste:gloss-delivery-1',
    'enter',
  ]);
});
it('types nothing when the send cannot record that typing started', async () => {
  const h = await claudeSession();
  const { terminal, log } = fixtureTerminal('2.1.301', 'empty');
  const connection = await connect(h, terminal);
  expect(
    await connection.send('delivery-1', 'Hi', [], { panelSessionId: 'panel', transport: 'tmux' }),
  ).toEqual({ state: 'failed', reason: NO_TYPING_RECORD_REASON });
  expect(log.calls).toEqual([]);
  // @ts-expect-error The typing record is synchronous: a rejected promise would surface only after the paste.
  const asyncRecord: SendContext['onTyping'] = async () => undefined;
  expect(asyncRecord).toBeTypeOf('function');
});
it('types one message at a time into the same terminal, checking it again before each', async () => {
  const h = await claudeSession();
  const { terminal, log } = fixtureTerminal('2.1.301', 'empty', { onEnter: recordTyped(h) });
  // The first screen read waits until the second send reads the screen too, which only an unserialised adapter
  // does; a serialised one reaches the bounded wait's end and carries on.
  let reads = 0;
  let secondRead = () => {};
  const secondReading = new Promise<void>((resolve) => {
    secondRead = resolve;
  });
  const slowFirstRead: GlossTerminal = {
    ...terminal,
    capture: async () => {
      reads += 1;
      if (reads === 1) await Promise.race([secondReading, delay(100)]);
      else secondRead();
      return terminal.capture();
    },
  };
  const connection = await connect(h, slowFirstRead);
  const typing = { ...tmux, onTyping: () => void log.calls.push('typing') };
  const results = await Promise.all([
    connection.send('delivery-1', 'First message', [], typing),
    connection.send('delivery-2', 'Second message', [], typing),
  ]);
  expect(results.map((result) => result.state)).toEqual(['sent', 'sent']);
  expect(log.calls).toEqual([
    'capture',
    'cursor',
    'load:gloss-delivery-1',
    'typing',
    'paste:gloss-delivery-1',
    'enter',
    'capture',
    'cursor',
    'load:gloss-delivery-2',
    'typing',
    'paste:gloss-delivery-2',
    'enter',
  ]);
});
it('does not hold the next message in the terminal while one waits for confirmation', async () => {
  const h = await claudeSession();
  const { terminal, log } = fixtureTerminal('2.1.301', 'empty', {
    onEnter: async (text) => {
      if (text === 'Second message') await recordTyped(h)(text);
    },
  });
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const connection = await connect(h, terminal, false, () => released);
  const first = connection.send('delivery-1', 'First message', [], tmux);
  expect(await connection.send('delivery-2', 'Second message', [], tmux)).toMatchObject({
    state: 'sent',
  });
  release();
  expect(await first).toMatchObject({ state: 'unconfirmed', reason: TMUX_UNCONFIRMED_REASON });
  expect(log.calls.filter((call) => call === 'enter')).toHaveLength(2);
});
it('holds while Claude’s record says a dialog is open, without touching the terminal', async () => {
  const h = await claudeSession({ status: 'busy', waitingFor: 'dialog open' });
  const { terminal, log } = fixtureTerminal('2.1.301', 'empty');
  const connection = await connect(h, terminal);
  expect(await connection.send('delivery-1', 'Hi', [], tmux)).toEqual({
    state: 'held',
    reason: DIALOG_OPEN_REASON,
  });
  expect(log.calls).toEqual([]);
});
it('reports unconfirmed after the wait and confirms later from the transcript, never typing again', async () => {
  const h = await claudeSession();
  const { terminal, log } = fixtureTerminal('2.1.301', 'empty');
  const connection = await connect(h, terminal);
  const result = await connection.send('delivery-1', 'Fix it', [], tmux);
  expect(result).toMatchObject({ state: 'unconfirmed', reason: TMUX_UNCONFIRMED_REASON });
  const delivery = typedDelivery(h, 'delivery-1', 'Fix it', result.nativeAfterRevision ?? -1);
  expect(await connection.reconcileDelivery?.(delivery)).toBe(false);
  await recordTyped(h)('Fix it');
  const evidence = await connection.reconcileDelivery?.(delivery);
  expect(typeof evidence === 'object' && evidence.nativeMessageId.startsWith('transcript:')).toBe(
    true,
  );
  expect(log.calls.filter((call) => call === 'enter')).toHaveLength(1);
});
it('reports a paste whose Enter failed as unconfirmed, pasted once', async () => {
  const h = await claudeSession();
  const { terminal, log } = fixtureTerminal('2.1.301', 'empty', { fail: 'enter' });
  const connection = await connect(h, terminal);
  expect(await connection.send('delivery-1', 'Fix it', [], tmux)).toMatchObject({
    state: 'unconfirmed',
    reason: TYPING_UNCERTAIN_REASON,
  });
  expect(log.calls.filter((call) => call.startsWith('paste:'))).toEqual(['paste:gloss-delivery-1']);
});
it('confirms identical messages in the order they were typed', async () => {
  const h = await claudeSession();
  const connection = await connect(h, undefined);
  const size = (await stat(h.transcript)).size;
  const first = typedDelivery(h, 'first', 'yes', size);
  const second = typedDelivery(h, 'second', 'yes', size);
  await recordTyped(h)('yes');
  await recordTyped(h)('yes');
  const a = await connection.reconcileDelivery?.(first, []);
  const b = await connection.reconcileDelivery?.(second, [first]);
  if (typeof a !== 'object' || typeof b !== 'object') throw new Error('both should be confirmed');
  expect(b.nativeMessageId).not.toBe(a.nativeMessageId);
  const firstSent: Delivery = { ...first, state: 'sent', nativeMessageId: a.nativeMessageId };
  expect(await connection.reconcileDelivery?.(second, [firstSent])).toEqual(b);
});
it('fails without typing when Gloss’s terminal is gone at send time', async () => {
  const h = await claudeSession();
  const connection = await connect(h, undefined);
  expect(await connection.send('delivery-1', 'Hi', [], tmux)).toEqual({
    state: 'failed',
    reason: TERMINAL_GONE_REASON,
  });
});
