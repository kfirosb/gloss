import { expect, it } from 'vitest';
import { createWorkflow } from '../../src/core/workflow.js';
import { translateMessageResult } from '../../src/core/translations.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';

it('retains capabilities, loads older history without duplicates and exposes source gaps', async () => {
  const store = new SqliteStore(':memory:');
  const agent = new FakeAgent();
  const attach = agent.attach.bind(agent);
  agent.attach = async (target) => {
    const connection = await attach(target);
    connection.history = async (cursor) =>
      cursor
        ? {
            messages: [
              { sourceId: 'old', revision: 1, role: 'user', text: 'Older', complete: true },
            ],
          }
        : {
            messages: [
              { sourceId: 'new', revision: 1, role: 'assistant', text: 'Recent', complete: true },
            ],
            next: 'older',
          };
    return connection;
  };
  const workflow = createWorkflow({
    conversationId: 'c',
    language: 'he',
    projectContext: '',
    languageModel: 'm',
    languageSession: new FakeLanguageSession(),
    agents: [agent],
    store,
  });
  try {
    await workflow.connect({ agent: 'codex', sessionRef: 's', projectId: 'p' });
    expect(workflow.snapshot().historyCursor).toBe('older');
    expect(workflow.snapshot().capabilities?.history).toBe(true);
    await workflow.loadOlderHistory();
    expect(workflow.snapshot().codingMessages.map((m) => m.sourceId)).toEqual(['old', 'new']);
    expect(workflow.snapshot().historyCursor).toBeUndefined();
    agent.emit({ type: 'gap', reason: 'Source was truncated' });
    await expect.poll(() => workflow.snapshot().sourceGaps).toContain('Source was truncated');
    expect(store.load('c')?.sourceGaps).toContain('Source was truncated');
  } finally {
    await workflow.close();
    store.close();
  }
});

it('reports failed translation separately, never caches aborts, and removes conversation translation content', async () => {
  const store = new SqliteStore(':memory:');
  const session = new FakeLanguageSession();
  const request = {
    sourceScope: 'c',
    sourceId: 'm',
    sourceRevision: 1,
    text: 'Original',
    complete: true,
    language: 'he',
    model: 'm',
    promptVersion: 'v1',
  };
  try {
    session.translationError = new Error('secret stderr');
    expect(await translateMessageResult(request, { store, session })).toEqual({
      status: 'error',
      text: 'Original',
    });
    delete session.translationError;
    session.translationReply = 'Original';
    expect(await translateMessageResult(request, { store, session })).toEqual({
      status: 'complete',
      text: 'Original',
    });
    store.deleteConversation('c');
    session.translationReply = 'Fresh';
    expect(await translateMessageResult(request, { store, session })).toEqual({
      status: 'complete',
      text: 'Fresh',
    });
    const abort = new AbortController();
    abort.abort();
    expect(
      (
        await translateMessageResult(
          { ...request, sourceId: 'aborted', signal: abort.signal },
          { store, session },
        )
      ).status,
    ).toBe('error');
  } finally {
    store.close();
  }
});
