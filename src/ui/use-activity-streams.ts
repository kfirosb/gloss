import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityEvent, ActivitySnapshot } from '../core/activity-contracts.js';
import { applyActivityEvent, emptyActivity } from '../core/activity-reducer.js';
import type { SessionClient } from './session-client.js';

/** Characters of background output kept in the page; older lines are dropped from the top. */
const TAIL_CHARS_LIMIT = 256_000;
const SUBAGENT_UNAVAILABLE = 'Subagent transcript unavailable';
const OUTPUT_UNAVAILABLE = 'Output unavailable';
const EARLIER_UNAVAILABLE = 'Earlier output unavailable';

export interface StreamState {
  key: string;
  state: ActivitySnapshot;
}
const streamKey = (sessionId: string, taskId: string) => `${sessionId}:${taskId}`;

/**
 * Folds one event from the stream opened for `incomingKey` while the view shows `key`.
 * A late event from an earlier session or task is dropped; a new key starts from an empty activity.
 */
export function foldStreamEvents(
  key: string,
  current: StreamState,
  incomingKey: string,
  event: ActivityEvent,
): StreamState {
  if (incomingKey !== key) return current;
  const base = current.key === key ? current.state : emptyActivity();
  return { key, state: applyActivityEvent(base, event) };
}

/** The activity of one subagent's own transcript, streamed while `active`. */
export function useSubagentStream(
  client: Pick<SessionClient, 'subagentActivity' | 'sessionId'>,
  taskId: string,
  active: boolean,
): ActivitySnapshot {
  const key = streamKey(client.sessionId, taskId);
  const keyNow = useRef(key);
  keyNow.current = key;
  const [stream, setStream] = useState<StreamState>(() => ({ key, state: emptyActivity() }));
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    // Each connection replays the transcript from its start, so it folds onto a fresh state.
    setStream({ key, state: emptyActivity() });
    const fold = (event: ActivityEvent) =>
      setStream((current) => foldStreamEvents(keyNow.current, current, key, event));
    void (async () => {
      try {
        for await (const event of client.subagentActivity(taskId, controller.signal)) {
          if (controller.signal.aborted) return;
          fold(event);
        }
      } catch {
        if (!controller.signal.aborted) fold({ kind: 'gap', reason: SUBAGENT_UNAVAILABLE });
      }
    })();
    return () => controller.abort();
  }, [client, taskId, key, active]);
  return stream.key === key ? stream.state : emptyActivity();
}

interface TailState {
  key: string;
  lines: string;
  start: number; // byte offset of the first kept character
  end: number; // byte offset just past the last received chunk
  error?: string;
}
const encoder = new TextEncoder();
/** Drops whole lines from the top beyond the limit, moving `start` by the dropped bytes. */
function bounded(state: TailState): TailState {
  if (state.lines.length <= TAIL_CHARS_LIMIT) return state;
  const over = state.lines.length - TAIL_CHARS_LIMIT;
  const newline = state.lines.indexOf('\n', over);
  const cut = newline === -1 ? over : newline + 1;
  const dropped = state.lines.slice(0, cut);
  return {
    ...state,
    lines: state.lines.slice(cut),
    start: state.start + encoder.encode(dropped).length,
  };
}

export interface OutputTail {
  lines: string;
  start: number;
  error?: string;
  /** Prepends the window before `start`; never rejects, a failure becomes `error`. */
  showEarlier(): Promise<void>;
}
/** A background command's output, newest at the bottom, tailed while `active`. */
export function useOutputTail(
  client: Pick<SessionClient, 'outputTail' | 'outputWindow' | 'sessionId'>,
  taskId: string,
  active: boolean,
): OutputTail {
  const key = streamKey(client.sessionId, taskId);
  const keyNow = useRef(key);
  keyNow.current = key;
  const empty = (): TailState => ({ key, lines: '', start: 0, end: 0 });
  const [tail, setTail] = useState<TailState>(empty);
  const current = tail.key === key ? tail : empty();
  const startNow = useRef(current.start);
  startNow.current = current.start;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setTail({ key, lines: '', start: 0, end: 0 });
    const update = (change: (state: TailState) => TailState) =>
      setTail((state) => (keyNow.current === key && state.key === key ? change(state) : state));
    void (async () => {
      try {
        for await (const event of client.outputTail(taskId, controller.signal)) {
          if (controller.signal.aborted) return;
          if (event.kind === 'error') return update((state) => ({ ...state, error: event.reason }));
          update((state) =>
            // An appended chunk continues the text; any other chunk is a fresh window that replaces it.
            event.start === state.end && state.lines
              ? bounded({ ...state, lines: state.lines + event.text, end: event.end })
              : bounded({ key, lines: event.text, start: event.start, end: event.end }),
          );
        }
      } catch {
        if (!controller.signal.aborted)
          update((state) => ({ ...state, error: OUTPUT_UNAVAILABLE }));
      }
    })();
    return () => controller.abort();
  }, [client, taskId, key, active]);
  const showEarlier = useCallback(async () => {
    const requestedKey = key;
    const before = startNow.current;
    if (before <= 0) return;
    const owns = (state: TailState) =>
      keyNow.current === requestedKey && state.key === requestedKey;
    let window: Awaited<ReturnType<typeof client.outputWindow>>;
    try {
      window = await client.outputWindow(taskId, before);
    } catch {
      setTail((state) => (owns(state) ? { ...state, error: EARLIER_UNAVAILABLE } : state));
      return;
    }
    setTail((state) =>
      // Prepend only onto the same task's text, and only when the window meets its first line.
      owns(state) && state.start === before && window.end === before
        ? { ...state, lines: window.text + state.lines, start: window.start }
        : state,
    );
  }, [client, taskId, key]);
  return {
    lines: current.lines,
    start: current.start,
    ...(current.error === undefined ? {} : { error: current.error }),
    showEarlier,
  };
}
