import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityEvent, ActivitySnapshot } from '../core/activity-contracts.js';
import { applyActivityEvent, emptyActivity } from '../core/activity-reducer.js';
import type { SessionClient } from './session-client.js';

/** Characters of background output kept in the page; older lines are dropped from the top. */
const TAIL_CHARS_LIMIT = 256_000;
const SUBAGENT_UNAVAILABLE = 'Subagent transcript unavailable';
const OUTPUT_UNAVAILABLE = 'Output unavailable';
const EARLIER_UNAVAILABLE = 'Earlier output unavailable';

/**
 * Activity streams the page holds open at once. The browser allows six connections per host over
 * HTTP/1.1 and the session and catalog event streams already use two; actions need the rest.
 */
export const ACTIVITY_STREAM_LIMIT = 3;

/** How much a stream matters: 1 expanded by hand, 2 a running subagent card, 3 a background-command tail. */
export type StreamPriority = 1 | 2 | 3;

interface StreamSlot {
  order: number; // claim order: a lower number is older
  priority: StreamPriority;
  setOpen: (open: boolean) => void;
}

/**
 * Grants at most `limit` open streams. A holder keeps its slot until it releases it; a claim takes a
 * free slot, else preempts only a holder of lower importance (oldest first), else waits paused.
 */
export class StreamSlots {
  private readonly open: StreamSlot[] = [];
  private readonly paused: StreamSlot[] = [];
  private claims = 0;
  constructor(private readonly limit: number) {}
  /** `setOpen` hears whether the stream may hold its connection now and whenever that changes. */
  claim(setOpen: (open: boolean) => void, priority: StreamPriority): () => void {
    const slot: StreamSlot = { order: this.claims++, priority, setOpen };
    if (this.open.length < this.limit) {
      this.open.push(slot);
      setOpen(true);
    } else {
      const victim = this.preemptable(priority);
      if (victim) {
        this.open.splice(this.open.indexOf(victim), 1);
        this.paused.push(victim);
        this.open.push(slot);
        setOpen(true);
        victim.setOpen(false);
      } else {
        this.paused.push(slot);
        setOpen(false);
      }
    }
    return () => {
      const pausedAt = this.paused.indexOf(slot);
      if (pausedAt >= 0) {
        this.paused.splice(pausedAt, 1);
        return;
      }
      const openAt = this.open.indexOf(slot);
      if (openAt < 0) return;
      this.open.splice(openAt, 1);
      const next = this.nextWaiting();
      if (!next) return;
      this.paused.splice(this.paused.indexOf(next), 1);
      this.open.push(next);
      next.setOpen(true);
    };
  }
  /** The open holder of the lowest importance below `priority`, oldest first. */
  private preemptable(priority: StreamPriority): StreamSlot | undefined {
    let victim: StreamSlot | undefined;
    for (const holder of this.open) {
      if (holder.priority <= priority) continue;
      if (!victim || holder.priority > victim.priority) victim = holder;
    }
    return victim;
  }
  /** The most important waiting claim, newest first. */
  private nextWaiting(): StreamSlot | undefined {
    let next: StreamSlot | undefined;
    for (const waiting of this.paused) {
      if (
        !next ||
        waiting.priority < next.priority ||
        (waiting.priority === next.priority && waiting.order > next.order)
      )
        next = waiting;
    }
    return next;
  }
}
const activityStreamSlots = new StreamSlots(ACTIVITY_STREAM_LIMIT);

/** Whether a stream wanted while `active` holds a slot: `false` while paused, `undefined` before claiming. */
function useStreamSlot(active: boolean, priority: StreamPriority): boolean | undefined {
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (!active) return;
    const release = activityStreamSlots.claim(setOpen, priority);
    return () => {
      release();
      setOpen(undefined);
    };
  }, [active, priority]);
  return active ? open : undefined;
}

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

export interface SubagentStream {
  activity: ActivitySnapshot;
  /** Wanted but closed while other activity streams hold the connections. */
  paused: boolean;
}
/** The activity of one subagent's own transcript, streamed while `active` and holding a slot. */
export function useSubagentStream(
  client: Pick<SessionClient, 'subagentActivity' | 'sessionId'>,
  taskId: string,
  active: boolean,
  priority: StreamPriority,
): SubagentStream {
  const key = streamKey(client.sessionId, taskId);
  const keyNow = useRef(key);
  keyNow.current = key;
  const [stream, setStream] = useState<StreamState>(() => ({ key, state: emptyActivity() }));
  const slot = useStreamSlot(active, priority);
  const open = slot === true;
  useEffect(() => {
    if (!open) return;
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
  }, [client, taskId, key, open]);
  return {
    activity: stream.key === key ? stream.state : emptyActivity(),
    paused: slot === false,
  };
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
  /** Wanted but closed while other activity streams hold the connections. */
  paused: boolean;
  /** Prepends the window before `start`; never rejects, a failure becomes `error`. */
  showEarlier(): Promise<void>;
}
/** A background command's output, newest at the bottom, tailed while `active` and holding a slot. */
export function useOutputTail(
  client: Pick<SessionClient, 'outputTail' | 'outputWindow' | 'sessionId'>,
  taskId: string,
  active: boolean,
  priority: StreamPriority,
): OutputTail {
  const key = streamKey(client.sessionId, taskId);
  const keyNow = useRef(key);
  keyNow.current = key;
  const empty = (): TailState => ({ key, lines: '', start: 0, end: 0 });
  const [tail, setTail] = useState<TailState>(empty);
  const current = tail.key === key ? tail : empty();
  const startNow = useRef(current.start);
  startNow.current = current.start;
  const slot = useStreamSlot(active, priority);
  const open = slot === true;
  useEffect(() => {
    if (!open) return;
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
  }, [client, taskId, key, open]);
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
    paused: slot === false,
    showEarlier,
  };
}
