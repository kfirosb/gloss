import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createTestWorkflow } from '../helpers/create-test-workflow.js';
import { createWorkflow } from '../../src/core/workflow.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';
import { SUMMARY_PROMPT_VERSION } from '../../src/core/response-summaries.js';
const source = (text = 'Original response') => ({
  kind: 'coding' as const,
  messageId: 'reply',
  contentHash: createHash('sha256').update(text).digest('hex'),
});
it('uses the effective model after restart for cache reads and new writes', async () => {
  const app = await setup();
  await app.workflow.summarizeResponse(source());
  await app.workflow.close();
  const language = new FakeLanguageSession();
  const summarize = vi.spyOn(language, 'summarize').mockResolvedValue('מודל חדש');
  const reopened = createWorkflow({
    conversationId: 'conversation-1',
    language: 'he',
    languageModel: 'new-model',
    languageSession: language,
    projectContext: '',
    agents: [],
    store: app.store,
  });
  expect((await reopened.summarizeResponse(source())).text).toBe('מודל חדש');
  expect(summarize).toHaveBeenCalledTimes(1);
  const key = {
    ...source(),
    sessionId: 'conversation-1',
    language: 'he' as const,
    model: 'new-model',
    promptVersion: SUMMARY_PROMPT_VERSION,
  };
  expect(app.store.getSummary(key)).toBe('מודל חדש');
  expect(app.store.getSummary({ ...key, model: 'test-model' })).toBe('תקציר');
  await reopened.summarizeResponse(source());
  expect(summarize).toHaveBeenCalledTimes(1);
  await reopened.close();
});
async function setup() {
  const app = await createTestWorkflow();
  app.workflow.ingestSourceMessage({
    sourceSessionId: 'session-1',
    sourceId: 'reply',
    sequence: 1,
    role: 'assistant',
    text: 'Original response',
    complete: true,
  });
  await expect
    .poll(() => app.workflow.snapshot().codingMessages[0]?.translationStatus)
    .toBe('complete');
  return app;
}
it('summarizes immutable completed sources once and caches successful requests', async () => {
  const app = await setup();
  const summarize = vi.spyOn(app.language, 'summarize');
  const before = app.workflow.snapshot();
  const [a, b] = await Promise.all([
    app.workflow.summarizeResponse(source()),
    app.workflow.summarizeResponse(source()),
  ]);
  expect(a).toEqual(b);
  expect(a.text).toBe('תקציר');
  await app.workflow.summarizeResponse(source());
  expect(summarize).toHaveBeenCalledTimes(1);
  expect(app.workflow.snapshot()).toEqual(before);
  await app.workflow.close();
});
it('rejects missing foreign stale user partial and oversized sources', async () => {
  const app = await setup();
  for (const invalid of [
    { ...source(), messageId: 'foreign' },
    source('stale'),
    { ...source(), kind: 'discussion' as const },
  ])
    await expect(app.workflow.summarizeResponse(invalid)).rejects.toThrow();
  for (const message of [
    { role: 'user' as const, complete: true, text: 'Original response' },
    { role: 'assistant' as const, complete: false, text: 'Original response' },
    { role: 'assistant' as const, complete: true, text: 'word '.repeat(32001) },
  ]) {
    app.workflow.ingestSourceMessage({
      sourceSessionId: 'session-1',
      sourceId: 'reply',
      sequence: app.workflow.snapshot().sourceRevision + 1,
      ...message,
    });
    await expect(app.workflow.summarizeResponse(source(message.text))).rejects.toThrow();
  }
  await app.workflow.close();
});
it('rejects stale completion and retries provider failures without caching them', async () => {
  const app = await setup();
  let release!: (text: string) => void;
  const summarize = vi.spyOn(app.language, 'summarize').mockImplementationOnce(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const pending = app.workflow.summarizeResponse(source());
  await expect.poll(() => typeof release).toBe('function');
  app.workflow.ingestSourceMessage({
    sourceSessionId: 'session-1',
    sourceId: 'reply',
    sequence: 2,
    role: 'assistant',
    text: 'Changed',
    complete: true,
  });
  release('תקציר');
  await expect(pending).rejects.toThrow();
  summarize.mockRejectedValueOnce(new Error('retry'));
  await expect(app.workflow.summarizeResponse(source('Changed'))).rejects.toThrow('retry');
  expect((await app.workflow.summarizeResponse(source('Changed'))).text).toBe('תקציר');
  await app.workflow.close();
});
it('rejects empty oversized output and late completions after close', async () => {
  const app = await setup();
  const summarize = vi.spyOn(app.language, 'summarize');
  for (const text of ['', 'x'.repeat(4001)]) {
    summarize.mockResolvedValueOnce(text);
    await expect(app.workflow.summarizeResponse(source())).rejects.toThrow();
  }
  let release!: (text: string) => void;
  summarize.mockImplementationOnce(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const pending = app.workflow.summarizeResponse(source());
  await expect.poll(() => typeof release).toBe('function');
  await app.workflow.close();
  release('תקציר');
  await expect(pending).rejects.toThrow();
});
