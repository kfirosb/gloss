import { expect, it, vi } from 'vitest';
import type { CatalogEntry } from '../../src/core/session-catalog.js';
import type { SourceMessage } from '../../src/core/contracts.js';
import type { Attention } from '../../src/runtime/attention-monitor.js';
import { createQuestionRelay } from '../../src/runtime/question-relay.js';

const entry = (launchId: string, sessionId?: string): CatalogEntry => ({
  key: launchId,
  ...(sessionId ? { sessionId } : {}),
  target: { agent: 'claude', sessionRef: 'ref-' + launchId, projectId: '/p' },
  projectKey: '/p/.git',
  projectName: 'p',
  open: true,
  activity: 'dialog-open',
  availability: 'available',
  launchId,
});
const asking = (launchId: string, question = 'Which?'): Attention => ({
  launchId,
  state: 'question',
  question: { header: 'Pick', question, options: [{ label: 'A', description: 'a' }] },
});
function harness() {
  let listener: ((m: Map<string, Attention>) => void) | undefined;
  let entries: CatalogEntry[] = [];
  const ingested: SourceMessage[] = [];
  const timers: (() => void)[] = [];
  let fail = false;
  const relay = createQuestionRelay({
    attention: {
      subscribe: (l) => {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
    },
    entries: () => entries,
    ingest: async (_agent, message) => {
      if (fail) throw new Error('Unknown or ambiguous source session');
      ingested.push(message);
    },
    now: () => 1_700_000_000_000,
    setTimer: ((fn: () => void) => {
      timers.push(fn);
      return 0 as never;
    }) as unknown as typeof setTimeout,
  });
  return {
    relay,
    ingested,
    timers,
    push: (...items: Attention[]) => listener!(new Map(items.map((a) => [a.launchId, a]))),
    setEntries: (value: CatalogEntry[]) => {
      entries = value;
    },
    setFail: (value: boolean) => {
      fail = value;
    },
  };
}

it('posts a shown question once into its session, as a completed assistant message', async () => {
  const h = harness();
  h.setEntries([entry('L1', 'S1')]);
  h.push(asking('L1'));
  h.push(asking('L1'));
  await vi.waitFor(() => expect(h.ingested).toHaveLength(1));
  expect(h.ingested[0]).toEqual({
    sourceSessionId: 'ref-L1',
    sourceId: expect.stringMatching(/^question:L1:[0-9a-f]{12}$/),
    sequence: 1_700_000_000_000,
    role: 'assistant',
    text: '**Pick** · Which?\n\n1. **A** — a',
    complete: true,
    timestamp: '2023-11-14T22:13:20.000Z',
  });
  expect(h.timers).toHaveLength(0);
  h.push(asking('L1', 'And then?'));
  await vi.waitFor(() => expect(h.ingested).toHaveLength(2));
});
it('waits for the launch to be identified and retries a rejected post while the question stays', async () => {
  const h = harness();
  h.setEntries([entry('L1')]);
  h.push(asking('L1'));
  expect(h.ingested).toHaveLength(0);
  expect(h.timers).toHaveLength(1);
  h.setEntries([entry('L1', 'S1')]);
  h.setFail(true);
  h.timers.shift()!();
  await vi.waitFor(() => expect(h.timers).toHaveLength(1));
  h.setFail(false);
  h.timers.shift()!();
  await vi.waitFor(() => expect(h.ingested).toHaveLength(1));
  // The question left the screen: nothing more is posted and no timer remains armed.
  h.push();
  expect(h.timers).toHaveLength(0);
});
it('ignores other states and launches that are not Claude', async () => {
  const h = harness();
  h.setEntries([
    entry('L1', 'S1'),
    { ...entry('L2', 'S2'), target: { agent: 'codex', sessionRef: 'ref-L2', projectId: '/p' } },
  ]);
  h.push({ launchId: 'L1', state: 'needs-user' }, asking('L2'));
  h.timers.shift()?.();
  await new Promise((r) => setTimeout(r, 5));
  expect(h.ingested).toHaveLength(0);
  h.relay.close();
});
