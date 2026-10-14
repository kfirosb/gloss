import { expect, it } from 'vitest';
import { createWorkflow } from '../../src/core/workflow.js';
import { catalogFrom } from '../../src/core/invocations.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';
import { MemoryConversationStore } from '../helpers/memory-store.js';

async function setup(agentKind: 'claude' | 'codex', invocations?: () => Promise<ReturnType<typeof catalogFrom>>) {
  const agent = new FakeAgent(agentKind); agent.result = { state: 'sent' };
  const language = new FakeLanguageSession(); language.translationReply = 'Build the page and check it';
  const workflow = createWorkflow({ conversationId: 'c', language: 'he', languageModel: 'test', languageSession: language, projectContext: '', agents: [agent], store: new MemoryConversationStore(), ...(invocations ? { invocations } : {}) });
  await workflow.connect({ agent: agentKind, sessionRef: 's', projectId: 'p1' });
  await expect.poll(() => workflow.snapshot().codingState).toBe('idle');
  return { workflow, agent };
}
const catalog = catalogFrom([{ kind: 'skill', name: 'frontend-design' }, { kind: 'mcp', name: 'playwright' }]);

it('delivers the assembled instruction for a direct Claude send', async () => {
  const { workflow, agent } = await setup('claude', async () => catalog);
  await workflow.sendComposer('r1', 'תבנה דף ‎/frontend-design ותבדוק עם ‎$playwright', [], 'channel');
  expect(agent.sent.at(-1)!.englishText).toBe('/frontend-design Build the page and check it\n\nUse the `playwright` MCP server for this.');
  await workflow.close();
});

it('delivers $ skill mentions for Codex', async () => {
  const { workflow, agent } = await setup('codex', async () => catalog);
  await workflow.sendComposer('r1', '/frontend-design תבנה דף');
  expect(agent.sent.at(-1)!.englishText).toBe('$frontend-design Build the page and check it');
  await workflow.close();
});

it('sends the English unchanged when the inventory cannot be read', async () => {
  const { workflow, agent } = await setup('codex', async () => { throw new Error('unreadable'); });
  await workflow.sendComposer('r1', '/frontend-design תבנה דף');
  expect(agent.sent.at(-1)!.englishText).toBe('Build the page and check it');
  await workflow.close();
});
