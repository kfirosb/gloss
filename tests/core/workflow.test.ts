import { describe, expect, it } from 'vitest';
import type { AgentCapabilities } from '../../src/core/contracts.js';
import { createWorkflow } from '../../src/core/workflow.js';
import { createTestWorkflow } from '../helpers/create-test-workflow.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';
import { MemoryConversationStore } from '../helpers/memory-store.js';

describe('portable workflow', () => {
  it('keeps the verified live connection when older history cannot be read', async () => {
    const app = await createTestWorkflow({ target: false });
    const attach = app.agent.attach.bind(app.agent);
    app.agent.attach = async (target) => ({
      ...(await attach(target)),
      history: async () => {
        throw new Error('Transcript record exceeds read bound');
      },
    });
    try {
      await app.workflow.connect({ agent: 'codex', sessionRef: 'large-history', projectId: 'p1' });
      await expect.poll(() => app.workflow.snapshot().codingState).toBe('idle');
      expect(app.workflow.snapshot().sourceGaps?.some((reason) => reason.includes('history'))).toBe(
        true,
      );
      app.agent.emit({
        type: 'message',
        message: {
          sourceId: 'live',
          revision: 1,
          role: 'user',
          text: 'Recent message',
          complete: true,
        },
      });
      await expect
        .poll(() =>
          app.workflow.snapshot().codingMessages.some((message) => message.sourceId === 'live'),
        )
        .toBe(true);
    } finally {
      await app.workflow.close();
    }
  });
  it('preserves discussion identity while streaming and marks only successful replies complete', async () => {
    const app = await createTestWorkflow();
    let release!: () => void;
    app.language.discussGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = app.workflow.discuss('Hello');
    await expect.poll(() => app.workflow.snapshot().discussion.length).toBe(2);
    const reply = app.workflow.snapshot().discussion[1]!;
    expect(reply).toMatchObject({ id: expect.any(String), complete: false });
    expect(app.store.load('conversation-1')!.discussion[1]).toEqual(reply);
    release();
    await pending;
    expect(app.workflow.snapshot().discussion[1]).toMatchObject({
      id: reply.id,
      complete: true,
      text: app.language.discussionReply,
    });
    await app.workflow.close();
  });
  it('removes only the confirmed sent draft and persists its removal', async () => {
    const app = await createTestWorkflow();
    const draft = await app.workflow.prepare();
    await app.workflow.send(draft.id, draft.revision);
    expect(app.workflow.snapshot().currentDraft).toBeUndefined();
    expect(app.store.load('conversation-1')?.currentDraft).toBeUndefined();
    expect(app.workflow.snapshot().deliveries[0]?.state).toBe('sent');
    await app.workflow.close();
  });
  it.each(['queued', 'failed', 'unconfirmed'] as const)(
    'retains the draft when delivery is %s',
    async (state) => {
      const app = await createTestWorkflow({ deliveryResult: { state } });
      const draft = await app.workflow.prepare();
      await app.workflow.send(draft.id, draft.revision);
      expect(app.workflow.snapshot().currentDraft).toEqual(draft);
      await app.workflow.close();
    },
  );
  it('clears a queued draft only on a later sent receipt', async () => {
    const app = await createTestWorkflow({ deliveryResult: { state: 'queued' } });
    const draft = await app.workflow.prepare();
    const receipt = await app.workflow.send(draft.id, draft.revision);
    app.agent.emit({ type: 'delivery', requestId: receipt.id, state: 'sent' });
    await expect.poll(() => app.workflow.snapshot().currentDraft).toBeUndefined();
    expect(app.store.load('conversation-1')?.currentDraft).toBeUndefined();
    await app.workflow.close();
  });
  it('completes the oldest pending Claude channel delivery when a native assistant reply arrives', async () => {
    const agent = new FakeAgent('claude');
    agent.result = { state: 'queued' };
    agent.capabilities.sendWhileBusy = true;
    const language = new FakeLanguageSession();
    language.translationReply = 'Ask Claude';
    const store = new MemoryConversationStore();
    const workflow = createWorkflow({
      conversationId: 'claude-panel',
      language: 'he',
      languageModel: 'test',
      languageSession: language,
      projectContext: '',
      agents: [agent],
      store,
    });
    await workflow.connect({ agent: 'claude', sessionRef: 'claude-session', projectId: 'p1' });
    await expect.poll(() => workflow.snapshot().codingState).toBe('idle');
    await workflow.sendComposer('channel-request', 'Ask Claude', [], 'channel');
    expect(workflow.snapshot().deliveries[0]?.state).toBe('queued');
    agent.emit({
      type: 'message',
      message: {
        sourceId: 'native-answer',
        revision: 1,
        role: 'assistant',
        text: 'Claude answered',
        complete: true,
      },
    });
    await expect.poll(() => workflow.snapshot().deliveries[0]?.state).toBe('sent');
    expect(
      workflow.snapshot().codingMessages.some((message) => message.sourceId === 'native-answer'),
    ).toBe(true);
    await workflow.close();
  });
  it('completes every channel delivery Claude saw during the turn when two messages share one answer', async () => {
    const agent = new FakeAgent('claude');
    agent.result = { state: 'queued' };
    agent.capabilities.sendWhileBusy = true;
    const language = new FakeLanguageSession();
    language.translationReply = 'Ask Claude';
    const workflow = createWorkflow({
      conversationId: 'claude-panel',
      language: 'he',
      languageModel: 'test',
      languageSession: language,
      projectContext: '',
      agents: [agent],
      store: new MemoryConversationStore(),
    });
    await workflow.connect({ agent: 'claude', sessionRef: 'claude-session', projectId: 'p1' });
    await expect.poll(() => workflow.snapshot().codingState).toBe('idle');
    await workflow.sendComposer('first', 'First question', [], 'channel');
    await workflow.sendComposer('second', 'Second question', [], 'channel');
    await workflow.sendComposer('third', 'Third question', [], 'channel');
    const [first, second, third] = workflow.snapshot().deliveries;
    agent.emit({ type: 'channel-seen', requestId: first!.id });
    agent.emit({ type: 'channel-seen', requestId: second!.id });
    agent.emit({
      type: 'message',
      message: {
        sourceId: 'one-answer',
        revision: 1,
        role: 'assistant',
        text: 'Both answered',
        complete: true,
      },
    });
    await expect
      .poll(() => workflow.snapshot().deliveries.map((d) => d.state))
      .toEqual(['sent', 'sent', 'queued']);
    agent.emit({ type: 'channel-seen', requestId: third!.id });
    agent.emit({
      type: 'message',
      message: {
        sourceId: 'next-answer',
        revision: 2,
        role: 'assistant',
        text: 'Third answered',
        complete: true,
      },
    });
    await expect
      .poll(() => workflow.snapshot().deliveries.map((d) => d.state))
      .toEqual(['sent', 'sent', 'sent']);
    await workflow.close();
  });
  describe('Claude channel send while working', () => {
    async function claudeApp(
      state: 'working' | 'approval-required' | 'disconnected',
      capabilities: Partial<AgentCapabilities> = {},
    ) {
      const agent = new FakeAgent('claude');
      agent.result = { state: 'queued' };
      agent.capabilities.channelSendWhileBusy = true;
      Object.assign(agent.capabilities, capabilities);
      const language = new FakeLanguageSession();
      language.translationReply = 'Ask Claude';
      const workflow = createWorkflow({
        conversationId: 'claude-busy',
        language: 'he',
        languageModel: 'test',
        languageSession: language,
        projectContext: '',
        agents: [agent],
        store: new MemoryConversationStore(),
      });
      await workflow.connect({ agent: 'claude', sessionRef: 'claude-session', projectId: 'p1' });
      await expect.poll(() => workflow.snapshot().codingState).toBe('idle');
      agent.emit({ type: 'status', state });
      await expect.poll(() => workflow.snapshot().codingState).toBe(state);
      return { agent, workflow };
    }
    it('allows channel composer send while working and returns queued; a retried request id does not double send', async () => {
      const { agent, workflow } = await claudeApp('working');
      const receipt = await workflow.sendComposer('busy-1', 'Ask Claude', [], 'channel');
      expect(receipt.state).toBe('queued');
      expect(agent.sent).toHaveLength(1);
      // Same request id is idempotent: no second dispatch.
      expect((await workflow.sendComposer('busy-1', 'Ask Claude', [], 'channel')).id).toBe(
        receipt.id,
      );
      expect(agent.sent).toHaveLength(1);
      await workflow.close();
    });
    it('blocks peer composer send while working', async () => {
      const { agent, workflow } = await claudeApp('working');
      await expect(workflow.sendComposer('busy-peer', 'Ask Claude', [], 'peer')).rejects.toThrow(
        'Blocked',
      );
      expect(agent.sent).toEqual([]);
      await workflow.close();
    });
    it('allows peer composer send while working when the agent queues peer messages', async () => {
      const { agent, workflow } = await claudeApp('working', { peerSendWhileBusy: true });
      expect((await workflow.sendComposer('busy-peer-ok', 'Ask Claude', [], 'peer')).state).toBe(
        'queued',
      );
      expect(agent.sent).toHaveLength(1);
      await workflow.close();
    });
    it('blocks channel send for approval-required and disconnected', async () => {
      for (const state of ['approval-required', 'disconnected'] as const) {
        const { agent, workflow } = await claudeApp(state);
        await expect(
          workflow.sendComposer('busy-' + state, 'Ask Claude', [], 'channel'),
        ).rejects.toThrow();
        expect(agent.sent).toEqual([]);
        await workflow.close();
      }
    });
    it('allows prepared review send over channel but not peer while working', async () => {
      const { agent, workflow } = await claudeApp('working');
      const draft = await workflow.prepare();
      await expect(workflow.send(draft.id, draft.revision, 'peer')).rejects.toThrow(
        'Agent is busy',
      );
      const receipt = await workflow.send(draft.id, draft.revision, 'channel');
      expect(receipt.state).toBe('queued');
      expect(agent.sent).toHaveLength(1);
      await workflow.close();
    });
  });
  it('never clears a newer draft when an older queued delivery becomes sent', async () => {
    const app = await createTestWorkflow({ deliveryResult: { state: 'queued' } });
    const draft = await app.workflow.prepare();
    const receipt = await app.workflow.send(draft.id, draft.revision);
    const newer = await app.workflow.prepare();
    app.agent.emit({ type: 'delivery', requestId: receipt.id, state: 'sent' });
    await expect.poll(() => app.workflow.snapshot().deliveries[0]?.state).toBe('sent');
    expect(app.workflow.snapshot().currentDraft).toEqual(newer);
    await app.workflow.close();
  });

  it('ingests bridge messages idempotently and keeps source order', async () => {
    const app = await createTestWorkflow();
    app.workflow.ingestSourceMessage({
      sourceSessionId: 'session-1',
      sourceId: 'm2',
      sequence: 2,
      role: 'assistant',
      text: 'second',
      cursor: 'c2',
    });
    app.workflow.ingestSourceMessage({
      sourceSessionId: 'session-1',
      sourceId: 'm1',
      sequence: 1,
      role: 'user',
      text: 'first',
      cursor: 'c1',
    });
    app.workflow.ingestSourceMessage({
      sourceSessionId: 'session-1',
      sourceId: 'm2',
      sequence: 2,
      role: 'assistant',
      text: 'second',
      cursor: 'c2',
    });
    expect(app.workflow.snapshot().codingMessages.map((message) => message.sourceId)).toEqual([
      'm1',
      'm2',
    ]);
    expect(app.workflow.snapshot().sourceRevision).toBe(2);
    expect(app.workflow.snapshot().sourceCursor).toBe('c2');
  });

  it('replaying the same partial history preserves older messages without advancing source revision', async () => {
    const app = await createTestWorkflow();
    app.agent.historyMessages.set('same', [
      { sourceId: 'older', revision: 1, role: 'user', text: 'older', complete: true },
      { sourceId: 'newer', revision: 1, role: 'assistant', text: 'newer', complete: true },
    ]);
    await app.workflow.connect({ agent: 'codex', sessionRef: 'same', projectId: 'p1' });
    const revision = app.workflow.snapshot().sourceRevision;
    app.agent.historyMessages.set('same', [
      { sourceId: 'newer', revision: 1, role: 'assistant', text: 'newer', complete: true },
    ]);
    await app.workflow.connect({ agent: 'codex', sessionRef: 'same', projectId: 'p1' });
    expect(app.workflow.snapshot().codingMessages.map(({ sourceId }) => sourceId)).toEqual([
      'older',
      'newer',
    ]);
    expect(app.workflow.snapshot().sourceRevision).toBe(revision);
  });

  it('invalidates remembered project notes before the next language operation', async () => {
    const agent = new FakeAgent();
    const language = new FakeLanguageSession();
    const store = new MemoryConversationStore();
    store.writeContext('p1', 'secret note');
    language.retainProjectContext = true;
    const workflow = createWorkflow({
      conversationId: 'dynamic-context',
      language: 'he',
      languageModel: 'm1',
      projectContext: () => store.readContext('p1') ?? '',
      languageSession: language,
      agents: [agent],
      store,
    });
    await workflow.connect({ agent: 'codex', sessionRef: 'session-1', projectId: 'p1' });
    await workflow.discuss('first');
    store.deleteContext('p1');
    await workflow.invalidateProjectContext();
    await workflow.discuss('second');
    expect(language.inputs.at(-1)?.projectContext).toBe('');
    expect(language.resetContextCalls).toBe(1);
    expect(language.retainedProjectContext).toBe('');
  });

  it('resets only after a non-cooperative old-context operation settles', async () => {
    const app = await createTestWorkflow();
    let release!: () => void;
    app.language.ignoreAbort = true;
    app.language.retainProjectContext = true;
    app.language.retainContextOnCompletion = true;
    app.language.discussGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const discussion = app.workflow.discuss('old context work');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const invalidation = app.workflow.invalidateProjectContext();
    expect(app.language.resetContextCalls).toBe(0);
    release();
    await expect(discussion).rejects.toThrow('Project context changed');
    await invalidation;
    expect(app.language.resetContextCalls).toBe(1);
    expect(app.language.retainedProjectContext).toBe('');
    expect(app.workflow.snapshot().discussion.at(-1)).toEqual({
      id: expect.any(String),
      complete: false,
      role: 'assistant',
      text: '',
    });
  });

  it('builds a prepare input after an in-progress context reset', async () => {
    const agent = new FakeAgent();
    const language = new FakeLanguageSession();
    const store = new MemoryConversationStore();
    let context = 'before reset';
    let releaseReset!: () => void;
    language.resetContextGate = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    const workflow = createWorkflow({
      conversationId: 'reset-gate',
      language: 'he',
      languageModel: 'm1',
      projectContext: () => context,
      languageSession: language,
      agents: [agent],
      store,
    });
    await workflow.connect({ agent: 'codex', sessionRef: 'session-1', projectId: 'p1' });
    const invalidation = workflow.invalidateProjectContext();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const preparation = workflow.prepare();
    context = 'after reset';
    expect(language.inputs).toEqual([]);
    releaseReset();
    await invalidation;
    await preparation;
    expect(language.inputs.at(-1)?.projectContext).toBe('after reset');
  });
  it('keeps the newest target when an older connection finishes later', async () => {
    const app = await createTestWorkflow();
    let releaseOld!: () => void;
    app.agent.attachGates.set(
      'old',
      new Promise<void>((resolve) => {
        releaseOld = resolve;
      }),
    );
    app.agent.historyMessages.set('old', [
      {
        sourceId: 'old-message',
        revision: 1,
        role: 'assistant',
        text: 'old',
        complete: true,
      },
    ]);
    app.agent.historyMessages.set('new', [
      {
        sourceId: 'new-message',
        revision: 1,
        role: 'assistant',
        text: 'new',
        complete: true,
      },
    ]);
    const oldConnection = app.workflow.connect({
      agent: 'codex',
      sessionRef: 'old',
      projectId: 'p1',
    });
    await app.workflow.connect({ agent: 'codex', sessionRef: 'new', projectId: 'p1' });
    releaseOld();
    await oldConnection;
    expect(app.workflow.snapshot()).toMatchObject({
      target: { sessionRef: 'new' },
      codingMessages: [{ sourceId: 'new-message', text: 'new' }],
    });
    expect(app.agent.detachedTargets).toContain('old');
  });

  it('does not let stale history overwrite a newer target', async () => {
    const app = await createTestWorkflow();
    let releaseHistory!: () => void;
    app.agent.historyGates.set(
      'old',
      new Promise<void>((resolve) => {
        releaseHistory = resolve;
      }),
    );
    app.agent.historyMessages.set('old', [
      {
        sourceId: 'old-message',
        revision: 1,
        role: 'assistant',
        text: 'old',
        complete: true,
      },
    ]);
    app.agent.historyMessages.set('new', [
      {
        sourceId: 'new-message',
        revision: 1,
        role: 'assistant',
        text: 'new',
        complete: true,
      },
    ]);
    const oldConnection = app.workflow.connect({
      agent: 'codex',
      sessionRef: 'old',
      projectId: 'p1',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await app.workflow.connect({ agent: 'codex', sessionRef: 'new', projectId: 'p1' });
    releaseHistory();
    await oldConnection;
    expect(app.workflow.snapshot().codingMessages.map((message) => message.sourceId)).toEqual([
      'new-message',
    ]);
  });

  it('clears messages when the new target does not expose history', async () => {
    const app = await createTestWorkflow();
    app.agent.historyMessages.set('with-history', [
      {
        sourceId: 'message',
        revision: 1,
        role: 'assistant',
        text: 'history',
        complete: true,
      },
    ]);
    await app.workflow.connect({ agent: 'codex', sessionRef: 'with-history', projectId: 'p1' });
    app.agent.capabilities.history = false;
    await app.workflow.connect({ agent: 'codex', sessionRef: 'without-history', projectId: 'p1' });
    expect(app.workflow.snapshot().codingMessages).toEqual([]);
  });

  it('detaches an attachment that completes after close', async () => {
    const app = await createTestWorkflow();
    let release!: () => void;
    app.agent.attachGates.set(
      'late',
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const connecting = app.workflow.connect({
      agent: 'codex',
      sessionRef: 'late',
      projectId: 'p1',
    });
    await app.workflow.close();
    release();
    await expect(connecting).rejects.toThrow('Workflow is closed');
    expect(app.agent.detachedTargets).toContain('late');
  });

  it('detaches a connection whose history completes after close', async () => {
    const app = await createTestWorkflow();
    let release!: () => void;
    app.agent.historyGates.set(
      'late-history',
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const connecting = app.workflow.connect({
      agent: 'codex',
      sessionRef: 'late-history',
      projectId: 'p1',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await app.workflow.close();
    release();
    await expect(connecting).rejects.toThrow('Workflow is closed');
    expect(app.agent.detachedTargets).toContain('late-history');
  });

  it('ignores a late discussion response after close even if the backend ignores cancellation', async () => {
    const app = await createTestWorkflow();
    let release!: () => void;
    app.language.ignoreAbort = true;
    app.language.discussGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const discussion = app.workflow.discuss('late');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await app.workflow.close();
    release();
    await expect(discussion).rejects.toThrow('Workflow is closed');
    expect(app.workflow.snapshot().discussion.at(-1)).toEqual({
      id: expect.any(String),
      complete: false,
      role: 'assistant',
      text: '',
    });
  });

  it('ignores a late preparation response after close even if the backend ignores cancellation', async () => {
    const app = await createTestWorkflow();
    let release!: () => void;
    app.language.ignoreAbort = true;
    app.language.prepareGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preparation = app.workflow.prepare();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await app.workflow.close();
    release();
    await expect(preparation).rejects.toThrow('Workflow is closed');
    expect(app.workflow.snapshot().currentDraft).toBeUndefined();
  });

  it('ignores a late revision response after close even if the backend ignores cancellation', async () => {
    const app = await createTestWorkflow();
    const draft = await app.workflow.prepare();
    let release!: () => void;
    app.language.ignoreAbort = true;
    app.language.prepareGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revision = app.workflow.reviseDraft(draft.id, 'late revision');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await app.workflow.close();
    release();
    await expect(revision).rejects.toThrow('Workflow is closed');
    expect(app.workflow.snapshot().currentDraft).toEqual(draft);
  });

  it('uses the validated connection acknowledgement when reconnecting during send', async () => {
    const app = await createTestWorkflow();
    const draft = await app.workflow.prepare();
    let release!: () => void;
    app.agent.sendGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sending = app.workflow.send(draft.id, draft.revision);
    app.agent.capabilities.acknowledgement = 'none';
    await app.workflow.connect({ agent: 'codex', sessionRef: 'new', projectId: 'p1' });
    release();
    await expect(sending).resolves.toMatchObject({ state: 'sent' });
  });

  it('keeps concurrent discussion replies paired with their user turns', async () => {
    const app = await createTestWorkflow();
    let release!: () => void;
    app.language.discussGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.language.discussionReply = 'reply';
    const first = app.workflow.discuss('first');
    const second = app.workflow.discuss('second');
    release();
    await Promise.all([first, second]);
    expect(app.workflow.snapshot().discussion.map(({ id, complete, ...turn }) => turn)).toEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'reply' },
      { role: 'user', text: 'second' },
      { role: 'assistant', text: 'reply' },
    ]);
  });

  it('aborts active language work when closed', async () => {
    const app = await createTestWorkflow();
    let release!: () => void;
    app.language.discussGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const discussion = app.workflow.discuss('wait');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await app.workflow.close();
    release();
    await expect(discussion).rejects.toThrow('Aborted');
    expect(app.language.aborted).toBe(true);
  });

  it('does not publish a draft if the target changes while preparation is running', async () => {
    const app = await createTestWorkflow();
    let release!: () => void;
    app.language.prepareGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preparation = app.workflow.prepare();
    await app.workflow.connect({ agent: 'codex', sessionRef: 'other', projectId: 'p1' });
    release();
    await expect(preparation).rejects.toThrow('Target changed');
    expect(app.workflow.snapshot().currentDraft).toBeUndefined();
  });

  it('publishes immutable snapshots as discussion streams', async () => {
    const app = await createTestWorkflow();
    const updates: string[] = [];
    const unsubscribe = app.workflow.subscribe((snapshot) => {
      updates.push(snapshot.discussion.map((turn) => turn.text).join('|'));
      snapshot.discussion.length = 0;
    });
    await app.workflow.discuss('Explain it');
    unsubscribe();
    await app.workflow.prepare();
    expect(updates).toContain('Explain it|הנה הסבר');
    expect(app.workflow.snapshot().discussion.map(({ id, complete, ...turn }) => turn)).toEqual([
      { role: 'user', text: 'Explain it' },
      { role: 'assistant', text: 'הנה הסבר' },
    ]);
  });

  it('discussion and preparation never send a coding instruction', async () => {
    const app = await createTestWorkflow();
    await app.workflow.discuss('Explain the proposed change');
    await app.workflow.prepare();
    expect(app.agent.sent).toEqual([]);
  });

  it('rejects a draft that was not prepared for the connected target', async () => {
    const app = await createTestWorkflow();
    const draft = await app.workflow.prepare();
    await app.workflow.connect({ agent: 'codex', sessionRef: 'other', projectId: 'p1' });
    await expect(app.workflow.send(draft.id, draft.revision)).rejects.toThrow('Target changed');
    expect(app.agent.sent).toEqual([]);
  });

  it('dispatches concurrent duplicate send clicks exactly once', async () => {
    const app = await createTestWorkflow();
    const draft = await app.workflow.prepare();
    let release!: () => void;
    app.agent.sendGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = app.workflow.send(draft.id, draft.revision);
    const duplicate = app.workflow.send(draft.id, draft.revision);
    release();
    const [firstReceipt, duplicateReceipt] = await Promise.all([first, duplicate]);
    expect(app.agent.sent).toHaveLength(1);
    expect(duplicateReceipt.id).toBe(firstReceipt.id);
  });

  it('rejects a stale revision after the draft is revised', async () => {
    const app = await createTestWorkflow();
    const draft = await app.workflow.prepare();
    await app.workflow.reviseDraft(draft.id, 'שנה את ההוראה');
    await expect(app.workflow.send(draft.id, draft.revision)).rejects.toThrow(
      'Stale draft revision',
    );
    expect(app.agent.sent).toEqual([]);
  });

  it('claims and persists sending before transport dispatch', async () => {
    const app = await createTestWorkflow();
    const draft = await app.workflow.prepare();
    await app.workflow.send(draft.id, draft.revision);
    expect(app.store.operationLog).toEqual(
      expect.arrayContaining([`claim:${draft.id}:${draft.revision}`, 'update:sent']),
    );
    expect(app.store.operationLog.indexOf(`claim:${draft.id}:${draft.revision}`)).toBeLessThan(
      app.store.operationLog.indexOf('update:sent'),
    );
  });

  it.each([
    ['approval-required' as const, {}, 'Agent approval is required'],
    ['working' as const, { sendWhileBusy: false }, 'Agent is busy'],
    ['disconnected' as const, {}, 'Agent is disconnected'],
  ])('blocks delivery while coding state is %s', async (codingState, capabilities, message) => {
    const app = await createTestWorkflow({ capabilities });
    const draft = await app.workflow.prepare();
    app.agent.emit({ type: 'status', state: codingState });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await expect(app.workflow.send(draft.id, draft.revision)).rejects.toThrow(message);
    expect(app.agent.sent).toEqual([]);
  });

  it('allows delivery while working when the connection supports queueing', async () => {
    const app = await createTestWorkflow({
      codingState: 'working',
      capabilities: { sendWhileBusy: true },
      deliveryResult: { state: 'queued' },
    });
    const draft = await app.workflow.prepare();
    const receipt = await app.workflow.send(draft.id, draft.revision);
    expect(receipt.state).toBe('queued');
    expect(app.agent.sent).toHaveLength(1);
  });

  it.each(['return', 'throw'] as const)(
    'preserves correlated sent evidence racing a transport %s',
    async (outcome) => {
      const app = await createTestWorkflow({ deliveryResult: { state: 'unconfirmed' } });
      const draft = await app.workflow.prepare();
      let release!: () => void;
      app.agent.sendGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (outcome === 'throw') app.agent.sendError = new Error('late transport error');
      const pending = app.workflow.send(draft.id, draft.revision);
      await expect.poll(() => app.agent.sent.length).toBe(1);
      const requestId = app.agent.sent[0]!.requestId;
      app.agent.emit({ type: 'delivery', requestId, state: 'sent' });
      await expect.poll(() => app.workflow.snapshot().deliveries[0]?.state).toBe('sent');
      release();
      expect((await pending).state).toBe('sent');
      app.agent.emit({ type: 'delivery', requestId, state: 'unconfirmed' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(app.workflow.snapshot().deliveries[0]?.state).toBe('sent');
      await app.workflow.close();
    },
  );
  it('records a definitive transport rejection as failed', async () => {
    const app = await createTestWorkflow({
      deliveryResult: { state: 'failed', reason: 'rejected' },
    });
    const draft = await app.workflow.prepare();
    await expect(app.workflow.send(draft.id, draft.revision)).resolves.toMatchObject({
      state: 'failed',
      reason: 'rejected',
    });
  });

  it('records a post-dispatch transport error as unconfirmed and never retries it', async () => {
    const app = await createTestWorkflow();
    const draft = await app.workflow.prepare();
    app.agent.sendError = new Error('connection lost');
    const first = await app.workflow.send(draft.id, draft.revision);
    const second = await app.workflow.send(draft.id, draft.revision);
    expect(first).toMatchObject({ state: 'unconfirmed', reason: 'connection lost' });
    expect(second).toEqual(first);
    expect(app.agent.sent).toHaveLength(1);
  });

  it('does not claim confirmed delivery when the adapter has no acknowledgement', async () => {
    const app = await createTestWorkflow({ capabilities: { acknowledgement: 'none' } });
    const draft = await app.workflow.prepare();
    const receipt = await app.workflow.send(draft.id, draft.revision);
    expect(receipt.state).toBe('unconfirmed');
  });
});
