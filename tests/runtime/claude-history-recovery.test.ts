import { afterEach, expect, it, vi } from 'vitest';
import { readFile, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createClaudeAdapter } from '../../src/agents/claude/index.js';
import { ChannelStore } from '../../src/agents/claude/channel-store.js';
import { createWorkflow } from '../../src/core/workflow.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { harness } from '../adapters/agent-harness.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it.each(['open', 'read'] as const)('connects native history despite a readonly ledger %s error and recovers replies once without resending', async failure => {
  const h = await harness('claude'); cleanup.push(h.cleanup);
  const path = join(h.dir, 'claude-channel-ledger.db');
  if (failure === 'open') {
    const other = join(h.dir, 'other.db'); new DatabaseSync(other).close();
    await symlink(other, path); // Readonly opening must reject a symlink.
  }
  else new DatabaseSync(path).close(); // Interrupted initialization: file exists without schema.
  const original = await readFile(path);
  const bridged: string[] = [];
  const adapter = createClaudeAdapter({ configDir: h.dir, stateDir: h.dir, transcriptPath: async () => h.transcript,
    observeLive: async () => true, pageSize: 1, pollMs: 5,
    sourceSink: { send: async message => { bridged.push(message.sourceId); } },
  });
  const attach = adapter.attach.bind(adapter);
  const sends = vi.fn();
  adapter.attach = async (...args) => {
    const connection = await attach(...args);
    const send = connection.send.bind(connection);
    connection.send = (...args) => { sends(); return send(...args); };
    return connection;
  };
  const store = new SqliteStore(':memory:'); cleanup.push(async () => store.close());
  const workflow = createWorkflow({ conversationId: 'panel', agents: [adapter], store,
    languageSession: new FakeLanguageSession(), languageModel: 'test', language: 'he', projectContext: '' });
  cleanup.push(() => workflow.close());

  await expect(workflow.connect(h.target)).resolves.toBeUndefined();
  expect(workflow.snapshot().codingMessages.some(message => message.text === 'READY')).toBe(true);
  const firstCursor = JSON.parse(workflow.snapshot().historyCursor!);
  expect(firstCursor).toMatchObject({ nativeDone: false, after: 0, channelDone: false });
  expect(firstCursor.native).toEqual(expect.any(String));
  await vi.waitFor(() => {
    expect(workflow.snapshot().codingState).toBe('idle');
    expect(workflow.snapshot().sourceGaps).toEqual([expect.stringMatching(/channel.*retry/i)]);
  });
  await workflow.loadOlderHistory();
  expect(workflow.snapshot().codingMessages.some(message => message.sourceId === 'message-1')).toBe(true);
  await workflow.loadOlderHistory();
  expect(JSON.parse(workflow.snapshot().historyCursor!)).toMatchObject({ nativeDone: true, after: 0, channelDone: false });
  await h.appendMessage('Native continues', 'native-during-gap');
  await vi.waitFor(() => expect(workflow.snapshot().codingMessages.some(message => message.text === 'Native continues')).toBe(true));
  expect(await readFile(path)).toEqual(original); // Consumer did not repair or initialize the ledger.

  if (failure === 'open') await unlink(path);
  const ledger = new ChannelStore(path); cleanup.push(async () => ledger.close());
  const key = { panelSessionId: 'panel', nativeSessionId: h.sessionRef, generation: randomUUID(), requestId: 'recovered' };
  ledger.registerGeneration(key.generation, h.target); ledger.claim(key, 'Already claimed'); ledger.recordReply(key, 'Recovered channel answer');
  const replyId = `channel:${key.generation}:recovered`;
  await vi.waitFor(() => expect(workflow.snapshot().codingMessages.filter(message => message.sourceId === replyId)).toHaveLength(1));
  await vi.waitFor(() => expect(bridged.filter(id => id === replyId)).toHaveLength(1));
  await workflow.loadOlderHistory(); await workflow.loadOlderHistory();
  expect(workflow.snapshot().historyCursor).toBeUndefined();
  await h.appendMessage('After recovery', 'native-after-recovery');
  await vi.waitFor(() => expect(workflow.snapshot().codingMessages.some(message => message.text === 'After recovery')).toBe(true));
  expect(workflow.snapshot().codingMessages.filter(message => message.sourceId === replyId)).toHaveLength(1);
  expect(bridged.filter(id => id === replyId)).toHaveLength(1);
  expect(sends).not.toHaveBeenCalled();
});
