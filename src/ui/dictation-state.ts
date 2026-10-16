import {
  DICTATION_REASON_TEXT,
  FINISH_TIMEOUT_MS,
  MAX_RECORDING_MS,
  type DictationLanguage,
  type DictationServerMessage,
  type DictationStatus,
} from '../core/dictation-contracts.js';
import { languageName } from '../core/language-settings.js';

export type DictationPhase =
  'idle' | 'downloading' | 'starting' | 'recording' | 'finishing' | 'unavailable' | 'error';
export interface DictationUiState {
  phase: DictationPhase;
  reason?: string;
  message?: string;
  notice?: string;
  received?: number;
  total?: number | null;
  startedAt?: number;
  sendAfterFinish: boolean;
  lastSequence: number;
}
export type DictationUiEvent =
  | { type: 'status'; status: DictationStatus }
  | { type: 'status-failed' }
  | { type: 'press'; now: number }
  | { type: 'mic-ready' }
  | { type: 'mic-denied' }
  | { type: 'server'; message: DictationServerMessage }
  | { type: 'socket-closed'; clean: boolean }
  | { type: 'escape' }
  | { type: 'send-requested' }
  | { type: 'finish-timeout' }
  | { type: 'session-changed' }
  | { type: 'retry' }
  | { type: 'dismiss-notice' };
export type DictationEffect =
  | { type: 'request-mic' }
  | { type: 'open-socket' }
  | { type: 'start-stream' }
  | { type: 'stop-stream' }
  | { type: 'send-stop' }
  | { type: 'close-socket' }
  | { type: 'cancel-download' }
  | { type: 'append-text'; text: string }
  | { type: 'send-now' }
  | { type: 'start-finish-timer'; ms: number }
  | { type: 'clear-finish-timer' };
/** How long a plain Stop/Escape waits for the server's 'finished' before giving up (send-initiated stops use FINISH_TIMEOUT_MS). */
export const STOP_TIMEOUT_MS = 15_000;
export const initialDictationState: DictationUiState = {
  phase: 'idle',
  sendAfterFinish: false,
  lastSequence: 0,
};
const NOTICE_TEXT = {
  'segment-lost': 'One segment could not be transcribed',
  'max-duration': 'Recording stopped after ' + Math.round(MAX_RECORDING_MS / 60_000) + ' minutes',
} as const;
const active = (p: DictationPhase) =>
  p === 'downloading' || p === 'starting' || p === 'recording' || p === 'finishing';
const idle = (s: DictationUiState, extra: Partial<DictationUiState> = {}): DictationUiState => ({
  ...initialDictationState,
  ...(s.notice ? { notice: s.notice } : {}),
  ...extra,
});

export function appendDictation(existing: string, text: string): string {
  if (!existing) return text;
  return /\s$/.test(existing) ? existing + text : existing + ' ' + text;
}

export function reduceDictation(
  state: DictationUiState,
  event: DictationUiEvent,
): { state: DictationUiState; effects: DictationEffect[] } {
  const out = (next: DictationUiState, ...effects: DictationEffect[]) => ({ state: next, effects });
  const pendingSend: DictationEffect[] = state.sendAfterFinish
    ? [{ type: 'clear-finish-timer' }, { type: 'send-now' }]
    : state.phase === 'finishing'
      ? [{ type: 'clear-finish-timer' }]
      : [];
  // Every entry into 'finishing' arms a timer so a server that never answers cannot leave the button stuck.
  const finishing = (next: DictationUiState, ...effects: DictationEffect[]) =>
    out({ ...next, phase: 'finishing' }, ...effects, {
      type: 'start-finish-timer',
      ms: next.sendAfterFinish ? FINISH_TIMEOUT_MS : STOP_TIMEOUT_MS,
    });
  switch (event.type) {
    case 'status':
      return event.status.available
        ? out(state.phase === 'unavailable' ? idle(state) : state)
        : out({
            ...state,
            phase: 'unavailable',
            reason: event.status.reason
              ? DICTATION_REASON_TEXT[event.status.reason]
              : 'Dictation unavailable',
          });
    case 'status-failed':
      return out({ ...state, phase: 'unavailable', reason: 'Dictation status unavailable' });
    case 'press':
      if (state.phase === 'idle' || state.phase === 'error')
        return out(
          { ...idle(state), phase: 'starting', startedAt: event.now },
          { type: 'request-mic' },
        );
      if (state.phase === 'downloading')
        return out(
          idle(state),
          { type: 'cancel-download' },
          { type: 'close-socket' },
          { type: 'stop-stream' },
        );
      if (state.phase === 'starting' || state.phase === 'recording')
        return finishing(state, { type: 'send-stop' }, { type: 'stop-stream' });
      return out(state);
    // Capture starts with the socket: the server buffers audio sent while the engine is still downloading or starting.
    case 'mic-ready':
      return state.phase === 'starting'
        ? out(state, { type: 'open-socket' }, { type: 'start-stream' })
        : out(state);
    case 'mic-denied':
      return out({
        ...idle(state),
        phase: 'unavailable',
        reason: DICTATION_REASON_TEXT['microphone-denied'],
      });
    case 'escape':
      return state.phase === 'starting' || state.phase === 'recording'
        ? finishing(
            { ...state, sendAfterFinish: false },
            { type: 'send-stop' },
            { type: 'stop-stream' },
          )
        : out(state);
    case 'send-requested':
      if (state.phase === 'starting' || state.phase === 'recording')
        return finishing(
          { ...state, sendAfterFinish: true },
          { type: 'send-stop' },
          { type: 'stop-stream' },
        );
      if (state.phase === 'finishing') return finishing({ ...state, sendAfterFinish: true });
      return out(state, { type: 'send-now' });
    case 'finish-timeout':
      return state.phase === 'finishing'
        ? out(
            idle(state),
            { type: 'close-socket' },
            ...(state.sendAfterFinish ? [{ type: 'send-now' } as const] : []),
          )
        : out(state);
    case 'retry':
      return state.phase === 'error' ? out(idle(state)) : out(state);
    case 'dismiss-notice': {
      const { notice: _n, ...rest } = state;
      return out(rest);
    }
    case 'session-changed': {
      const { notice: _n, ...rest } = state;
      return active(state.phase)
        ? out(idle(rest), { type: 'close-socket' }, { type: 'stop-stream' })
        : out(state);
    }
    case 'socket-closed':
      if (!active(state.phase)) return out(state);
      if (event.clean && state.phase === 'finishing') return out(idle(state), ...pendingSend);
      return out(
        {
          ...state,
          phase: 'error',
          message: 'Connection to the dictation server was lost',
          sendAfterFinish: false,
        },
        { type: 'stop-stream' },
        ...pendingSend,
      );
    case 'server': {
      const m = event.message;
      if (m.type === 'state') {
        if (m.state === 'downloading')
          return out({
            ...state,
            phase: active(state.phase) && state.phase !== 'finishing' ? 'downloading' : state.phase,
            received: m.received,
            total: m.total,
          });
        if (m.state === 'starting')
          return out(state.phase === 'downloading' ? { ...state, phase: 'starting' } : state);
        if (m.state === 'recording')
          return state.phase === 'starting' || state.phase === 'downloading'
            ? out({ ...state, phase: 'recording' })
            : out(state);
        // 'finished' can arrive outside 'finishing' (the server ended the recording itself, e.g. the 10-minute cap): accept it from any active phase.
        if (!active(state.phase)) return out(state);
        return out(
          idle(state),
          ...(state.sendAfterFinish || state.phase === 'finishing'
            ? [{ type: 'clear-finish-timer' } as const]
            : []),
          ...(state.phase !== 'finishing' ? [{ type: 'stop-stream' } as const] : []),
          { type: 'close-socket' },
          ...(state.sendAfterFinish ? [{ type: 'send-now' } as const] : []),
        );
      }
      if (m.type === 'segment')
        return m.sequence <= state.lastSequence
          ? out(state)
          : out({ ...state, lastSequence: m.sequence }, { type: 'append-text', text: m.text });
      if (m.type === 'notice') {
        const notice = NOTICE_TEXT[m.code];
        // The server is already stopping at the cap: stop capturing and wait for the remaining segments and 'finished'.
        if (
          m.code === 'max-duration' &&
          (state.phase === 'starting' || state.phase === 'recording')
        )
          return finishing({ ...state, notice }, { type: 'stop-stream' });
        return out({ ...state, notice });
      }
      const reason =
        m.code === 'engine-missing' || m.code === 'microphone-denied'
          ? DICTATION_REASON_TEXT[m.code]
          : undefined;
      return out(
        reason
          ? { ...idle(state), phase: 'unavailable', reason }
          : { ...idle(state), phase: 'error', message: m.message },
        { type: 'stop-stream' },
        ...pendingSend,
      );
    }
  }
}

/** The keyboard shortcut that toggles dictation: Cmd (or Ctrl) + Shift + M, matched by physical key or by character. */
export const isDictationShortcut = (
  e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'code' | 'key'>,
) => (e.metaKey || e.ctrlKey) && e.shiftKey && (e.code === 'KeyM' || e.key.toLowerCase() === 'm');
export const DICTATION_SHORTCUT_LABEL = '⌘⇧M';

export function dictationLabel(
  state: DictationUiState,
  language: DictationLanguage,
): { title: string; progress?: string } {
  const mb = (n: number) => Math.round(n / (1024 * 1024)) + ' MB';
  switch (state.phase) {
    case 'idle':
      return { title: 'Dictate in ' + languageName(language) };
    case 'downloading':
      return {
        title: 'Downloading the speech model, you can talk now, click to cancel',
        progress: state.total
          ? Math.floor(((state.received ?? 0) * 100) / state.total) + '%'
          : mb(state.received ?? 0),
      };
    case 'starting':
      return { title: 'Starting the speech engine, you can talk now' };
    case 'recording':
      return { title: 'Stop dictation' };
    case 'finishing':
      return { title: 'Finishing' };
    case 'unavailable':
      return { title: 'Dictation unavailable: ' + (state.reason ?? '') };
    case 'error':
      return { title: 'Dictation failed: ' + (state.message ?? '') + '. Click to retry' };
  }
}
