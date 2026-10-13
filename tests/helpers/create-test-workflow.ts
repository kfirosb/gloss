import { createWorkflow } from '../../src/core/workflow.js';
import type { AgentCapabilities, CodingState, DeliveryState, Target } from '../../src/core/contracts.js';
import { FakeAgent } from './fake-agent.js';
import { FakeLanguageSession } from './fake-language.js';
import { MemoryConversationStore } from './memory-store.js';

const DEFAULT_TARGET: Target = { agent: 'codex', sessionRef: 'session-1', projectId: 'p1' };

export interface TestWorkflowOptions {
  target?: Target | false;
  codingState?: CodingState;
  capabilities?: Partial<AgentCapabilities>;
  deliveryResult?: { state: DeliveryState; reason?: string };
}

export async function createTestWorkflow(options: TestWorkflowOptions = {}) {
  const agent = new FakeAgent();
  Object.assign(agent.capabilities, options.capabilities);
  if (options.deliveryResult) agent.result = options.deliveryResult;
  const language = new FakeLanguageSession();
  const store = new MemoryConversationStore();
  let sequence = 0;
  const workflow = createWorkflow({
    conversationId: 'conversation-1', language: 'he', projectContext: 'project notes',
    languageModel: 'test-model', languageSession: language, agents: [agent], store,
    createId: (prefix) => `${prefix}-${++sequence}`,
  });
  if (options.target !== false) {
    await workflow.connect(options.target ?? DEFAULT_TARGET);
    for (let attempt = 0; attempt < 20 && workflow.snapshot().codingState === 'disconnected'; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  if (options.codingState) {
    agent.emit({ type: 'status', state: options.codingState });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  return { workflow, agent, language, store };
}
