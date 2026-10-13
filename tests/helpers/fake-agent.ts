import type { Attachment } from '../../src/core/contracts.js';
import type {
  AgentMessage,
  AgentAdapter,
  AgentCapabilities,
  AgentEvent,
  AgentKind,
  CodingConnection,
  DeliveryState,
  Target,
} from '../../src/core/contracts.js';

const DEFAULT_CAPABILITIES: AgentCapabilities = {
  history: true,
  liveMessages: true,
  attachExisting: true,
  sendWhileBusy: false,
  acknowledgement: 'accepted',
};

export class FakeAgent implements AgentAdapter {
  readonly sent: { requestId: string; englishText: string; attachments?: Attachment[] }[] = [];
  readonly kind: AgentKind;
  capabilities = { ...DEFAULT_CAPABILITIES };
  result: { state: DeliveryState; reason?: string } = { state: 'sent' };
  sendError?: Error;
  sendGate?: Promise<void>;
  readonly attachGates = new Map<string, Promise<void>>();
  readonly historyGates = new Map<string, Promise<void>>();
  readonly historyMessages = new Map<string, AgentMessage[]>();
  readonly detachedTargets: string[] = [];
  private eventsQueue: AgentEvent[] = [];

  constructor(kind: AgentKind = 'codex') { this.kind = kind; }
  async discover() { return []; }
  emit(event: AgentEvent) { this.eventsQueue.push(event); }
  async attach(target: Target): Promise<CodingConnection> {
    await this.attachGates.get(target.sessionRef);
    const agent = this;
    const capabilities = { ...this.capabilities };
    this.eventsQueue.push({ type: 'status', state: 'idle' });
    return {
      target: structuredClone(target),
      capabilities,
      async history() {
        await agent.historyGates.get(target.sessionRef);
        return { messages: structuredClone(agent.historyMessages.get(target.sessionRef) ?? []) };
      },
      async *events(signal) {
        while (!signal.aborted) {
          const event = agent.eventsQueue.shift();
          if (event) yield event;
          else await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      },
      async send(requestId, englishText, attachments) {
        agent.sent.push({ requestId, englishText, ...(attachments?{attachments}:{}) });
        if (agent.sendGate) await agent.sendGate;
        if (agent.sendError) throw agent.sendError;
        return agent.result;
      },
      async detach() { agent.detachedTargets.push(target.sessionRef); },
    };
  }
}
