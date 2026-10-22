import { expect, it } from 'vitest';
import { createWorkflow } from '../../src/core/workflow.js';
import type { AgentMessage } from '../../src/core/contracts.js';
import {
  effectiveLanguageSettings,
  type LanguageOverride,
  type LanguageSettings,
} from '../../src/core/language-settings.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';
import { MemoryConversationStore } from '../helpers/memory-store.js';

const tick = () => new Promise<void>((r) => setTimeout(r, 5));
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};
const hebrew: LanguageSettings = { write: 'he', send: 'en', reply: 'he', assist: 'he' };
const french: LanguageSettings = { ...hebrew, reply: 'fr' };
const reading: LanguageSettings = { ...hebrew, translateOnlyWhileReading: true };
const message = (i: number): AgentMessage => ({
  sourceId: `m${i}`,
  revision: i,
  role: 'assistant',
  text: `Reply ${i}`,
  complete: true,
});
const reply = (i: number) => ({ type: 'message' as const, message: message(i) });

/** A connected Codex workflow whose effective settings come from a global default and a session override. */
async function setup(
  defaults: LanguageSettings,
  history: AgentMessage[] = [],
  override: LanguageOverride = {},
) {
  let current = { defaults, override };
  const agent = new FakeAgent();
  agent.historyMessages.set('s', history);
  const language = new FakeLanguageSession();
  language.translateTransform = (text) => 'תרגום:' + text;
  const workflow = createWorkflow({
    conversationId: 'c',
    language: 'he',
    projectContext: '',
    languageModel: 'm',
    languageSession: language,
    agents: [agent],
    store: new MemoryConversationStore(),
    languageSettings: () => effectiveLanguageSettings(current.defaults, current.override),
  });
  await workflow.connect({ agent: 'codex', sessionRef: 's', projectId: 'p' });
  for (let i = 0; i < 20 && workflow.snapshot().codingState === 'disconnected'; i++) await tick();
  agent.emit({ type: 'status', state: 'idle' });
  await settle();
  const status = (id: string) =>
    workflow.snapshot().codingMessages.find((m) => m.sourceId === id)?.translationStatus;
  return {
    workflow,
    agent,
    language,
    status,
    change(next: Partial<typeof current>) {
      current = { ...current, ...next };
      workflow.refreshLanguageSettings();
    },
  };
}

it('with the setting on, a session shown in Terminal translates nothing', async () => {
  const { workflow, agent, language, status } = await setup(reading);
  workflow.setConversationView('terminal');
  agent.emit(reply(1));
  agent.emit(reply(2));
  await settle();
  expect(language.translated).toEqual([]);
  // Deliberately skipped replies are not pending, so no "Translating…" placeholder shows for them.
  expect(status('m1')).toBeUndefined();
  expect(status('m2')).toBeUndefined();
});

it('with the setting on, an unreported view and Original or Activity translate nothing', async () => {
  const { workflow, agent, language } = await setup(reading);
  agent.emit(reply(1));
  await settle();
  workflow.setConversationView('original');
  agent.emit(reply(2));
  await settle();
  workflow.setConversationView('activity');
  agent.emit(reply(3));
  await settle();
  expect(language.translated).toEqual([]);
});

it('switching to Translated translates only the latest skipped reply', async () => {
  const { workflow, agent, language, status } = await setup(reading);
  workflow.setConversationView('terminal');
  for (let i = 1; i <= 3; i++) agent.emit(reply(i));
  await settle();
  workflow.setConversationView('translated');
  await settle();
  expect(language.translated).toEqual(['Reply 3']);
  expect(status('m3')).toBe('complete');
  expect(status('m1')).toBeUndefined();
  // Switching again does not translate anything twice.
  workflow.setConversationView('terminal');
  workflow.setConversationView('translated');
  await settle();
  expect(language.translated).toEqual(['Reply 3']);
});

it('Split counts as reading translated', async () => {
  const { workflow, agent, language, status } = await setup(reading);
  workflow.setConversationView('split');
  agent.emit(reply(1));
  await settle();
  expect(language.translated).toEqual(['Reply 1']);
  expect(status('m1')).toBe('complete');
});

it('the attach catch-up translates only the latest reply, and only once the view is translated', async () => {
  const { workflow, language, status } = await setup(reading, [message(1), message(2)]);
  expect(language.translated).toEqual([]);
  workflow.setConversationView('translated');
  await settle();
  expect(language.translated).toEqual(['Reply 2']);
  expect(status('m1')).toBeUndefined();
});

it('a reply-language change re-translates only the latest reply while reading', async () => {
  const { workflow, agent, language, change } = await setup(reading);
  workflow.setConversationView('translated');
  for (let i = 1; i <= 3; i++) agent.emit(reply(i));
  await settle();
  expect(language.translatedLanguages).toEqual(['Hebrew', 'Hebrew', 'Hebrew']);
  change({ defaults: { ...french, translateOnlyWhileReading: true } });
  await settle();
  expect(language.translatedLanguages).toEqual(['Hebrew', 'Hebrew', 'Hebrew', 'French']);
  expect(language.translated.at(-1)).toBe('Reply 3');
});

it('a reply-language change while in Terminal translates nothing', async () => {
  const { workflow, agent, language, change } = await setup(reading);
  workflow.setConversationView('terminal');
  agent.emit(reply(1));
  await settle();
  change({ defaults: { ...french, translateOnlyWhileReading: true } });
  await settle();
  expect(language.translated).toEqual([]);
});

it('the Translate button works from any view', async () => {
  const { workflow, agent, language, status } = await setup(reading);
  workflow.setConversationView('terminal');
  agent.emit(reply(1));
  agent.emit(reply(2));
  await settle();
  await workflow.translateMessage('m1');
  await settle();
  expect(language.translated).toEqual(['Reply 1']);
  expect(status('m1')).toBe('complete');
  expect(status('m2')).toBeUndefined();
});

it('with the setting off, every reply is translated whatever the view, as before', async () => {
  const { workflow, agent, language, change } = await setup(hebrew, [message(1), message(2)]);
  await settle();
  expect(language.translated).toEqual(['Reply 2', 'Reply 1']);
  workflow.setConversationView('terminal');
  agent.emit(reply(3));
  await settle();
  expect(language.translated).toContain('Reply 3');
  change({ defaults: french });
  for (let i = 0; i < 10 && language.translatedLanguages.length < 6; i++) await tick();
  expect(language.translatedLanguages.filter((l) => l === 'French')).toHaveLength(3);
});

it('turning the setting off translates the skipped latest reply and every later one', async () => {
  const { workflow, agent, language, change } = await setup(reading);
  workflow.setConversationView('terminal');
  agent.emit(reply(1));
  agent.emit(reply(2));
  await settle();
  change({ defaults: hebrew });
  await settle();
  expect(language.translated).toEqual(['Reply 2']);
  agent.emit(reply(3));
  await settle();
  expect(language.translated).toEqual(['Reply 2', 'Reply 3']);
});

it('the per-session override wins over the global default', async () => {
  const off = await setup(reading, [], { translateOnlyWhileReading: false });
  off.workflow.setConversationView('terminal');
  off.agent.emit(reply(1));
  await settle();
  expect(off.language.translated).toEqual(['Reply 1']);

  const on = await setup(hebrew, [], { translateOnlyWhileReading: true });
  on.workflow.setConversationView('terminal');
  on.agent.emit(reply(1));
  await settle();
  expect(on.language.translated).toEqual([]);
});

it('rejects an unknown conversation view', async () => {
  const { workflow } = await setup(reading);
  expect(() => workflow.setConversationView('history' as never)).toThrow(
    'Unknown conversation view',
  );
});
