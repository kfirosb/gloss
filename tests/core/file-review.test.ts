import { test, expect, vi } from 'vitest';
import { createWorkflow } from '../../src/core/workflow.js';
import type { LanguageSettings } from '../../src/core/language-settings.js';
import { createTestWorkflow } from '../helpers/create-test-workflow.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';
import { MemoryConversationStore } from '../helpers/memory-store.js';
test('file review uses language tools without changing discussion or sending to the coding agent', async () => {
  const app = await createTestWorkflow();
  try {
    const before = app.workflow.snapshot();
    const summary = vi.spyOn(app.language, 'summarize').mockResolvedValue('תקציר');
    const translation = vi.spyOn(app.language, 'translate').mockResolvedValue('תרגום');
    const signal = new AbortController().signal;
    expect(await app.workflow.reviewFileText('Long file', 'summary', signal)).toBe('תקציר');
    expect(summary).toHaveBeenCalledWith('Long file', 'he', expect.any(AbortSignal));
    expect(await app.workflow.reviewFileText('Long file', 'translation', signal)).toBe('תרגום');
    expect(translation).toHaveBeenCalledWith('Long file', 'Hebrew', expect.any(AbortSignal));
    expect(app.workflow.snapshot()).toEqual(before);
    await expect(
      app.workflow.reviewFileText('x'.repeat(160001), 'summary', signal),
    ).rejects.toThrow('160000');
  } finally {
    await app.workflow.close();
  }
});

test('file review is served from the cache per file version, mode and language', async () => {
  const app = await createTestWorkflow();
  try {
    const summary = vi.spyOn(app.language, 'summarize').mockResolvedValue('תקציר');
    const signal = new AbortController().signal;
    const scope = { scope: '/root', path: 'docs/a.md', version: 'v1' };
    expect(app.workflow.fileReviewStatus(scope)).toEqual({ summary: false, translation: false });
    expect(await app.workflow.reviewFileText('Long file', 'summary', signal, scope)).toBe('תקציר');
    expect(await app.workflow.reviewFileText('Long file', 'summary', signal, scope)).toBe('תקציר');
    expect(summary).toHaveBeenCalledTimes(1);
    expect(app.workflow.fileReviewStatus(scope)).toEqual({ summary: true, translation: false });
    await app.workflow.reviewFileText('Long file', 'summary', signal, { ...scope, version: 'v2' });
    expect(summary).toHaveBeenCalledTimes(2);
    await app.workflow.reviewFileText('Long file', 'summary', signal); // no scope: never cached
    expect(summary).toHaveBeenCalledTimes(3);
  } finally {
    await app.workflow.close();
  }
});

test('a cached translation is a miss after the reply language changes', async () => {
  let settings: LanguageSettings = { write: 'he', send: 'en', reply: 'he', assist: 'he' };
  const language = new FakeLanguageSession();
  const translate = vi.spyOn(language, 'translate').mockResolvedValue('תרגום');
  let sequence = 0;
  const workflow = createWorkflow({
    conversationId: 'c',
    language: 'he',
    projectContext: '',
    languageModel: 'm',
    languageSession: language,
    agents: [],
    store: new MemoryConversationStore(),
    createId: (prefix) => `${prefix}-${++sequence}`,
    languageSettings: () => settings,
  });
  try {
    const signal = new AbortController().signal;
    const scope = { scope: '/root', path: 'a.md', version: 'v1' };
    await workflow.reviewFileText('Long file', 'translation', signal, scope);
    await workflow.reviewFileText('Long file', 'translation', signal, scope);
    expect(translate).toHaveBeenCalledTimes(1);
    expect(workflow.fileReviewStatus(scope).translation).toBe(true);
    settings = { ...settings, reply: 'en' };
    workflow.refreshLanguageSettings();
    expect(workflow.fileReviewStatus(scope).translation).toBe(false);
    await workflow.reviewFileText('Long file', 'translation', signal, scope);
    expect(translate).toHaveBeenCalledTimes(2);
  } finally {
    await workflow.close();
  }
});
