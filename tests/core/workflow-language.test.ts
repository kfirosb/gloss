import { expect, it, vi } from 'vitest';
import { createWorkflow } from '../../src/core/workflow.js';
import type { LanguageSettings } from '../../src/core/language-settings.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';
import { MemoryConversationStore } from '../helpers/memory-store.js';

const tick = () => new Promise<void>((r) => setTimeout(r, 5));
async function setup(initial: LanguageSettings, capabilities: Record<string, boolean> = {}) {
  let settings = initial;
  const agent = new FakeAgent();
  Object.assign(agent.capabilities, capabilities);
  const language = new FakeLanguageSession();
  const store = new MemoryConversationStore();
  language.translateTransform = (text) => 'תרגום:' + text;
  let n = 0;
  const workflow = createWorkflow({
    conversationId: 'c',
    language: 'he',
    projectContext: '',
    languageModel: 'm',
    languageSession: language,
    agents: [agent],
    store,
    createId: (p) => `${p}-${++n}`,
    languageSettings: () => settings,
  });
  await workflow.connect({ agent: 'codex', sessionRef: 's', projectId: 'p' });
  for (let i = 0; i < 20 && workflow.snapshot().codingState === 'disconnected'; i++) await tick();
  agent.emit({ type: 'status', state: 'idle' });
  await tick();
  return {
    workflow,
    agent,
    language,
    set: (next: LanguageSettings) => {
      settings = next;
      workflow.refreshLanguageSettings();
    },
  };
}
const english = { write: 'en', send: 'en', reply: 'en', assist: 'en' };
const hebrew = { write: 'he', send: 'en', reply: 'he', assist: 'he' };
const reply = (i: number) => ({
  type: 'message' as const,
  message: {
    sourceId: `m${i}`,
    revision: i,
    role: 'assistant' as const,
    text: `Reply ${i}`,
    complete: true,
  },
});

it('does not translate replies when reply language is English', async () => {
  const { workflow, agent, language } = await setup(english);
  agent.emit(reply(1));
  await tick();
  expect(language.translated).toEqual([]);
  expect(workflow.snapshot().languageSettings).toEqual(english);
  expect(workflow.snapshot().codingMessages[0]!.translationStatus).toBeUndefined();
});
it('translates replies into Hebrew under the default settings', async () => {
  const { workflow, agent, language } = await setup(hebrew);
  agent.emit(reply(1));
  await tick();
  await tick();
  expect(language.translatedLanguages).toEqual(['Hebrew']);
  expect(workflow.snapshot().codingMessages[0]!.translationStatus).toBe('complete');
});
it('switching to Hebrew translates at most the 20 most recent replies', async () => {
  const { workflow, agent, language, set } = await setup(english);
  for (let i = 1; i <= 25; i++) agent.emit(reply(i));
  await tick();
  set(hebrew);
  for (let i = 0; i < 40; i++) await tick();
  expect(language.translated).toHaveLength(20);
  expect(language.translated).not.toContain('Reply 5');
  await workflow.translateMessage('m5');
  await tick();
  expect(language.translated).toContain('Reply 5');
});
it('a reply-language change during translation does not show the stale result', async () => {
  const { workflow, agent, language, set } = await setup(hebrew);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  language.translateTransform = undefined;
  language.translationReply = 'תרגום';
  const original = language.translate.bind(language);
  language.translate = async (text: string, lang?: string) => {
    await gate;
    return original(text, lang);
  };
  agent.emit(reply(1));
  await tick();
  set(english);
  release();
  await tick();
  await tick();
  const message = workflow.snapshot().codingMessages[0]!;
  expect(message.translationStatus).not.toBe('complete');
});
it('composer text is sent verbatim when write equals send', async () => {
  const { workflow, agent, language } = await setup(english);
  await workflow.sendComposer('r1', 'Please refactor this');
  expect(language.translated).toEqual([]);
  expect(agent.sent.at(-1)?.englishText).toBe('Please refactor this');
});
it('attachment-only composer with write equal to send makes no translation call', async () => {
  const { workflow, agent, language } = await setup(english, { fileReferences: true });
  const file = {
    id: 'f1',
    sessionId: 'c',
    kind: 'file' as const,
    index: 1,
    name: 'a.txt',
    path: '/tmp/a.txt',
    worktreePath: 'a.txt',
    source: 'upload' as const,
    mime: 'text/plain',
    size: 1,
  };
  await workflow.sendComposer('r2', '', [file]);
  expect(language.translated).toEqual([]);
  expect(agent.sent.at(-1)?.englishText).toBe(
    'Read the referenced files and inspect referenced images.',
  );
});
it('turning reply translation off drops queued translations', async () => {
  const { workflow, agent, language, set } = await setup(hebrew);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const original = language.translate.bind(language);
  language.translate = async (text: string, lang?: string) => {
    await gate;
    return original(text, lang);
  };
  for (let i = 1; i <= 4; i++) agent.emit(reply(i));
  await tick();
  set(english);
  release();
  for (let i = 0; i < 10; i++) await tick();
  expect(language.translated.length).toBeLessThanOrEqual(1);
  expect(
    workflow.snapshot().codingMessages.filter((m) => m.translationStatus === 'pending'),
  ).toEqual([]);
});
it('clears a restored pending translation status when replies are English', async () => {
  const store = new MemoryConversationStore();
  store.save({
    id: 'c',
    codingState: 'disconnected',
    codingMessages: [
      {
        sourceId: 'm1',
        revision: 1,
        role: 'assistant',
        text: 'x',
        complete: true,
        translationStatus: 'pending',
      },
    ],
    discussion: [],
    deliveries: [],
    language: 'he',
    languageSessionId: 'l',
    languageModel: 'm',
    sourceRevision: 0,
  });
  const workflow = createWorkflow({
    conversationId: 'c',
    language: 'he',
    projectContext: '',
    languageModel: 'm',
    languageSession: new FakeLanguageSession(),
    agents: [new FakeAgent()],
    store,
    languageSettings: () => english,
  });
  expect(workflow.snapshot().codingMessages[0]!.translationStatus).toBeUndefined();
});
it('composer text is translated to the send language when write differs', async () => {
  const { workflow, language } = await setup(hebrew);
  await workflow.sendComposer('r1', 'תעשה רפקטור');
  expect(language.translatedLanguages).toEqual(['English']);
});
it('preparation uses assist for review text and send for delivery', async () => {
  const { workflow, language } = await setup({
    write: 'he',
    send: 'en',
    reply: 'en',
    assist: 'he',
  });
  await workflow.discuss('תסביר');
  await workflow.prepare();
  const input = language.inputs.at(-1)!;
  expect(input.language).toBe('he');
  expect(input.deliveryLanguage).toBe('English');
});
it('summaries use the assist language', async () => {
  const { workflow, agent, language } = await setup({
    write: 'en',
    send: 'en',
    reply: 'en',
    assist: 'en',
  });
  agent.emit(reply(1));
  await tick();
  const m = workflow.snapshot().codingMessages[0]!;
  const { createHash } = await import('node:crypto');
  await workflow.summarizeResponse({
    kind: 'coding',
    messageId: m.sourceId,
    contentHash: createHash('sha256').update(m.text).digest('hex'),
  });
  expect(language.summarizedLanguages).toEqual(['en']);
});
it('falls back and logs once when settings cannot be read; sending is never blocked', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const agent = new FakeAgent();
  const language = new FakeLanguageSession();
  const store = new MemoryConversationStore();
  let n = 0;
  language.translateTransform = (text) => 'T:' + text;
  const workflow = createWorkflow({
    conversationId: 'c',
    language: 'he',
    projectContext: '',
    languageModel: 'm',
    languageSession: language,
    agents: [agent],
    store,
    createId: (p) => `${p}-${++n}`,
    languageSettings: () => {
      throw new Error('db locked');
    },
  });
  await workflow.connect({ agent: 'codex', sessionRef: 's', projectId: 'p' });
  for (let i = 0; i < 20 && workflow.snapshot().codingState === 'disconnected'; i++) await tick();
  agent.emit({ type: 'status', state: 'idle' });
  await tick();
  expect(workflow.snapshot().languageSettings).toEqual(hebrew);
  expect(() => workflow.refreshLanguageSettings()).not.toThrow();
  await workflow.sendComposer('r1', 'שלום');
  expect(agent.sent.at(-1)?.englishText).toBe('T:שלום');
  expect(warn).toHaveBeenCalledTimes(1);
  warn.mockRestore();
});
