import { afterEach, expect, it } from 'vitest';
import { createWorkflow, type Workflow } from '../../src/core/workflow.js';
import {
  DIALOG_OPEN_REASON,
  TYPING_STARTED_REASON,
  type CodingState,
  type ConversationStore,
  type Target,
} from '../../src/core/contracts.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';
import { MemoryConversationStore } from '../helpers/memory-store.js';

const target: Target = { agent: 'claude', sessionRef: 'claude-session', projectId: 'p1' };
const UNSENT = 'There is unsent text in the terminal';
const open: Workflow[] = [];
afterEach(async () => {
  for (const workflow of open.splice(0)) await workflow.close();
});
async function terminalApp(
  options: {
    state?: CodingState;
    store?: ConversationStore;
    agent?: FakeAgent;
    heldRecheckMs?: number;
  } = {},
) {
  const agent = options.agent ?? new FakeAgent('claude');
  agent.route ??= { transport: 'tmux' };
  agent.capabilities.tmuxSendWhileBusy = true;
  const language = new FakeLanguageSession();
  language.translationReply = 'Fix the login bug';
  const workflow = createWorkflow({
    conversationId: 'claude-tmux',
    language: 'he',
    languageModel: 'test',
    languageSession: language,
    projectContext: '',
    agents: [agent],
    store: options.store ?? new MemoryConversationStore(),
    heldRecheckMs: options.heldRecheckMs ?? 60_000,
  });
  open.push(workflow);
  await workflow.connect(target);
  await expect.poll(() => workflow.snapshot().codingState).toBe('idle');
  if (options.state && options.state !== 'idle') {
    agent.emit({ type: 'status', state: options.state });
    await expect.poll(() => workflow.snapshot().codingState).toBe(options.state);
  }
  return { agent, workflow };
}
const composerDelivery = (workflow: Workflow, requestId: string) =>
  workflow.snapshot().deliveries.find((d) => d.draftId === `composer-${requestId}`);

it('sends through the route the session offers and records it on the delivery', async () => {
  const { agent, workflow } = await terminalApp();
  expect(await workflow.sendComposer('r1', 'תקן את הבאג')).toMatchObject({
    transport: 'tmux',
    state: 'sent',
  });
  expect(agent.contexts[0]).toMatchObject({ transport: 'tmux', earlier: [] });
});
it('refuses a send when the session has no route, before anything is claimed', async () => {
  const agent = new FakeAgent('claude');
  agent.route = { transport: null, reason: 'Gloss can’t reach this session yet.' };
  const { workflow } = await terminalApp({ agent });
  await expect(workflow.sendComposer('r1', 'שלום')).rejects.toThrow(
    'Gloss can’t reach this session yet.',
  );
  expect(agent.sent).toEqual([]);
  expect(workflow.snapshot().deliveries).toEqual([]);
  expect(await workflow.deliveryRoute()).toEqual(agent.route);
});
it('holds a terminal send while a dialog is open and types it once after the dialog closes', async () => {
  const { agent, workflow } = await terminalApp({ state: 'dialog-open' });
  expect(await workflow.sendComposer('r1', 'שלום')).toMatchObject({
    state: 'held',
    reason: DIALOG_OPEN_REASON,
    transport: 'tmux',
  });
  expect(agent.sent).toEqual([]);
  agent.emit({ type: 'status', state: 'idle' });
  await expect.poll(() => composerDelivery(workflow, 'r1')?.state).toBe('sent');
  agent.emit({ type: 'status', state: 'working' });
  agent.emit({ type: 'status', state: 'idle' });
  await workflow.checkComposer('r1');
  expect(agent.sent).toHaveLength(1);
});
it('keeps a message the terminal check held and sends it once when Check delivery finds the terminal clear', async () => {
  const { agent, workflow } = await terminalApp();
  agent.results = [{ state: 'held', reason: UNSENT }];
  expect(await workflow.sendComposer('r1', 'שלום')).toMatchObject({
    state: 'held',
    reason: UNSENT,
  });
  await workflow.checkComposer('r1');
  expect(composerDelivery(workflow, 'r1')?.state).toBe('sent');
  await workflow.checkComposer('r1');
  const id = composerDelivery(workflow, 'r1')?.id;
  expect(agent.sent.map((s) => s.requestId)).toEqual([id, id]);
});
it('Don’t send cancels a held message so no later check can type it', async () => {
  const { agent, workflow } = await terminalApp({ state: 'dialog-open' });
  await workflow.sendComposer('r1', 'שלום');
  workflow.releaseComposer('r1');
  expect(composerDelivery(workflow, 'r1')).toMatchObject({
    state: 'failed',
    reason: 'Not sent: released before Gloss typed it',
  });
  agent.emit({ type: 'status', state: 'idle' });
  await expect.poll(() => workflow.snapshot().codingState).toBe('idle');
  // Check delivery dispatches a message that is still held, so this would type it if release had not cancelled it.
  await workflow.checkComposer('r1');
  expect(agent.sent).toEqual([]);
});
it('a later send waits behind a held one and both reach the session in order', async () => {
  const { agent, workflow } = await terminalApp();
  agent.results = [{ state: 'held', reason: UNSENT }];
  await workflow.sendComposer('r1', 'ראשון');
  const draft = await workflow.prepare();
  expect(await workflow.send(draft.id, draft.revision)).toMatchObject({
    state: 'held',
    reason: 'Waiting for an earlier message to reach the terminal',
  });
  expect(agent.sent).toHaveLength(1);
  await workflow.checkComposer('r1');
  await expect
    .poll(() => workflow.snapshot().deliveries.map((d) => d.state))
    .toEqual(['sent', 'sent']);
  const [first, second] = workflow.snapshot().deliveries.map((d) => d.id);
  expect(agent.sent.map((s) => s.requestId)).toEqual([first, first, second]);
});
it('a held terminal message keeps its route even when the session later offers another', async () => {
  const { agent, workflow } = await terminalApp({ state: 'dialog-open' });
  await workflow.sendComposer('r1', 'שלום');
  agent.route = { transport: 'channel' };
  agent.emit({ type: 'status', state: 'idle' });
  await expect.poll(() => agent.contexts.length).toBe(1);
  expect(agent.contexts[0]?.transport).toBe('tmux');
});
it('passes earlier deliveries to confirmation and keeps the transcript record that confirmed a send', async () => {
  const agent = new FakeAgent('claude');
  const seen: string[][] = [];
  agent.reconcile = (delivery, earlier) => {
    seen.push(earlier.map((d) => d.id));
    return { nativeMessageId: 'transcript:' + delivery.id };
  };
  agent.result = { state: 'unconfirmed', reason: 'not yet' };
  const { workflow } = await terminalApp({ agent });
  const first = await workflow.sendComposer('r1', 'שלום');
  expect(first).toMatchObject({ state: 'sent', nativeMessageId: 'transcript:' + first.id });
  const second = await workflow.sendComposer('r2', 'שלום');
  expect(second.state).toBe('sent');
  expect(seen.at(-1)).toEqual([first.id]);
});
it('re-checks a held message on its own timer', async () => {
  const { agent, workflow } = await terminalApp({ heldRecheckMs: 5 });
  agent.results = [{ state: 'held', reason: UNSENT }];
  await workflow.sendComposer('r1', 'שלום');
  await expect.poll(() => composerDelivery(workflow, 'r1')?.state).toBe('sent');
  expect(agent.sent).toHaveLength(2);
});
it('a re-check that finds the terminal unchanged writes and broadcasts nothing', async () => {
  const store = new MemoryConversationStore();
  const { agent, workflow } = await terminalApp({ store });
  agent.results = [
    { state: 'held', reason: UNSENT },
    { state: 'held', reason: UNSENT },
  ];
  await workflow.sendComposer('r1', 'שלום');
  let broadcasts = 0;
  const unsubscribe = workflow.subscribe(() => (broadcasts += 1));
  broadcasts = 0;
  const writes = store.operationLog.length;
  await workflow.checkComposer('r1');
  unsubscribe();
  expect(agent.sent).toHaveLength(2);
  expect(composerDelivery(workflow, 'r1')).toMatchObject({ state: 'held', reason: UNSENT });
  expect(store.operationLog.slice(writes)).toEqual([]);
  expect(broadcasts).toBe(0);
});
it('a message stays held and Don’t send still works while the terminal is being checked again', async () => {
  const { agent, workflow } = await terminalApp();
  agent.results = [
    { state: 'held', reason: UNSENT },
    { state: 'failed', reason: 'Gloss couldn’t prepare the paste; nothing was typed' },
  ];
  await workflow.sendComposer('r1', 'שלום');
  let finishCheck = () => {};
  const checkFinished = new Promise<void>((resolve) => (finishCheck = resolve));
  let typing: 'refused' | 'allowed' | undefined;
  agent.onSend = async (context) => {
    await checkFinished;
    try {
      context?.onTyping?.({ nativeAfterRevision: 7 });
      typing = 'allowed';
    } catch {
      typing = 'refused';
    }
  };
  const check = workflow.checkComposer('r1');
  await expect.poll(() => agent.sent.length).toBe(2);
  expect(composerDelivery(workflow, 'r1')).toMatchObject({ state: 'held', reason: UNSENT });
  workflow.releaseComposer('r1');
  finishCheck();
  await check;
  expect(typing).toBe('refused');
  expect(composerDelivery(workflow, 'r1')).toMatchObject({
    state: 'failed',
    reason: 'Not sent: released before Gloss typed it',
  });
  expect(workflow.snapshot().composerDraft).toBeUndefined();
});
it('never types a message again after a restart that interrupted its typing', async () => {
  const store = new SqliteStore(':memory:');
  const first = new FakeAgent('claude');
  first.onSend = (context) => {
    context?.onTyping?.({ nativeAfterRevision: 42 });
    return new Promise<void>(() => {});
  };
  const app = await terminalApp({ store, agent: first });
  void app.workflow.sendComposer('r1', 'שלום').catch(() => undefined);
  await expect
    .poll(() => store.load('claude-tmux')?.deliveries[0])
    .toMatchObject({ state: 'sending', reason: TYPING_STARTED_REASON, nativeAfterRevision: 42 });
  store.recoverInFlightDeliveries();
  const second = new FakeAgent('claude');
  const restarted = await terminalApp({ store, agent: second });
  expect(restarted.workflow.snapshot().deliveries[0]).toMatchObject({
    state: 'unconfirmed',
    nativeAfterRevision: 42,
  });
  await restarted.workflow.checkComposer('r1');
  expect(second.sent).toEqual([]);
});
it('sends a message that was still being checked at a restart exactly once after it', async () => {
  const store = new SqliteStore(':memory:');
  const first = new FakeAgent('claude');
  first.onSend = () => new Promise<void>(() => {});
  const app = await terminalApp({ store, agent: first });
  void app.workflow.sendComposer('r1', 'שלום').catch(() => undefined);
  await expect.poll(() => first.sent.length).toBe(1);
  expect(store.load('claude-tmux')?.deliveries[0]).toMatchObject({ state: 'held' });
  store.recoverInFlightDeliveries();
  const second = new FakeAgent('claude');
  const restarted = await terminalApp({ store, agent: second });
  await expect.poll(() => restarted.workflow.snapshot().deliveries[0]?.state).toBe('sent');
  await restarted.workflow.checkComposer('r1');
  expect(second.sent).toHaveLength(1);
});
it('never sends a channel message again after a restart that interrupted it behind a held one', async () => {
  const store = new SqliteStore(':memory:');
  const first = new FakeAgent('claude');
  first.results = [{ state: 'held', reason: UNSENT }];
  first.onSend = (context) =>
    context?.transport === 'channel' ? new Promise<void>(() => {}) : undefined;
  const app = await terminalApp({ store, agent: first });
  await app.workflow.sendComposer('r1', 'ראשון');
  const draft = await app.workflow.prepare();
  expect(await app.workflow.send(draft.id, draft.revision, 'channel')).toMatchObject({
    state: 'held',
    transport: 'channel',
  });
  void app.workflow.checkComposer('r1');
  await expect.poll(() => first.sent.length).toBe(3);
  expect(store.load('claude-tmux')?.deliveries.map((d) => d.state)).toEqual(['sent', 'sending']);
  store.recoverInFlightDeliveries();
  const second = new FakeAgent('claude');
  const restarted = await terminalApp({ store, agent: second });
  expect(restarted.workflow.snapshot().deliveries[1]).toMatchObject({
    state: 'unconfirmed',
    transport: 'channel',
  });
  second.emit({ type: 'status', state: 'working' });
  second.emit({ type: 'status', state: 'idle' });
  await expect.poll(() => restarted.workflow.snapshot().codingState).toBe('idle');
  expect(second.sent).toEqual([]);
});
