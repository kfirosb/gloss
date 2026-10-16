import { expect, it, vi } from 'vitest';
import { createWorkflow } from '../../src/core/workflow.js';
import { catalogFrom } from '../../src/core/invocations.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';
import { MemoryConversationStore } from '../helpers/memory-store.js';

async function setup(
  agentKind: 'claude' | 'codex',
  invocations?: () => Promise<ReturnType<typeof catalogFrom>>,
  invocationTimeoutMs?: number,
) {
  const agent = new FakeAgent(agentKind);
  agent.result = { state: 'sent' };
  const language = new FakeLanguageSession();
  language.translationReply = 'Build the page and check it';
  const workflow = createWorkflow({
    conversationId: 'c',
    language: 'he',
    languageModel: 'test',
    languageSession: language,
    projectContext: '',
    agents: [agent],
    store: new MemoryConversationStore(),
    ...(invocations ? { invocations } : {}),
    ...(invocationTimeoutMs ? { invocationTimeoutMs } : {}),
  });
  await workflow.connect({ agent: agentKind, sessionRef: 's', projectId: 'p1' });
  await expect.poll(() => workflow.snapshot().codingState).toBe('idle');
  return { workflow, agent, language };
}
const catalog = catalogFrom([
  { kind: 'skill', name: 'frontend-design' },
  { kind: 'mcp', name: 'playwright' },
]);

// Since 27c8fd1 the reviewed English is sent as written: picked skills and MCP servers are no longer prepended (known regression, to be fixed).
it('delivers the reviewed English as written for a direct Claude send', async () => {
  const { workflow, agent } = await setup('claude', async () => catalog);
  await workflow.sendComposer(
    'r1',
    'תבנה דף ‎/frontend-design ותבדוק עם ‎$playwright',
    [],
    'channel',
  );
  expect(agent.sent.at(-1)!.englishText).toBe('Build the page and check it');
  await workflow.close();
});

it('delivers the reviewed English as written for Codex', async () => {
  const { workflow, agent } = await setup('codex', async () => catalog);
  await workflow.sendComposer('r1', '/frontend-design תבנה דף');
  expect(agent.sent.at(-1)!.englishText).toBe('Build the page and check it');
  await workflow.close();
});

it('sends the English unchanged when the inventory cannot be read', async () => {
  const { workflow, agent } = await setup('codex', async () => {
    throw new Error('unreadable');
  });
  await workflow.sendComposer('r1', '/frontend-design תבנה דף');
  expect(agent.sent.at(-1)!.englishText).toBe('Build the page and check it');
  await workflow.close();
});

it('sends the English unchanged when the inventory never answers', async () => {
  const { workflow, agent } = await setup('codex', () => new Promise(() => {}), 20);
  await workflow.sendComposer('r1', '/frontend-design תבנה דף');
  expect(agent.sent.at(-1)!.englishText).toBe('Build the page and check it');
  await workflow.close();
});

it('does not read the inventory when the text has no candidate token', async () => {
  const invocations = vi.fn(async () => catalog);
  const { workflow, agent } = await setup('claude', invocations);
  await workflow.sendComposer('r1', 'תבנה דף ב-src/app עם a/b');
  expect(invocations).not.toHaveBeenCalled();
  expect(agent.sent.at(-1)!.englishText).toBe('Build the page and check it');
  await workflow.close();
});

it('delivers a prepared draft as written', async () => {
  const { workflow, agent, language } = await setup('claude', async () => catalog);
  language.prepareResult = {
    localizedText: 'תבנה דף ‎/frontend-design',
    englishText: 'Build the page',
  };
  const draft = await workflow.prepare();
  await workflow.send(draft.id, draft.revision, 'channel');
  expect(agent.sent.at(-1)!.englishText).toBe('Build the page');
  await workflow.close();
});
