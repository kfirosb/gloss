import { afterEach, expect, it } from 'vitest';
import { appendFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createClaudeAdapter, type ClaudeAdapterOptions } from '../../src/agents/claude/index.js';
import type { ChannelRecord } from '../../src/agents/claude/channel-types.js';
import { NO_ROUTE_REASON, SESSION_GONE_REASON } from '../../src/agents/claude/route.js';
import {
  NO_TYPING_RECORD_REASON,
  SESSION_SWITCHED_REASON,
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
/** Claude's record for this process, named after its pid as Claude names it. */
const ownRecord = (h: Harness) => join(h.dir, 'sessions', `${process.pid}.json`);
const writeRecord = (h: Harness, path: string, record: Record<string, unknown> = {}) =>
  writeFile(
    path,
    JSON.stringify({
      sessionId: h.sessionRef,
      cwd: h.project,
      pid: process.pid,
      version: '2.1.301',
      status: 'idle',
      ...record,
    }),
  );
async function claudeSession(record: Record<string, unknown> = {}) {
  const h = await harness('claude');
  cleanups.push(h.cleanup);
  // Replaces the harness's record, so this process has exactly the one Claude would write.
  await rm(join(h.dir, 'sessions', 'own.json'));
  await writeRecord(h, ownRecord(h), record);
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
type Clock = NonNullable<ClaudeAdapterOptions['clock']>;
/** Test time: each sleep moves the clock forward by its length, once `ready` lets it. */
function testClock(ready: (signal: AbortSignal) => Promise<void> = async () => {}) {
  let time = 0;
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => time,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      await ready(signal);
      time += ms;
    },
  };
  return { clock, sleeps };
}
async function connect(
  h: Harness,
  terminal: GlossTerminal | undefined,
  channel = false,
  clock: Clock = testClock().clock,
) {
  const connection = await createClaudeAdapter({
    configDir: h.dir,
    stateDir: h.dir,
    transcriptPath: async () => h.transcript,
    observeLive: async () => true,
    pollMs: 5,
    clock,
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
  const { terminal, log } = fixtureTerminal('2.1.301', 'empty');
  const connection = await connect(h, terminal, true);
  expect(await connection.deliveryRoute?.()).toEqual({ transport: 'tmux' });
  // `/resume` inside the pane keeps the process: its pid stays and Claude's record for it names the resumed
  // session. A leftover record that still names this session with the same pid must not keep the route.
  await writeRecord(h, ownRecord(h), { sessionId: randomUUID() });
  await writeRecord(h, join(h.dir, 'sessions', 'leftover.json'));
  expect(await connection.deliveryRoute?.()).toEqual({ transport: 'channel' });
  expect(await connection.send('delivery-1', 'Hi', [], tmux)).toEqual({
    state: 'failed',
    reason: SESSION_SWITCHED_REASON,
  });
  expect(log.calls).toEqual([]);
  expect(await (await connect(h, undefined)).deliveryRoute?.()).toEqual({
    transport: null,
    reason: NO_ROUTE_REASON,
  });
});
it('offers no terminal route when Claude’s record for the pane’s process is missing or unreadable', async () => {
  const h = await claudeSession();
  const { terminal } = fixtureTerminal('2.1.301', 'empty');
  await rm(ownRecord(h));
  await writeRecord(h, join(h.dir, 'sessions', 'leftover.json'));
  const connection = await connect(h, terminal, true);
  expect(await connection.deliveryRoute?.()).toEqual({ transport: 'channel' });
  await writeFile(ownRecord(h), '{"sessionId":');
  expect(await connection.deliveryRoute?.()).toEqual({ transport: 'channel' });
});
it('types nothing when `/resume` switches the pane to another session while the screen is read', async () => {
  const h = await claudeSession();
  const fixture = fixtureTerminal('2.1.301', 'empty');
  const resumedDuringRead: GlossTerminal = {
    ...fixture.terminal,
    capture: async () => {
      await writeRecord(h, ownRecord(h), { sessionId: randomUUID() });
      // A leftover record keeps this session findable, so only the re-check before the paste can stop it.
      await writeRecord(h, join(h.dir, 'sessions', 'leftover.json'));
      return fixture.terminal.capture();
    },
  };
  const connection = await connect(h, resumedDuringRead);
  let typing = false;
  expect(
    await connection.send('delivery-1', 'Hi', [], {
      ...tmux,
      onTyping: () => {
        typing = true;
      },
    }),
  ).toEqual({ state: 'failed', reason: SESSION_SWITCHED_REASON });
  expect(typing).toBe(false);
  expect(fixture.log.calls).toEqual(['capture', 'cursor']);
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
  expect(log.calls.slice(-5)).toEqual([
    'load:gloss-delivery-1',
    'typing',
    'paste:gloss-delivery-1',
    'capture',
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
    'capture',
    'enter',
    'capture',
    'cursor',
    'load:gloss-delivery-2',
    'typing',
    'paste:gloss-delivery-2',
    'capture',
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
  const connection = await connect(h, terminal, false, testClock(() => released).clock);
  const first = connection.send('delivery-1', 'First message', [], tmux);
  expect(await connection.send('delivery-2', 'Second message', [], tmux)).toMatchObject({
    state: 'sent',
  });
  release();
  expect(await first).toMatchObject({ state: 'unconfirmed', reason: TMUX_UNCONFIRMED_REASON });
  expect(log.calls.filter((call) => call === 'enter')).toHaveLength(2);
});
it('confirms identical messages typed back to back in the order they were typed', async () => {
  const h = await claudeSession();
  const { terminal } = fixtureTerminal('2.1.301', 'empty');
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sleeping = 0;
  let bothWaiting = () => {};
  const waiting = new Promise<void>((resolve) => {
    bothWaiting = resolve;
  });
  const { clock } = testClock(async () => {
    if (++sleeping === 2) bothWaiting();
    await released;
  });
  const connection = await connect(h, terminal, false, clock);
  // Neither send is told about the other, as when both are dispatched before either records its typing.
  const first = connection.send('first', 'yes', [], tmux);
  const second = connection.send('second', 'yes', [], tmux);
  await waiting;
  await recordTyped(h)('yes');
  release();
  const [a, b] = await Promise.all([first, second]);
  expect(a).toMatchObject({ state: 'sent' });
  expect(b).toMatchObject({ state: 'unconfirmed', reason: TMUX_UNCONFIRMED_REASON });
  if (!a.nativeMessageId) throw new Error('the first should be confirmed');
  const firstSent: Delivery = {
    ...typedDelivery(h, 'first', 'yes', a.nativeAfterRevision ?? -1),
    state: 'sent',
    nativeMessageId: a.nativeMessageId,
  };
  const secondTyped = typedDelivery(h, 'second', 'yes', b.nativeAfterRevision ?? -1);
  expect(await connection.reconcileDelivery?.(secondTyped, [firstSent])).toBe(false);
  await recordTyped(h)('yes');
  const evidence = await connection.reconcileDelivery?.(secondTyped, [firstSent]);
  if (typeof evidence !== 'object') throw new Error('the second should be confirmed');
  expect(evidence.nativeMessageId).toMatch(/^transcript:/);
  expect(evidence.nativeMessageId).not.toBe(a.nativeMessageId);
});
it('lets an uncertain paste keep its place, so an identical later send cannot take its record', async () => {
  const h = await claudeSession();
  const fixture = fixtureTerminal('2.1.301', 'empty');
  let enters = 0;
  // The first Enter reaches tmux but reports an error, as when the pane closes its pipe mid-keystroke.
  const flakyEnter: GlossTerminal = {
    ...fixture.terminal,
    pressEnter: async () => {
      await fixture.terminal.pressEnter();
      if (++enters === 1) throw new Error('send-keys failed');
    },
  };
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let secondWaiting = () => {};
  const waiting = new Promise<void>((resolve) => {
    secondWaiting = resolve;
  });
  const { clock } = testClock(async () => {
    secondWaiting();
    await released;
  });
  const connection = await connect(h, flakyEnter, false, clock);
  // The second send may reach the adapter only after the first returned: the first's place outlives its send.
  const first = connection.send('first', 'yes', [], tmux);
  const second = connection.send('second', 'yes', [], tmux);
  expect(await first).toMatchObject({ state: 'unconfirmed', reason: TYPING_UNCERTAIN_REASON });
  await waiting;
  // Claude shows the first paste only now, after the second was typed.
  await recordTyped(h)('yes');
  release();
  expect(await second).toMatchObject({ state: 'unconfirmed', reason: TMUX_UNCONFIRMED_REASON });
  expect(fixture.log.calls.filter((call) => call === 'enter')).toHaveLength(2);
});
it('lets the workflow’s record of an earlier send overrule the adapter’s memory of it', async () => {
  const h = await claudeSession();
  const fixture = fixtureTerminal('2.1.301', 'empty', {
    onEnter: async (text) => {
      if (fixture.log.calls.filter((call) => call === 'enter').length === 2)
        await recordTyped(h)(text);
    },
  });
  let enters = 0;
  const flakyEnter: GlossTerminal = {
    ...fixture.terminal,
    pressEnter: async () => {
      await fixture.terminal.pressEnter();
      if (++enters === 1) throw new Error('send-keys failed');
    },
  };
  const connection = await connect(h, flakyEnter);
  const first = await connection.send('first', 'yes', [], tmux);
  expect(first).toMatchObject({ state: 'unconfirmed', reason: TYPING_UNCERTAIN_REASON });
  // The user released the first one: it no longer waits for a record, so the second may confirm.
  const released: Delivery = {
    ...typedDelivery(h, 'first', 'yes', first.nativeAfterRevision ?? -1),
    state: 'failed',
  };
  expect(
    await connection.send('second', 'yes', [], { ...tmux, earlier: [released] }),
  ).toMatchObject({ state: 'sent' });
});
it('measures the confirmation wait in elapsed time, not in polls', async () => {
  const h = await claudeSession();
  const { terminal } = fixtureTerminal('2.1.301', 'empty');
  let time = 0;
  let sleeps = 0;
  // Each poll interval here takes ten seconds, as after a laptop sleep or a slow transcript read.
  const slow: Clock = {
    now: () => time,
    sleep: async () => {
      sleeps += 1;
      time += 10_000;
    },
  };
  const connection = await connect(h, terminal, false, slow);
  expect(await connection.send('delivery-1', 'Fix it', [], tmux)).toMatchObject({
    state: 'unconfirmed',
    reason: TMUX_UNCONFIRMED_REASON,
  });
  expect(sleeps).toBe(3);
});
it('ends the confirmation wait as unconfirmed when the connection detaches', async () => {
  const h = await claudeSession();
  const { terminal } = fixtureTerminal('2.1.301', 'empty');
  let asleep = () => {};
  const sleeping = new Promise<void>((resolve) => {
    asleep = resolve;
  });
  const { clock, sleeps } = testClock(
    (signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
        asleep();
      }),
  );
  const connection = await connect(h, terminal, false, clock);
  const result = connection.send('delivery-1', 'Fix it', [], tmux);
  await sleeping;
  await connection.detach();
  expect(await result).toMatchObject({ state: 'unconfirmed', reason: TMUX_UNCONFIRMED_REASON });
  expect(sleeps).toHaveLength(1);
});
it('offers no route, without failing, once the session record is gone', async () => {
  const h = await claudeSession();
  const connection = await connect(h, fixtureTerminal('2.1.301', 'empty').terminal);
  await rm(ownRecord(h));
  expect(await connection.deliveryRoute?.()).toEqual({
    transport: null,
    reason: SESSION_GONE_REASON,
  });
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
