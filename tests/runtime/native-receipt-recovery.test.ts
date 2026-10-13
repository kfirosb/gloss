import { afterEach, expect, it, vi } from 'vitest';
import { appendFile } from 'node:fs/promises';
import { createCodexAdapter, codexMessage } from '../../src/agents/codex/index.js';
import { createWorkflow } from '../../src/core/workflow.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { runProcess, type ProcessRunner } from '../../src/runtime/process-runner.js';
import { harness } from '../adapters/agent-harness.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';
import { createTestWorkflow } from '../helpers/create-test-workflow.js';
import type { AgentEvent } from '../../src/core/contracts.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it.each([false, true])('reconciles delayed prepared acceptance with a different client ID and preserves replacement=%s', async replace => {
  const h = await harness('codex'); cleanup.push(h.cleanup);
  const queueId = '44444444-4444-4444-8444-444444444444'; let dispatches = 0;
  const runner: ProcessRunner = (_command, args, input, signal, options) => {
    const output = args[0] === '--version' ? 'codex-cli 0.154.0' : `Queued message ${queueId} for thread ${h.sessionRef}.`;
    if (args[0] === 'queue') dispatches++;
    return runProcess(process.execPath, ['-e', `console.log(${JSON.stringify(output)})`], input, signal, options);
  };
  const adapter = createCodexAdapter({ codexHome: h.dir, runner, observeLive: async () => true, pollMs: 5 });
  const store = new SqliteStore(':memory:'); cleanup.push(async () => store.close());
  const language = new FakeLanguageSession(); language.prepareResult = { localizedText: 'Inspect reference', englishText: 'Inspect reference' }; language.translationReply = 'Translated';
  const workflow = createWorkflow({ conversationId: 'native-recovery', agents: [adapter], store, languageSession: language, languageModel: 'test', language: 'he', projectContext: '' }); cleanup.push(() => workflow.close());
  await workflow.connect(h.target); await vi.waitFor(() => expect(workflow.snapshot().codingState).toBe('idle'));
  const file = { id: 'reference', kind: 'file' as const, sessionId: 'native-recovery', index: 1, name: 'reference.txt', path: h.transcript, worktreePath: h.project, source: 'worktree' as const, mime: 'text/plain', size: 1 };
  await workflow.discuss('Inspect reference', [file]); const draft = await workflow.prepareDirect([0, 1]);
  const receipt = await workflow.sendReview(draft.id, draft.revision, draft.localizedText);
  expect(receipt.state).toBe('queued'); expect(receipt.nativeMessageId).toBe(queueId);
  const acceptance = async (id: string, text: string) => appendFile(h.transcript, JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', thread_id: h.sessionRef, item: { type: 'UserMessage', id, client_id: 'different-native-client', content: [{ type: 'text', text }] } } }) + '\n');
  await acceptance('wrong-manifest', receipt.englishText);
  await vi.waitFor(() => expect(workflow.snapshot().codingMessages.some(message => message.sourceId === 'wrong-manifest')).toBe(true));
  expect(workflow.snapshot().deliveries[0]?.state).toBe('queued'); expect(workflow.snapshot().currentDraft?.id).toBe(draft.id);
  let replacementId: string | undefined;
  if (replace) {
    workflow.resetInstruction(draft.id, draft.revision);
    replacementId = (await workflow.prepareDirect([0, 1])).id;
  }
  await acceptance('correct-manifest', codexMessage(receipt.englishText, receipt.attachments));
  await vi.waitFor(() => expect(workflow.snapshot().deliveries[0]?.state).toBe('sent'));
  expect(workflow.snapshot().currentDraft?.id).toBe(replacementId); expect(store.load('native-recovery')?.deliveries[0]?.state).toBe('sent');
  expect(dispatches).toBe(1);
});

it.each(['message', 'status'] as const)('ignores %s reconciliation from a replaced connection while preserving the pending prepared draft', async type => {
  const app = await createTestWorkflow({ target: false, deliveryResult: { state: 'queued' } }); cleanup.push(() => app.workflow.close());
  let allowCheck = false; let release: (() => void) | undefined;
  const attach = app.agent.attach.bind(app.agent);
  app.agent.attach = async target => ({ ...await attach(target), reconcileDelivery: async () => {
    if (!allowCheck) return false;
    await new Promise<void>(resolve => { release = resolve; }); return true;
  } });
  const target = { agent: 'codex' as const, sessionRef: 'original', projectId: 'original-project' };
  await app.workflow.connect(target); await vi.waitFor(() => expect(app.workflow.snapshot().codingState).toBe('idle'));
  await app.workflow.discuss('Prepared'); const draft = await app.workflow.prepareDirect([0]); await app.workflow.send(draft.id, draft.revision);
  allowCheck = true;
  const event: AgentEvent = type === 'status' ? { type: 'status', state: 'idle' } : { type: 'message', message: { sourceId: 'accepted', revision: 1, role: 'user', text: 'Prepared', complete: true } };
  app.agent.emit(event);
  try {
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await app.workflow.connect({ ...target, sessionRef: 'replacement' });
    release!();
    await vi.waitFor(() => expect(app.workflow.snapshot().codingState).toBe('idle'));
    expect(app.workflow.snapshot().deliveries[0]?.state).toBe('queued'); expect(app.workflow.snapshot().currentDraft?.id).toBe(draft.id); expect(app.agent.sent).toHaveLength(1);
  } finally { release?.(); }
});
