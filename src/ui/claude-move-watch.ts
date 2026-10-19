import { useEffect, useRef, useSyncExternalStore } from 'react';
import { MOVE_RESUME_CHECK_MS } from '../core/claude-move-policy.js';
import { recordOf } from '../core/json-record.js';
import type {
  ClaudeMoveFailure,
  ClaudeMoveRequest,
  ClaudeMoveStatus,
  MoveIdentity,
} from '../runtime/claude-move.js';
import { errorMessage } from './error-message.js';

/** How often a shown Move to Gloss control, or a move in flight, re-reads its status, in milliseconds. */
export const MOVE_STATUS_POLL_MS = 2000;
/**
 * Spec 5.6: once the session runs in Gloss, how long the move is still watched for a late reopen failure, in
 * milliseconds: the server's reopen check plus one poll.
 */
export const MOVE_OUTCOME_WATCH_MS = MOVE_RESUME_CHECK_MS + MOVE_STATUS_POLL_MS;
export const MOVE_DONE_TEXT = 'This session now runs in Gloss.';
const STATUS_UNAVAILABLE = 'Gloss couldn’t check Move to Gloss; it will check again.';

/** The part of SessionClient a move needs; responses are untrusted. */
export interface MoveClient {
  readonly sessionId: string;
  claudeMove(signal?: AbortSignal): Promise<unknown>;
  moveClaude(request: ClaudeMoveRequest): Promise<unknown>;
}
export interface MoveView {
  status: ClaudeMoveStatus | undefined;
  error: string;
  /** The POST in flight, if any. */
  pending: ClaudeMoveRequest['action'] | undefined;
  /** `in-flight`: a move or wait started here; `resolved`: its outcome, kept while a dialog shows it. */
  phase: 'none' | 'in-flight' | 'resolved';
}
const IDLE_VIEW: MoveView = { status: undefined, error: '', pending: undefined, phase: 'none' };

function readIdentity(value: unknown): MoveIdentity | undefined {
  const record = recordOf(value);
  return typeof record?.pid === 'number' && typeof record.procStart === 'string'
    ? { pid: record.pid, procStart: record.procStart }
    : undefined;
}
function readFailure(value: unknown): ClaudeMoveFailure | undefined {
  const record = recordOf(value);
  if (typeof record?.reason !== 'string') return undefined;
  const manual = recordOf(record.manual);
  return typeof manual?.command === 'string' && typeof manual.cdCommand === 'string'
    ? { reason: record.reason, manual: { command: manual.command, cdCommand: manual.cdCommand } }
    : { reason: record.reason };
}
/** Reads the server's Move to Gloss status; anything malformed is undefined, never a guessed state. */
export function readMoveStatus(value: unknown): ClaudeMoveStatus | undefined {
  const record = recordOf(value);
  const failure = record?.failure === undefined ? undefined : readFailure(record.failure);
  if (record?.failure !== undefined && !failure) return undefined;
  const noted = (status: ClaudeMoveStatus): ClaudeMoveStatus =>
    failure ? { ...status, failure } : status;
  const process = readIdentity(record?.process);
  const reason = typeof record?.reason === 'string' ? record.reason : undefined;
  switch (record?.state) {
    case 'ready':
      return process && noted({ state: 'ready', process });
    case 'busy':
      return process && reason !== undefined
        ? noted({ state: 'busy', reason, process })
        : undefined;
    case 'waiting':
    case 'moving':
    case 'in-gloss':
      return noted({ state: record.state });
    case 'unavailable':
      return reason !== undefined ? noted({ state: 'unavailable', reason }) : undefined;
    default:
      return undefined;
  }
}
/** What a move ended with, as one line for the session's notice; undefined when there is nothing to report. */
export function moveOutcomeText(view: MoveView): string | undefined {
  if (view.error) return view.error;
  const { status } = view;
  if (status?.failure) {
    const { reason, manual } = status.failure;
    return manual ? `${reason} Open it in a terminal with: ${manual.cdCommand}` : reason;
  }
  if (status?.state === 'in-gloss') return MOVE_DONE_TEXT;
  if (status?.state === 'busy' || status?.state === 'unavailable') return status.reason;
  return undefined;
}

interface Watch {
  client: MoveClient;
  view: MoveView;
  viewers: number;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Request numbers: a response older than the newest applied one is dropped. */
  issued: number;
  applied: number;
  /** When the session was first seen running in Gloss during this move, in epoch milliseconds. */
  inGlossSince: number | undefined;
}
// One watch per session, shared by every dialog that shows it; it outlives them while a move is in flight (I6).
const watches = new Map<string, Watch>();
const listeners = new Map<string, Set<() => void>>();
// Outcomes no dialog was open to show, kept until the session's workspace takes them.
const notices = new Map<string, string>();
const noticeListeners = new Set<() => void>();

function emit(sessionId: string) {
  for (const listener of listeners.get(sessionId) ?? []) listener();
}
function update(watch: Watch, change: Partial<MoveView>) {
  watch.view = { ...watch.view, ...change };
  emit(watch.client.sessionId);
}
const current = (watch: Watch) => watches.get(watch.client.sessionId) === watch;
function stop(watch: Watch) {
  watch.controller.abort();
  clearTimeout(watch.timer);
  if (current(watch)) watches.delete(watch.client.sessionId);
  emit(watch.client.sessionId);
}
function needed(watch: Watch) {
  return watch.viewers > 0 || watch.view.phase === 'in-flight';
}
function resolve(watch: Watch) {
  if (watch.viewers > 0) return update(watch, { phase: 'resolved' });
  const text = moveOutcomeText(watch.view);
  stop(watch);
  if (!text) return;
  notices.set(watch.client.sessionId, text);
  for (const listener of noticeListeners) listener();
}
/** Decides, after each status, whether the move the user started has an outcome yet. */
function settle(watch: Watch) {
  const { phase, pending, status } = watch.view;
  if (phase !== 'in-flight' || pending || !status) return;
  if (status.failure) return resolve(watch);
  if (status.state === 'moving' || status.state === 'waiting') {
    watch.inGlossSince = undefined;
    return;
  }
  if (status.state !== 'in-gloss') return resolve(watch);
  watch.inGlossSince ??= Date.now();
  if (Date.now() - watch.inGlossSince >= MOVE_OUTCOME_WATCH_MS) resolve(watch);
}
function apply(watch: Watch, request: number, value: unknown) {
  if (!current(watch) || request < watch.applied) return;
  watch.applied = request;
  const status = readMoveStatus(value);
  update(watch, status ? { status, error: '' } : { error: STATUS_UNAVAILABLE });
}
async function poll(watch: Watch) {
  // A POST answers for itself; a poll started before it must not overwrite its answer.
  if (!watch.view.pending) {
    const request = ++watch.issued;
    try {
      apply(watch, request, await watch.client.claudeMove(watch.controller.signal));
    } catch {
      if (current(watch) && !watch.controller.signal.aborted && request >= watch.applied)
        update(watch, { error: STATUS_UNAVAILABLE });
    }
    if (!current(watch) || watch.controller.signal.aborted) return;
    settle(watch);
  }
  if (!current(watch) || watch.controller.signal.aborted) return;
  if (!needed(watch)) return stop(watch);
  watch.timer = setTimeout(() => void poll(watch), MOVE_STATUS_POLL_MS);
}
function watchFor(client: MoveClient): Watch {
  const existing = watches.get(client.sessionId);
  if (existing) return existing;
  const watch: Watch = {
    client,
    view: IDLE_VIEW,
    viewers: 0,
    controller: new AbortController(),
    timer: undefined,
    issued: 0,
    applied: 0,
    inGlossSince: undefined,
  };
  watches.set(client.sessionId, watch);
  void poll(watch);
  return watch;
}
/** A dialog showing the session's move; the returned function is its close. */
export function attachMoveView(client: MoveClient): () => void {
  const watch = watchFor(client);
  watch.viewers++;
  return () => {
    watch.viewers--;
    if (watch.viewers > 0 || !current(watch)) return;
    // Closing a shown outcome ends it; a move still in flight goes on and reports through the notice.
    if (watch.view.phase === 'in-flight') return;
    stop(watch);
  };
}
/** Only called from an explicit, confirmed click (or Don’t move). */
export async function requestMove(client: MoveClient, request: ClaudeMoveRequest): Promise<void> {
  const watch = watchFor(client);
  const cancel = request.action === 'cancel';
  watch.inGlossSince = undefined;
  update(watch, { pending: request.action, error: '', phase: cancel ? 'none' : 'in-flight' });
  const number = ++watch.issued;
  try {
    const value = await client.moveClaude(request);
    if (!current(watch)) return;
    update(watch, { pending: undefined });
    apply(watch, number, value);
  } catch (error) {
    if (!current(watch)) return;
    update(watch, {
      pending: undefined,
      error: errorMessage(
        error,
        cancel ? 'Gloss couldn’t cancel the move' : 'Move to Gloss failed',
      ),
    });
    if (!cancel) return resolve(watch);
  }
  settle(watch);
  if (!needed(watch)) stop(watch);
}
function subscribe(sessionId: string, listener: () => void) {
  const set = listeners.get(sessionId) ?? new Set();
  set.add(listener);
  listeners.set(sessionId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(sessionId);
  };
}
/** The session's Move to Gloss state as last read. */
export const moveViewOf = (sessionId: string) => watches.get(sessionId)?.view ?? IDLE_VIEW;
/** The session's Move to Gloss state, re-read while the calling component is mounted. */
export function useMoveView(client: MoveClient): MoveView {
  const { sessionId } = client;
  useEffect(() => attachMoveView(client), [client]);
  return useSyncExternalStore(
    (listener) => subscribe(sessionId, listener),
    () => moveViewOf(sessionId),
  );
}
/** Whether a dialog for this session must stay up: a move started there is in flight or shows its outcome. */
export function useMoveShown(sessionId: string): boolean {
  return useSyncExternalStore(
    (listener) => subscribe(sessionId, listener),
    () => moveViewOf(sessionId).phase !== 'none',
  );
}
/** The outcome of a move that ended with no dialog open, handed out once. */
export function takeMoveNotice(sessionId: string): string | undefined {
  const text = notices.get(sessionId);
  notices.delete(sessionId);
  return text;
}
/** Hands `show` the outcome of a move that ended with no dialog open, once, while the caller is mounted. */
export function useMoveNotice(sessionId: string, show: (text: string) => void) {
  const latest = useRef(show);
  latest.current = show;
  useEffect(() => {
    const take = () => {
      const text = takeMoveNotice(sessionId);
      if (text !== undefined) latest.current(text);
    };
    take();
    noticeListeners.add(take);
    return () => {
      noticeListeners.delete(take);
    };
  }, [sessionId]);
}
