import { expect, it } from 'vitest';
import { createWorkflow } from '../../src/core/workflow.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';
import { MemoryConversationStore } from '../helpers/memory-store.js';
import type { ProviderUsage } from '../../src/core/usage.js';

it('hands usage events from the live agent to the usage callback without touching the snapshot', async () => {
  const agent = new FakeAgent('codex'); const seen: ProviderUsage[] = [];
  const workflow = createWorkflow({ conversationId: 'c', language: 'he', projectContext: '', languageModel: 'test', languageSession: new FakeLanguageSession(), agents: [agent], store: new MemoryConversationStore(), onUsage: usage => seen.push(usage) });
  await workflow.connect({ agent: 'codex', sessionRef: 's', projectId: '/p' });
  const usage: ProviderUsage = { provider: 'codex', observedAt: 5, fiveHour: { usedFraction: 0.5, resetsAt: 9 } };
  agent.emit({ type: 'usage', usage });
  await expect.poll(() => seen).toEqual([usage]);
  expect(JSON.stringify(workflow.snapshot())).not.toContain('usedFraction');
  await workflow.close();
});
