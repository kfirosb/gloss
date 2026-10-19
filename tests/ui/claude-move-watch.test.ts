import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeMoveRequest, ClaudeMoveStatus } from '../../src/runtime/claude-move.js';
import {
  MOVE_DONE_TEXT,
  MOVE_OUTCOME_WATCH_MS,
  MOVE_STATUS_POLL_MS,
  attachMoveView,
  moveViewOf,
  readMoveStatus,
  requestMove,
  takeMoveNotice,
  type MoveClient,
} from '../../src/ui/claude-move-watch.js';

const PROCESS = { pid: 4242, procStart: 'Sat Oct 18 10:00:00 2026' };
const MANUAL = { command: 'claude --resume s', cdCommand: "cd '/p' && claude --resume s" };
let sessions = 0;
function fakeClient(initial: ClaudeMoveStatus) {
  let status: unknown = initial;
  let answer: unknown;
  const requests: ClaudeMoveRequest[] = [];
  const client: MoveClient & { reads: number } = {
    sessionId: `session-${++sessions}`,
    reads: 0,
    async claudeMove() {
      client.reads++;
      return status;
    },
    async moveClaude(request) {
      requests.push(request);
      if (answer !== undefined) status = answer;
      if (status instanceof Error) throw status;
      return status;
    },
  };
  return {
    client,
    requests,
    set(value: unknown) {
      status = value;
    },
    answer(value: unknown) {
      answer = value;
    },
  };
}
const move: ClaudeMoveRequest = { action: 'move', expected: PROCESS };

describe('readMoveStatus', () => {
  it('reads every state the server sends, with its failure', () => {
    const failure = { reason: 'r', manual: MANUAL };
    for (const status of [
      { state: 'ready', process: PROCESS },
      { state: 'busy', reason: 'working', process: PROCESS, failure },
      { state: 'waiting' },
      { state: 'moving' },
      { state: 'in-gloss', failure: { reason: 'late' } },
      { state: 'unavailable', reason: 'no', failure },
    ] as const)
      expect(readMoveStatus(JSON.parse(JSON.stringify(status)))).toEqual(status);
  });
  it('fails closed on malformed status, and drops a malformed manual command', () => {
    for (const bad of [
      null,
      'ready',
      { state: 'ready' },
      { state: 'ready', process: { pid: '1', procStart: 'x' } },
      { state: 'busy', process: PROCESS },
      { state: 'unavailable' },
      { state: 'killed' },
      { state: 'moving', failure: { reason: 3 } },
    ])
      expect(readMoveStatus(bad)).toBeUndefined();
    expect(
      readMoveStatus({ state: 'moving', failure: { reason: 'r', manual: { command: 'c' } } }),
    ).toEqual({ state: 'moving', failure: { reason: 'r' } });
  });
});

describe('a move in flight', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('outlives its closed dialog and reports a late failure as the session notice, then stops', async () => {
    const f = fakeClient({ state: 'ready', process: PROCESS });
    const close = attachMoveView(f.client);
    f.answer({ state: 'in-gloss' });
    await requestMove(f.client, move);
    close();
    await vi.advanceTimersByTimeAsync(MOVE_STATUS_POLL_MS);
    expect(takeMoveNotice(f.client.sessionId)).toBeUndefined();
    f.set({ state: 'in-gloss', failure: { reason: 'Claude closed.', manual: MANUAL } });
    await vi.advanceTimersByTimeAsync(MOVE_STATUS_POLL_MS);
    expect(takeMoveNotice(f.client.sessionId)).toBe(
      `Claude closed. Open it in a terminal with: ${MANUAL.cdCommand}`,
    );
    expect(takeMoveNotice(f.client.sessionId)).toBeUndefined();
    const reads = f.client.reads;
    await vi.advanceTimersByTimeAsync(MOVE_OUTCOME_WATCH_MS);
    expect(f.client.reads).toBe(reads);
    expect(f.requests).toEqual([move]);
  });

  it('is done only after the reopen check, and then reports success once', async () => {
    const f = fakeClient({ state: 'ready', process: PROCESS });
    const close = attachMoveView(f.client);
    f.answer({ state: 'in-gloss' });
    await requestMove(f.client, move);
    close();
    await vi.advanceTimersByTimeAsync(MOVE_OUTCOME_WATCH_MS - MOVE_STATUS_POLL_MS);
    expect(takeMoveNotice(f.client.sessionId)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2 * MOVE_STATUS_POLL_MS);
    expect(takeMoveNotice(f.client.sessionId)).toBe(MOVE_DONE_TEXT);
    const reads = f.client.reads;
    await vi.advanceTimersByTimeAsync(10 * MOVE_STATUS_POLL_MS);
    expect(f.client.reads).toBe(reads);
  });

  it('shows its outcome in the open dialog instead of a notice, until the dialog closes', async () => {
    const f = fakeClient({ state: 'ready', process: PROCESS });
    const close = attachMoveView(f.client);
    f.answer({ state: 'unavailable', reason: 'x', failure: { reason: 'Not closed.' } });
    await requestMove(f.client, move);
    expect(moveViewOf(f.client.sessionId).phase).toBe('resolved');
    await vi.advanceTimersByTimeAsync(MOVE_STATUS_POLL_MS);
    expect(moveViewOf(f.client.sessionId).phase).toBe('resolved');
    close();
    expect(moveViewOf(f.client.sessionId).phase).toBe('none');
    expect(takeMoveNotice(f.client.sessionId)).toBeUndefined();
    const reads = f.client.reads;
    await vi.advanceTimersByTimeAsync(10 * MOVE_STATUS_POLL_MS);
    expect(f.client.reads).toBe(reads);
  });

  it('keeps watching a scheduled move until it happens, and Don’t move ends it quietly', async () => {
    const f = fakeClient({ state: 'busy', reason: 'working', process: PROCESS });
    const close = attachMoveView(f.client);
    f.answer({ state: 'waiting' });
    await requestMove(f.client, { action: 'when-idle', expected: PROCESS });
    close();
    await vi.advanceTimersByTimeAsync(5 * MOVE_STATUS_POLL_MS);
    expect(moveViewOf(f.client.sessionId).phase).toBe('in-flight');
    f.answer({ state: 'busy', reason: 'working', process: PROCESS });
    await requestMove(f.client, { action: 'cancel' });
    expect(moveViewOf(f.client.sessionId).phase).toBe('none');
    const reads = f.client.reads;
    await vi.advanceTimersByTimeAsync(10 * MOVE_STATUS_POLL_MS);
    expect(f.client.reads).toBe(reads);
    expect(takeMoveNotice(f.client.sessionId)).toBeUndefined();
  });

  it('reports a request that failed, without retrying it', async () => {
    const f = fakeClient({ state: 'ready', process: PROCESS });
    const close = attachMoveView(f.client);
    close();
    f.answer(new Error('Gloss is closing'));
    await requestMove(f.client, move);
    expect(takeMoveNotice(f.client.sessionId)).toBe('Gloss is closing');
    await vi.advanceTimersByTimeAsync(10 * MOVE_STATUS_POLL_MS);
    expect(f.requests).toEqual([move]);
  });
});
