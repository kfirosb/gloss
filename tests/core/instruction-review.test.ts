import { expect, it, vi } from 'vitest';
import { createTestWorkflow } from '../helpers/create-test-workflow.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';
import { MemoryConversationStore } from '../helpers/memory-store.js';
import { createWorkflow } from '../../src/core/workflow.js';
import type { AgentAdapter } from '../../src/core/contracts.js';

it('frees a handed-off Claude composer before the reply, including after restart, without resending or clearing newer work', async () => {
  const agent = new FakeAgent('claude');
  agent.result = { state: 'queued' };
  const store = new MemoryConversationStore();
  const target = { agent: 'claude' as const, sessionRef: 'native', projectId: 'project' };
  const make = () => {
    const language = new FakeLanguageSession();
    language.translationReply = 'Translated';
    return createWorkflow({
      conversationId: 'panel',
      language: 'he',
      languageModel: 'test',
      languageSession: language,
      projectContext: '',
      agents: [agent],
      store,
    });
  };
  let workflow = make();
  try {
    await workflow.connect(target);
    await expect.poll(() => workflow.snapshot().codingState).toBe('idle');
    const first = await workflow.sendComposer('first', 'First');
    expect(first).toMatchObject({ state: 'queued', transport: 'channel' });
    expect(workflow.snapshot().composerDraft).toBeUndefined();
    expect(store.load('panel')?.composerDraft).toBeUndefined();
    await workflow.close();
    // Simulate stopping after the receipt is saved but before the draft cleanup.
    const interrupted = store.load('panel')!;
    interrupted.composerDraft = {
      id: 'composer-first',
      revision: 1,
      target,
      sourceRevision: 0,
      language: 'he',
      localizedText: 'First',
      englishText: 'Translated',
    };
    store.save(interrupted);
    workflow = make();
    await workflow.connect(target);
    await expect.poll(() => workflow.snapshot().codingState).toBe('idle');
    expect(workflow.snapshot().composerDraft).toBeUndefined();
    expect(await workflow.sendComposer('first', 'First')).toEqual(first);
    expect(agent.sent).toHaveLength(1);
    agent.result = { state: 'unconfirmed' };
    await workflow.sendComposer('second', 'Second');
    agent.emit({ type: 'delivery', requestId: first.id, state: 'sent' });
    await expect.poll(() => workflow.snapshot().deliveries[0]?.state).toBe('sent');
    expect(workflow.snapshot().composerDraft?.id).toBe('composer-second');
    expect(agent.sent).toHaveLength(2);
  } finally {
    await workflow.close();
  }
});

it('completes a queued Claude review without waiting for a reply', async () => {
  const agent = new FakeAgent('claude');
  agent.result = { state: 'queued' };
  const workflow = createWorkflow({
    conversationId: 'panel',
    language: 'he',
    languageModel: 'test',
    languageSession: new FakeLanguageSession(),
    projectContext: '',
    agents: [agent],
    store: new MemoryConversationStore(),
  });
  try {
    await workflow.connect({ agent: 'claude', sessionRef: 'native', projectId: 'project' });
    await expect.poll(() => workflow.snapshot().codingState).toBe('idle');
    await workflow.discuss('Request');
    const draft = await workflow.prepareDirect([0]);
    const receipt = await workflow.sendReview(
      draft.id,
      draft.revision,
      draft.localizedText,
      'channel',
    );
    expect(receipt.state).toBe('queued');
    expect(workflow.snapshot().currentDraft).toBeUndefined();
    expect(
      await workflow.sendReview(draft.id, draft.revision, draft.localizedText, 'channel'),
    ).toEqual(receipt);
    expect(agent.sent).toHaveLength(1);
  } finally {
    await workflow.close();
  }
});

it('persists the Claude route before transport and never reroutes historical request IDs', async () => {
  const agent = new FakeAgent('claude');
  const store = new MemoryConversationStore();
  const attach = agent.attach.bind(agent);
  const adapter: AgentAdapter = agent;
  const observed: unknown[] = [];
  vi.spyOn(adapter, 'attach').mockImplementation(async (target, context) => {
    expect(context).toEqual({ panelSessionId: 'panel' });
    const connection = await attach(target);
    return {
      ...connection,
      async send(id, text, attachments, sendContext) {
        observed.push(sendContext);
        expect(store.load('panel')?.deliveries.at(-1)).toMatchObject({
          id,
          transport: sendContext?.transport,
          state: 'sending',
        });
        return { state: 'unconfirmed', channelGeneration: 'generation-one' };
      },
    };
  });
  const language = new FakeLanguageSession();
  language.translationReply = 'Translated';
  const workflow = createWorkflow({
    conversationId: 'panel',
    language: 'he',
    languageModel: 'test',
    languageSession: language,
    projectContext: '',
    agents: [agent],
    store,
  });
  try {
    await workflow.connect({ agent: 'claude', sessionRef: 'native', projectId: 'project' });
    await expect.poll(() => workflow.snapshot().codingState).toBe('idle');
    const first = await workflow.sendComposer('first', 'First');
    expect(first).toMatchObject({ transport: 'channel', channelGeneration: 'generation-one' });
    expect(await workflow.sendComposer('first', 'First', [], 'peer')).toEqual(first);
    workflow.releaseComposer('first');
    agent.route = { transport: 'peer' };
    const second = await workflow.sendComposer('second', 'Second', [], 'peer');
    expect(second.transport).toBe('peer');
    expect(observed).toEqual([
      { panelSessionId: 'panel', transport: 'channel', earlier: [] },
      { panelSessionId: 'panel', transport: 'peer', earlier: [first] },
    ]);
  } finally {
    await workflow.close();
  }
});

it('orders mixed Claude sources chronologically on connect, live updates and reload without comparing revisions', async () => {
  const agent = new FakeAgent('claude');
  const store = new MemoryConversationStore();
  const target = { agent: 'claude' as const, sessionRef: 'native', projectId: 'project' };
  const native = {
    sourceId: 'native-first',
    revision: 9000,
    role: 'assistant' as const,
    text: 'Native',
    complete: true,
    timestamp: '2026-10-07T10:00:00Z',
  };
  const channel = {
    sourceId: 'channel:g:r',
    revision: 1,
    role: 'assistant' as const,
    text: 'Reply',
    complete: true,
    timestamp: '2026-10-07T10:01:00Z',
  };
  agent.historyMessages.set('native', [channel, native]);
  const make = () =>
    createWorkflow({
      conversationId: 'panel',
      language: 'he',
      languageModel: 'test',
      languageSession: new FakeLanguageSession(),
      projectContext: '',
      agents: [agent],
      store,
    });
  let workflow = make();
  try {
    await workflow.connect(target);
    expect(workflow.snapshot().codingMessages.map((m) => m.sourceId)).toEqual([
      'native-first',
      'channel:g:r',
    ]);
    agent.emit({
      type: 'message',
      message: {
        ...native,
        sourceId: 'native-last',
        revision: 12000,
        timestamp: '2026-10-07T10:02:00Z',
      },
    });
    agent.emit({
      type: 'message',
      message: {
        ...channel,
        sourceId: 'channel:g:r2',
        revision: 2,
        timestamp: '2026-10-07T10:03:00Z',
      },
    });
    agent.emit({ type: 'message', message: { ...channel, revision: 0, text: 'stale' } });
    await expect.poll(() => workflow.snapshot().codingMessages.length).toBe(4);
    await expect
      .poll(() =>
        workflow.snapshot().codingMessages.every((m) => m.translationStatus === 'complete'),
      )
      .toBe(true);
    const ids = ['native-first', 'channel:g:r', 'native-last', 'channel:g:r2'];
    expect(workflow.snapshot().codingMessages.map((m) => m.sourceId)).toEqual(ids);
    expect(workflow.snapshot().codingMessages[1]?.text).toBe('Reply');
    await workflow.close();
    workflow = make();
    await workflow.connect(target);
    expect(workflow.snapshot().codingMessages.map((m) => m.sourceId)).toEqual(ids);
  } finally {
    await workflow.close();
  }
});

it('releases uncertain composer work without resending or losing history, and isolates late receipts', async () => {
  const app = await createTestWorkflow({ deliveryResult: { state: 'unconfirmed' } });
  try {
    app.language.translationReply = 'Translated text';
    const old = await app.workflow.sendComposer('old', 'Old text');
    app.workflow.releaseComposer('wrong');
    expect(app.workflow.snapshot().composerDraft?.id).toBe('composer-old');
    app.workflow.releaseComposer('old');
    expect(app.store.load('conversation-1')?.composerDraft).toBeUndefined();
    expect(app.workflow.snapshot().deliveries).toEqual([old]);
    expect(await app.workflow.sendComposer('old', 'Old text')).toEqual(old);
    await app.workflow.sendComposer('new', 'New text');
    app.agent.emit({ type: 'delivery', requestId: old.id, state: 'sent' });
    await expect.poll(() => app.workflow.snapshot().deliveries[0]?.state).toBe('sent');
    expect(app.workflow.snapshot().composerDraft?.id).toBe('composer-new');
  } finally {
    await app.workflow.close();
  }
});

it('does not release a genuine send in flight or publish a second save after atomic release', async () => {
  const app = await createTestWorkflow({ deliveryResult: { state: 'unconfirmed' } });
  app.language.translationReply = 'Translated';
  let finish!: () => void;
  app.agent.sendGate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const sending = app.workflow.sendComposer('pending', 'Pending');
  try {
    await expect.poll(() => app.agent.sent.length).toBe(1);
    expect(() => app.workflow.releaseComposer('pending')).toThrow('in progress');
    finish();
    await sending;
    const save = vi.spyOn(app.store, 'save').mockImplementation(() => {
      throw new Error('Second persistence after atomic release');
    });
    expect(() => app.workflow.releaseComposer('pending')).not.toThrow();
    expect(app.store.load('conversation-1')?.composerDraft).toBeUndefined();
    save.mockRestore();
  } finally {
    finish();
    await sending;
    await app.workflow.close();
  }
});

it('does not redispatch a failed Claude review through a newly selected route', async () => {
  const agent = new FakeAgent('claude');
  agent.result = { state: 'failed' };
  const workflow = createWorkflow({
    conversationId: 'panel',
    language: 'he',
    languageModel: 'test',
    languageSession: new FakeLanguageSession(),
    projectContext: '',
    agents: [agent],
    store: new MemoryConversationStore(),
  });
  const app = { agent, workflow };
  try {
    await workflow.connect({ agent: 'claude', sessionRef: 'native', projectId: 'project' });
    await expect.poll(() => workflow.snapshot().codingState).toBe('idle');
    await app.workflow.discuss('Request');
    const draft = await app.workflow.prepareDirect([0]);
    const old = await app.workflow.sendReview(
      draft.id,
      draft.revision,
      draft.localizedText,
      'channel',
    );
    expect(
      await app.workflow.sendReview(draft.id, draft.revision, draft.localizedText, 'peer'),
    ).toEqual(old);
    expect(app.agent.sent).toHaveLength(1);
  } finally {
    await app.workflow.close();
  }
});

it('requires channel evidence for a channel delivery even when a peer receipt has the same request ID', async () => {
  const agent = new FakeAgent('claude');
  agent.result = { state: 'unconfirmed' };
  const attach = agent.attach.bind(agent);
  let accepted = false;
  vi.spyOn(agent, 'attach').mockImplementation(async (target) => ({
    ...(await attach(target)),
    reconcileDelivery: async () => accepted,
  }));
  const language = new FakeLanguageSession();
  language.translationReply = 'Translated';
  const workflow = createWorkflow({
    conversationId: 'panel',
    language: 'he',
    languageModel: 'test',
    languageSession: language,
    projectContext: '',
    agents: [agent],
    store: new MemoryConversationStore(),
  });
  try {
    await workflow.connect({ agent: 'claude', sessionRef: 'native', projectId: 'project' });
    await expect.poll(() => workflow.snapshot().codingState).toBe('idle');
    const delivery = await workflow.sendComposer('request', 'Question');
    agent.emit({ type: 'delivery', requestId: delivery.id, state: 'sent' });
    agent.emit({ type: 'status', state: 'working' });
    await expect.poll(() => workflow.snapshot().codingState).toBe('working');
    expect(workflow.snapshot().deliveries[0]?.state).toBe('unconfirmed');
    accepted = true;
    await workflow.checkComposer('request');
    expect(workflow.snapshot().deliveries[0]?.state).toBe('sent');
  } finally {
    await workflow.close();
  }
});

it('prepares selected messages in conversation order without changing Queue', async () => {
  const app = await createTestWorkflow();
  await app.workflow.discuss('First request');
  await app.workflow.discuss('Second request');
  const before = app.workflow.snapshot();
  const review = await app.workflow.prepareReview([3, 0, 3]);
  expect(review.selectedDiscussion).toEqual([0, 3]);
  expect(app.language.inputs.at(-1)?.selectedDiscussion).toEqual([
    before.discussion[0],
    before.discussion[3],
  ]);
  expect(app.workflow.snapshot().currentDraft).toBeUndefined();
  const approved = await app.workflow.approveReview(review.id, '# Edited\n\n- Keep exact edits');
  expect(approved.localizedText).toBe('# Edited\n\n- Keep exact edits');
  expect(approved.englishText).toBe(app.language.prepareResult.englishText);
  expect(app.language.inputs.at(-1)?.reviewText).toBe(approved.localizedText);
  expect(app.language.inputs.at(-1)?.discussion).toEqual([]);
  expect(app.store.load('conversation-1')?.currentDraft?.selectedDiscussion).toEqual([0, 3]);
  await app.workflow.close();
});
it('rejects empty or invalid selections', async () => {
  const app = await createTestWorkflow();
  await expect(app.workflow.prepareReview([])).rejects.toThrow('Select');
  await expect(app.workflow.prepareReview([99])).rejects.toThrow('Select');
  await app.workflow.close();
});
it('requires explicit matching replacement confirmation and rejects stale approval', async () => {
  const app = await createTestWorkflow();
  await app.workflow.discuss('Request');
  const first = await app.workflow.prepareReview([0]);
  const current = await app.workflow.approveReview(first.id, 'Original approved instruction');
  const next = await app.workflow.prepareReview([1]);
  expect(app.workflow.snapshot().currentDraft).toEqual(current);
  await expect(app.workflow.approveReview(next.id, 'Replacement')).rejects.toThrow('Queue changed');
  await expect(
    app.workflow.approveReview(next.id, 'Replacement', { id: current.id, revision: 999 }),
  ).rejects.toThrow('Queue changed');
  expect(
    (
      await app.workflow.approveReview(next.id, 'Replacement', {
        id: current.id,
        revision: current.revision,
      })
    ).englishText,
  ).toBe(app.language.prepareResult.englishText);
  await app.workflow.close();
});
it('preserves queued work on edit or replacement attempts and clears only after Sent', async () => {
  const app = await createTestWorkflow({ deliveryResult: { state: 'queued' } });
  await app.workflow.discuss('Request');
  const review = await app.workflow.prepareReview([0]);
  const approved = await app.workflow.approveReview(review.id, 'Approved');
  const edited = app.workflow.editApproved(
    approved.id,
    approved.revision,
    'Exact edited instruction',
  );
  expect(edited.revision).toBe(2);
  const receipt = await app.workflow.send(edited.id, edited.revision);
  const next = await app.workflow.prepareReview([0]);
  await expect(
    app.workflow.approveReview(next.id, 'Replacement', {
      id: edited.id,
      revision: edited.revision,
    }),
  ).rejects.toThrow('pending');
  expect(() => app.workflow.editApproved(edited.id, edited.revision, 'New edit')).toThrow(
    'unresolved',
  );
  expect(app.workflow.snapshot().currentDraft).toEqual(edited);
  app.agent.emit({ type: 'delivery', requestId: receipt.id, state: 'sent' });
  await expect.poll(() => app.workflow.snapshot().currentDraft).toBeUndefined();
  await app.workflow.close();
});

it('approves the prepared pair without regenerating or accepting client English', async () => {
  const app = await createTestWorkflow();
  await app.workflow.discuss('Request');
  const review = await app.workflow.prepareReview([0]);
  const calls = app.language.inputs.length;
  const approved = await app.workflow.approveReview(review.id, review.localizedText);
  expect(app.language.inputs).toHaveLength(calls);
  expect(approved.localizedText).toBe(review.localizedText);
  expect(approved.englishText).toBe(review.englishText);
  const receipt = await app.workflow.send(approved.id, approved.revision);
  expect(receipt.englishText).toBe(review.englishText);
  await app.workflow.close();
});
it('preserves Queue and review on regeneration failure and permits retry', async () => {
  const app = await createTestWorkflow();
  await app.workflow.discuss('Request');
  const first = await app.workflow.prepareReview([0]);
  const current = await app.workflow.approveReview(first.id, first.localizedText);
  const next = await app.workflow.prepareReview([0]);
  const expected = { id: current.id, revision: current.revision };
  app.language.prepareResult.englishText = '';
  await expect(
    app.workflow.approveReview(next.id, 'Edited localized instruction', expected),
  ).rejects.toThrow('preserved');
  expect(app.workflow.snapshot().currentDraft).toEqual(current);
  app.language.prepareResult.englishText = 'Updated concise instruction';
  const approved = await app.workflow.approveReview(
    next.id,
    'Edited localized instruction',
    expected,
  );
  expect(approved.englishText).toBe('Updated concise instruction');
  expect(approved.localizedText).toBe('Edited localized instruction');
  await app.workflow.close();
});
it('rejects stale replacement confirmation if Queue changes during regeneration', async () => {
  const app = await createTestWorkflow();
  await app.workflow.discuss('Request');
  const first = await app.workflow.prepareReview([0]);
  const current = await app.workflow.approveReview(first.id, first.localizedText);
  const next = await app.workflow.prepareReview([0]);
  let release!: () => void;
  app.language.prepareGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = app.workflow.approveReview(next.id, 'Edited review', {
    id: current.id,
    revision: current.revision,
  });
  await expect.poll(() => app.language.inputs.at(-1)?.reviewText).toBe('Edited review');
  const newer = app.workflow.editApproved(current.id, current.revision, 'Newer Queue content');
  release();
  await expect(pending).rejects.toThrow('Queue changed');
  expect(app.workflow.snapshot().currentDraft).toEqual(newer);
  await app.workflow.close();
});

it('persists a direct review and sends its equivalent English without an approval stage', async () => {
  const app = await createTestWorkflow();
  await app.workflow.discuss('Request');
  const review = await app.workflow.prepareDirect([0]);
  expect(app.store.load('conversation-1')?.currentDraft).toEqual(review);
  app.language.prepareResult.englishText = 'Concise edited request';
  const receipt = await app.workflow.sendReview(
    review.id,
    review.revision,
    'Edited localized review',
  );
  expect(receipt.englishText).toBe('Concise edited request');
  expect(receipt.state).toBe('sent');
  expect(app.workflow.snapshot().currentDraft).toBeUndefined();
  await app.workflow.close();
});
it('requires confirmation before replacing a prepared direct instruction', async () => {
  const app = await createTestWorkflow();
  await app.workflow.discuss('Request');
  const review = await app.workflow.prepareDirect([0]);
  await expect(app.workflow.prepareDirect([1])).rejects.toThrow('Confirm replacement');
  expect(app.workflow.snapshot().currentDraft).toEqual(review);
  const replacement = await app.workflow.prepareDirect([1], {
    id: review.id,
    revision: review.revision,
  });
  expect(replacement.id).not.toBe(review.id);
  await app.workflow.close();
});
it('protects unresolved direct delivery from replacement and duplicate sends', async () => {
  const app = await createTestWorkflow({ deliveryResult: { state: 'queued' } });
  await app.workflow.discuss('Request');
  const review = await app.workflow.prepareDirect([0]);
  const receipt = await app.workflow.sendReview(review.id, review.revision, review.localizedText);
  await expect(
    app.workflow.prepareDirect([0], { id: review.id, revision: review.revision }),
  ).rejects.toThrow('unresolved');
  expect(await app.workflow.sendReview(review.id, review.revision, 'Changed')).toEqual(receipt);
  expect(app.workflow.snapshot().currentDraft).toEqual(review);
  app.agent.emit({ type: 'delivery', requestId: receipt.id, state: 'sent' });
  await expect.poll(() => app.workflow.snapshot().currentDraft).toBeUndefined();
  await app.workflow.close();
});
it('clears a queued direct instruction on its native acceptance receipt', async () => {
  const app = await createTestWorkflow({ deliveryResult: { state: 'queued' } });
  Object.assign(app.agent.result, { nativeMessageId: 'native-receipt' });
  await app.workflow.discuss('Request');
  const review = await app.workflow.prepareDirect([0]);
  const receipt = await app.workflow.sendReview(review.id, review.revision, review.localizedText);
  expect(receipt.nativeMessageId).toBe('native-receipt');
  app.agent.emit({ type: 'delivery', requestId: 'native-receipt', state: 'sent' });
  await expect.poll(() => app.workflow.snapshot().currentDraft).toBeUndefined();
  expect(app.store.load('conversation-1')?.deliveries.at(-1)?.state).toBe('sent');
  await app.workflow.close();
});
it('translates only composer text to English without changing discussion or prepared work', async () => {
  const app = await createTestWorkflow();
  await app.workflow.discuss('Unrelated context');
  await app.workflow.prepareDirect([0]);
  const before = app.workflow.snapshot();
  app.language.translationReply = 'Only the current text';
  expect(await app.workflow.translateComposer('Composer text')).toBe('Only the current text');
  expect(app.language.translated.at(-1)).toBe('Composer text');
  expect(app.workflow.snapshot()).toEqual(before);
  app.language.translationError = new Error('Provider unavailable');
  await expect(app.workflow.translateComposer('Retry text')).rejects.toThrow(
    'Provider unavailable',
  );
  expect(app.workflow.snapshot()).toEqual(before);
  await app.workflow.close();
});
it('sends only composer text without replacing the prepared instruction, and deduplicates retry', async () => {
  const app = await createTestWorkflow({ deliveryResult: { state: 'queued' } });
  await app.workflow.discuss('Unrelated requirements');
  const review = await app.workflow.prepareDirect([0]);
  app.language.translationReply = 'Exact composer translation';
  const receipt = await app.workflow.sendComposer('one', 'Current composer text');
  expect(app.language.translated.at(-1)).toBe('Current composer text');
  expect(receipt.englishText).toBe('Exact composer translation');
  expect(app.workflow.snapshot().currentDraft).toEqual(review);
  expect(await app.workflow.sendComposer('one', 'Current composer text')).toEqual(receipt);
  await expect(app.workflow.sendComposer('two', 'New text')).rejects.toThrow('unresolved');
  app.agent.emit({ type: 'delivery', requestId: receipt.id, state: 'sent' });
  await expect.poll(() => app.workflow.snapshot().composerDraft).toBeUndefined();
  expect(app.workflow.snapshot().currentDraft).toEqual(review);
  await app.workflow.close();
});
it('preserves composer work on failed translation or blocked delivery and allows explicit failed retry', async () => {
  const app = await createTestWorkflow({ deliveryResult: { state: 'failed' } });
  app.language.translationError = new Error('Provider unavailable');
  await expect(app.workflow.sendComposer('first', 'Current text')).rejects.toThrow(
    'Provider unavailable',
  );
  delete app.language.translationError;
  app.language.translationReply = 'Current English text';
  expect((await app.workflow.sendComposer('first', 'Current text')).state).toBe('failed');
  expect(app.workflow.snapshot().composerDraft?.localizedText).toBe('Current text');
  app.agent.result = { state: 'sent' };
  expect((await app.workflow.sendComposer('retry', 'Edited text')).state).toBe('sent');
  expect(app.workflow.snapshot().composerDraft).toBeUndefined();
  await app.workflow.close();
});
it('automatic composer checks never translate, prepare, or send a request', async () => {
  const app = await createTestWorkflow({ deliveryResult: { state: 'queued' } });
  await app.workflow.checkComposer('missing');
  expect(app.language.translated).toHaveLength(0);
  expect(app.workflow.snapshot().deliveries).toHaveLength(0);
  app.language.translationReply = 'English text';
  const receipt = await app.workflow.sendComposer('status-only', 'Composer text');
  for (let i = 0; i < 3; i++) await app.workflow.checkComposer('status-only');
  expect(app.language.translated).toHaveLength(1);
  expect(app.workflow.snapshot().deliveries).toEqual([receipt]);
  expect(app.workflow.snapshot().composerDraft?.localizedText).toBe('Composer text');
  await app.workflow.close();
});
it('allows composer delivery while working only when the adapter supports native queuing', async () => {
  const app = await createTestWorkflow({
    codingState: 'working',
    capabilities: { sendWhileBusy: true },
    deliveryResult: { state: 'queued' },
  });
  app.language.translationReply = 'English test';
  expect((await app.workflow.sendComposer('busy-supported', 'Source test')).state).toBe('queued');
  await app.workflow.close();
});
it('reset detaches the prepared instruction while preserving selections metadata, discussion, and pending delivery', async () => {
  const app = await createTestWorkflow({ deliveryResult: { state: 'queued' } });
  await app.workflow.discuss('Selected requirement');
  const first = await app.workflow.prepareDirect([0]);
  const receipt = await app.workflow.sendReview(first.id, first.revision, first.localizedText);
  const discussion = app.workflow.snapshot().discussion;
  expect(() => app.workflow.resetInstruction(first.id, 99)).toThrow('changed');
  expect(app.workflow.snapshot().currentDraft).toEqual(first);
  app.workflow.resetInstruction(first.id, first.revision);
  expect(app.workflow.snapshot().currentDraft).toBeUndefined();
  expect(app.workflow.snapshot().deliveries).toContainEqual(receipt);
  expect(app.workflow.snapshot().discussion).toEqual(discussion);
  const fresh = await app.workflow.prepareDirect([0]);
  expect(fresh.id).not.toBe(first.id);
  app.agent.emit({ type: 'delivery', requestId: receipt.id, state: 'sent' });
  await expect.poll(() => app.workflow.snapshot().deliveries[0]?.state).toBe('sent');
  expect(app.workflow.snapshot().currentDraft).toEqual(fresh);
  await app.workflow.close();
});
it('preserves image attachments until Sent and sends them separately from translated text', async () => {
  const app = await createTestWorkflow({
    capabilities: { imageAttachments: true },
    deliveryResult: { state: 'queued' },
  });
  app.language.translationReply = 'Use this reference';
  const image = {
    id: 'img',
    name: 'Reference.png',
    mime: 'image/png',
    size: 10,
    path: '/tmp/reference.png',
  };
  const receipt = await app.workflow.sendComposer('images', 'Source text', [image]);
  expect(app.agent.sent[0]?.attachments).toEqual([image]);
  expect(app.agent.sent[0]?.englishText).toBe('Use this reference');
  expect(app.language.translated).toEqual(['Source text']);
  expect(app.workflow.snapshot().composerDraft?.attachments).toEqual([image]);
  expect(receipt.attachments).toEqual([image]);
  await app.workflow.sendComposer('images', 'Source text', [image]);
  expect(app.agent.sent).toHaveLength(1);
  app.agent.emit({ type: 'delivery', requestId: receipt.id, state: 'sent' });
  await expect.poll(() => app.workflow.snapshot().composerDraft).toBeUndefined();
  await app.workflow.close();
});
it('supports image-only sends without inventing a coding task', async () => {
  const app = await createTestWorkflow({ capabilities: { imageAttachments: true } });
  const image = {
    id: 'img',
    name: 'Image.png',
    mime: 'image/png',
    size: 10,
    path: '/tmp/image.png',
  };
  const receipt = await app.workflow.sendComposer('image-only', '', [image]);
  expect(receipt.state).toBe('sent');
  expect(app.language.translated).toHaveLength(0);
  expect(app.agent.sent[0]?.attachments).toEqual([image]);
  await app.workflow.close();
});

it('keeps stable image indices through discussion, selection, review edits and delivery', async () => {
  const app = await createTestWorkflow({ capabilities: { imageAttachments: true } });
  const image = {
    id: 'image-a',
    name: 'Reference.png',
    mime: 'image/png',
    size: 10,
    path: '/tmp/reference.png',
  };
  await app.workflow.discuss('', [image]);
  const indexed = { ...image, index: 1 };
  expect(app.workflow.snapshot().discussion[0]?.attachments).toEqual([indexed]);
  expect(app.workflow.snapshot().discussion[1]?.attachments).toEqual([indexed]);
  await app.workflow.discuss('Use the same image', [image]);
  expect(app.workflow.snapshot().discussion[2]?.attachments).toEqual([indexed]);
  const review = await app.workflow.prepareDirect([3, 0, 1]);
  expect(review.attachments).toEqual([indexed]);
  await app.workflow.sendReview(review.id, review.revision, 'Edited instruction for Image 1');
  expect(app.agent.sent.at(-1)?.attachments).toEqual([indexed]);
  await app.workflow.close();
});

it('does not carry historical images into a new text-only reply or prepared instruction', async () => {
  const app = await createTestWorkflow({ capabilities: { imageAttachments: true } });
  const image = {
    id: 'reference',
    name: 'Reference.png',
    mime: 'image/png',
    size: 10,
    path: '/tmp/reference.png',
  };
  await app.workflow.discuss('First exchange', [image]);
  await app.workflow.discuss('New unrelated request');
  const turns = app.workflow.snapshot().discussion;
  expect(turns[0]?.attachments).toHaveLength(1);
  expect(turns[1]?.attachments).toHaveLength(1);
  expect(turns[2]?.attachments).toBeUndefined();
  expect(turns[3]?.attachments).toBeUndefined();
  expect((await app.workflow.prepareReview([3])).attachments).toBeUndefined();
  expect((await app.workflow.prepareReview([1])).attachments).toHaveLength(1);
  await app.workflow.close();
});
