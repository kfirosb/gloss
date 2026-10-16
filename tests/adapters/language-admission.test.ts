import { expect, it, vi } from 'vitest';
import { LanguageWorkers } from '../../src/language/shared.js';
import { createWorkflow } from '../../src/core/workflow.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';

function fixture() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let executions = 0;
  const workers = new LanguageWorkers(
    {
      provider: 'codex',
      executable: 'fake',
      args: () => [],
      parser: () => ({ accept: () => '', finish: () => 'Translated source' }),
    },
    {
      runner: async function* (_executable, _args, _input, signal) {
        executions++;
        await Promise.race([
          gate,
          new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
          }),
        ]);
        yield {
          type: 'exit',
          outcome: { code: 0, signal: null, reason: 'exited', diagnostics: '' },
        };
      },
    },
  );
  return { workers, release, executions: () => executions };
}
it('automatically translates sources in three workflows after shared worker slots become free', async () => {
  const f = fixture();
  const store = new SqliteStore(':memory:');
  const workflows = ['first', 'second', 'third'].map((id) =>
    createWorkflow({
      conversationId: id,
      language: 'he',
      projectContext: '',
      languageModel: 'fake',
      languageSession: f.workers.session('fake'),
      agents: [],
      store,
    }),
  );
  try {
    workflows.forEach((workflow, index) =>
      workflow.ingestSourceMessage({
        sourceSessionId: `native-${index}`,
        sourceId: 'message',
        sequence: 1,
        role: 'assistant',
        text: 'Source text',
        complete: true,
      }),
    );
    await vi.waitFor(() => expect(f.executions()).toBe(2));
    f.release();
    await vi.waitFor(() =>
      expect(
        workflows.map((workflow) => workflow.snapshot().codingMessages[0]!.translationStatus),
      ).toEqual(['complete', 'complete', 'complete']),
    );
    expect(f.executions()).toBe(3);
  } finally {
    f.release();
    await Promise.all(workflows.map((workflow) => workflow.close()));
    store.close();
  }
});
it.each(['abort', 'close', 'reset'] as const)(
  'cancels queued work on %s without using a slot and still admits the next session',
  async (cancellation) => {
    const f = fixture();
    const sessions = [0, 1, 2, 3].map(() => f.workers.session('fake'));
    const first = sessions
      .slice(0, 2)
      .map((session) => session.translate('First', 'he', new AbortController().signal));
    const signal = new AbortController();
    const pending = sessions[2]!.translate('Cancelled', 'he', signal.signal);
    const outcome = pending.catch((error) => error);
    try {
      await vi.waitFor(() => expect(f.executions()).toBe(2));
      if (cancellation === 'abort') signal.abort();
      else if (cancellation === 'close') await sessions[2]!.close();
      else await sessions[2]!.resetContext();
      expect(await outcome).toMatchObject({ code: 'cancelled' });
      const next = sessions[3]!.translate('Next', 'he', new AbortController().signal);
      f.release();
      await Promise.all(first);
      expect(await next).toBe('Translated source');
      expect(f.executions()).toBe(3);
    } finally {
      f.release();
      await Promise.allSettled([...first, pending, outcome]);
      await Promise.all(sessions.map((session) => session.close()));
    }
  },
);
it('closing a workflow removes its waiting translation without marking omitted work complete', async () => {
  const f = fixture();
  const store = new SqliteStore(':memory:');
  const workflows = ['active-one', 'active-two', 'closing', 'waiting'].map((id) =>
    createWorkflow({
      conversationId: id,
      language: 'he',
      projectContext: '',
      languageModel: 'fake',
      languageSession: f.workers.session('fake'),
      agents: [],
      store,
    }),
  );
  try {
    workflows.forEach((workflow, index) =>
      workflow.ingestSourceMessage({
        sourceSessionId: `native-${index}`,
        sourceId: 'message',
        sequence: 1,
        role: 'assistant',
        text: 'Source text',
        complete: true,
      }),
    );
    await vi.waitFor(() => expect(f.executions()).toBe(2));
    await workflows[2]!.close();
    expect(store.load('closing')!.codingMessages[0]!.translationStatus).toBe('pending');
    f.release();
    await vi.waitFor(() =>
      expect(workflows[3]!.snapshot().codingMessages[0]!.translationStatus).toBe('complete'),
    );
    expect(store.load('closing')!.codingMessages[0]!.translationStatus).toBe('pending');
    expect(f.executions()).toBe(3);
  } finally {
    f.release();
    await Promise.all(workflows.map((workflow) => workflow.close()));
    store.close();
  }
});
