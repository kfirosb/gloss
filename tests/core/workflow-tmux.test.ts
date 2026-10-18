import { afterEach, expect, it } from 'vitest';
import { createWorkflow, type Workflow } from '../../src/core/workflow.js';
import {
  CHECKING_TERMINAL_REASON,
  DIALOG_OPEN_REASON,
  NOT_TYPED_AT_RESTART_REASON,
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
const open: Workflow[] = [];
afterEach(async () => {
  for (const workflow of open.splice(0)) await workflow.close();
});
async function terminalApp(
  options: {
    state?: CodingState;
    store?: ConversationStore;
    agent?: FakeAgent;
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
it('hands a terminal send to the adapter while a dialog is open, and keeps a declined one as not sent', async () => {
  const { agent, workflow } = await terminalApp({ state: 'dialog-open' });
  agent.results = [{ state: 'failed', reason: DIALOG_OPEN_REASON, openTerminal: true }];
  expect(await workflow.sendComposer('r1', 'שלום')).toMatchObject({
    state: 'failed',
    reason: DIALOG_OPEN_REASON,
    openTerminal: true,
    transport: 'tmux',
  });
  agent.emit({ type: 'status', state: 'idle' });
  await expect.poll(() => workflow.snapshot().codingState).toBe('idle');
  await workflow.checkComposer('r1');
  expect(agent.sent).toHaveLength(1);
  // The user presses Send again: a new attempt, sent once.
  expect(await workflow.sendComposer('r2', 'שלום')).toMatchObject({ state: 'sent' });
  expect(agent.sent).toHaveLength(2);
});
it('stores a terminal send as being checked until typing starts', async () => {
  const store = new MemoryConversationStore();
  const agent = new FakeAgent('claude');
  let stored: unknown;
  agent.onSend = () => {
    stored = store.load('claude-tmux')?.deliveries[0];
  };
  const { workflow } = await terminalApp({ store, agent });
  await workflow.sendComposer('r1', 'שלום');
  expect(stored).toMatchObject({ state: 'sending', reason: CHECKING_TERMINAL_REASON });
});
it('recovers a terminal send a restart interrupted before typing as not sent, and never types it', async () => {
  const store = new SqliteStore(':memory:');
  const first = new FakeAgent('claude');
  first.onSend = () => new Promise<void>(() => {});
  const app = await terminalApp({ store, agent: first });
  void app.workflow.sendComposer('r1', 'שלום').catch(() => undefined);
  await expect.poll(() => first.sent.length).toBe(1);
  expect(store.load('claude-tmux')?.deliveries[0]).toMatchObject({
    state: 'sending',
    reason: CHECKING_TERMINAL_REASON,
  });
  store.recoverInFlightDeliveries();
  const second = new FakeAgent('claude');
  const restarted = await terminalApp({ store, agent: second });
  expect(restarted.workflow.snapshot().deliveries[0]).toMatchObject({
    state: 'failed',
    reason: NOT_TYPED_AT_RESTART_REASON,
  });
  second.emit({ type: 'status', state: 'working' });
  second.emit({ type: 'status', state: 'idle' });
  await expect.poll(() => restarted.workflow.snapshot().codingState).toBe('idle');
  await restarted.workflow.checkComposer('r1');
  expect(second.sent).toEqual([]);
});
it('lets a review message the terminal declined be sent again, since nothing was typed', async () => {
  const { agent, workflow } = await terminalApp();
  agent.results = [{ state: 'failed', reason: DIALOG_OPEN_REASON, openTerminal: true }];
  await workflow.discuss('Request');
  const draft = await workflow.prepareDirect([0]);
  expect(await workflow.sendReview(draft.id, draft.revision, draft.localizedText)).toMatchObject({
    state: 'failed',
    reason: DIALOG_OPEN_REASON,
  });
  const current = workflow.snapshot().currentDraft;
  if (!current) throw new Error('the review stays open after a declined send');
  expect(
    await workflow.sendReview(current.id, current.revision, current.localizedText),
  ).toMatchObject({ state: 'sent', transport: 'tmux' });
  expect(agent.sent).toHaveLength(2);
});
it('checks a review sent during a dialog at Send on the terminal route, and still blocks it on the channel', async () => {
  const { agent, workflow } = await terminalApp({ state: 'dialog-open' });
  agent.results = [{ state: 'failed', reason: DIALOG_OPEN_REASON, openTerminal: true }];
  await workflow.discuss('Request');
  const draft = await workflow.prepareDirect([0]);
  expect(await workflow.sendReview(draft.id, draft.revision, draft.localizedText)).toMatchObject({
    state: 'failed',
    reason: DIALOG_OPEN_REASON,
    openTerminal: true,
    transport: 'tmux',
  });
  agent.route = { transport: 'channel' };
  const current = workflow.snapshot().currentDraft;
  if (!current) throw new Error('the review stays open after a declined send');
  await expect(
    workflow.sendReview(current.id, current.revision, current.localizedText),
  ).rejects.toThrow('Blocked: agent is working or unavailable');
  expect(agent.sent).toHaveLength(1);
});
it('sends a channel message at once while a terminal send is still in progress', async () => {
  const agent = new FakeAgent('claude');
  agent.onSend = (context) =>
    context?.transport === 'tmux' ? new Promise<void>(() => {}) : undefined;
  const { workflow } = await terminalApp({ agent });
  void workflow.sendComposer('r1', 'ראשון').catch(() => undefined);
  await expect.poll(() => agent.sent.length).toBe(1);
  agent.route = { transport: 'channel' };
  const draft = await workflow.prepare();
  expect(await workflow.send(draft.id, draft.revision)).toMatchObject({
    state: 'sent',
    transport: 'channel',
  });
  expect(agent.sent).toHaveLength(2);
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
it('Reset leaves a review message whose typing started as it is', async () => {
  const agent = new FakeAgent('claude');
  agent.onSend = (context) => {
    context?.onTyping?.({ nativeAfterRevision: 9 });
    return new Promise<void>(() => {});
  };
  const { workflow } = await terminalApp({ agent });
  const draft = await workflow.prepare();
  void workflow.send(draft.id, draft.revision).catch(() => undefined);
  await expect
    .poll(() => workflow.snapshot().deliveries[0])
    .toMatchObject({ state: 'sending', reason: TYPING_STARTED_REASON });
  workflow.resetInstruction(draft.id, draft.revision);
  expect(workflow.snapshot().deliveries[0]).toMatchObject({
    state: 'sending',
    reason: TYPING_STARTED_REASON,
  });
});
it('a terminal send that failed before typing anything is not sent, so it can be sent again', async () => {
  const agent = new FakeAgent('claude');
  agent.sendError = new Error('Session project identity mismatch');
  const { workflow } = await terminalApp({ agent });
  expect(await workflow.sendComposer('r1', 'שלום')).toMatchObject({
    state: 'failed',
    reason: 'Gloss couldn’t reach the terminal; nothing was sent',
  });
});
it('a terminal send that failed after typing started stays unconfirmed', async () => {
  const agent = new FakeAgent('claude');
  agent.onSend = (context) => void context?.onTyping?.({ nativeAfterRevision: 3 });
  agent.sendError = new Error('pane closed');
  const { workflow } = await terminalApp({ agent });
  expect(await workflow.sendComposer('r1', 'שלום')).toMatchObject({
    state: 'unconfirmed',
    nativeAfterRevision: 3,
  });
});
it('an explicit transport never skips the route the session offers', async () => {
  const { agent, workflow } = await terminalApp();
  await expect(workflow.sendComposer('r1', 'שלום', [], 'channel')).rejects.toThrow(
    'Gloss reaches this session another way; nothing was sent',
  );
  const draft = await workflow.prepare();
  await expect(workflow.send(draft.id, draft.revision, 'peer')).rejects.toThrow(
    'Gloss reaches this session another way; nothing was sent',
  );
  agent.route = {
    transport: null,
    reason: 'Claude Desktop sessions can’t receive messages from Gloss.',
  };
  await expect(workflow.sendComposer('r2', 'שלום', [], 'peer')).rejects.toThrow(
    'Claude Desktop sessions can’t receive messages from Gloss.',
  );
  expect(agent.sent).toEqual([]);
  expect(workflow.snapshot().deliveries).toEqual([]);
});
