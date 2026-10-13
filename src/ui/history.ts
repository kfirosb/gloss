import { orderAgentMessages, type AgentKind, type AgentMessage } from '../core/contracts.js';

/** The panel intentionally shows a bounded, chronological recent window. */
export function recentMessages(messages: AgentMessage[], limit = 10, agent?: AgentKind): AgentMessage[] {
  if (limit <= 0) return [];
  const unique = new Map<string, AgentMessage>();
  for (const message of messages) {
    const existing = unique.get(message.sourceId);
    if (!existing || message.revision > existing.revision) unique.set(message.sourceId, message);
  }
  return orderAgentMessages([...unique.values()], agent).slice(-limit);
}
