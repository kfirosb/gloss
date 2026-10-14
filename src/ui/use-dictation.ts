import { useCallback, useEffect, useRef, useState } from 'react';
import { SAMPLE_RATE, type DictationLanguage, type DictationServerMessage, type DictationStatus } from '../core/dictation-contracts.js';
import { authHeaders, capabilityToken } from './session-client.js';
import { initialDictationState, reduceDictation, type DictationEffect, type DictationUiEvent, type DictationUiState } from './dictation-state.js';
import { PCM_PROCESSOR_NAME, workletUrl } from './pcm-worklet.js';
import { PendingFrames } from './pcm-queue.js';

export interface UseDictationOptions { sessionId: string; language: DictationLanguage; appendText(text: string): void; sendNow(): void; enabled: boolean }
export interface Dictation { state: DictationUiState; /** Latest input level (0..1), kept outside React state so capture frames do not re-render the workspace. */ readLevel(): number; press(): void; escape(): boolean; /** Asks to send once dictation has finished; false (and nothing happens) when no recording is in progress, so the caller sends now. */ requestSend(): boolean; dismissNotice(): void;
  /** True while the one-time model download dialog is open (the first press when the speech model is not on disk yet). */
  confirmingDownload: boolean; acceptDownload(): void; declineDownload(): void }

const fetchStatus = (signal?: AbortSignal) => fetch('/api/dictation', { headers: authHeaders(), ...(signal ? { signal } : {}) }).then(r => r.ok ? r.json() as Promise<DictationStatus> : Promise.reject(new Error(String(r.status))));

export function useDictation(options: UseDictationOptions): Dictation {
  const [state, setState] = useState<DictationUiState>(initialDictationState);
  const current = useRef(state); current.current = state;
  const latest = useRef(options); latest.current = options;
  const stream = useRef<MediaStream | undefined>(undefined); const context = useRef<AudioContext | undefined>(undefined);
  const socket = useRef<WebSocket | undefined>(undefined); const finishTimer = useRef<number | undefined>(undefined); const level = useRef(0);
  // Frames captured while the socket is still connecting; flushed in order on open so the first words are not lost.
  const pending = useRef(new PendingFrames());
  // Last known model presence from GET /api/dictation, and whether the download dialog was accepted in this page session.
  const modelPresent = useRef<boolean | undefined>(undefined); const downloadAccepted = useRef(false);
  const [confirmingDownload, setConfirmingDownload] = useState(false);
  const dispatch = useCallback((event: DictationUiEvent) => {
    const { state: next, effects } = reduceDictation(current.current, event);
    current.current = next; setState(next);
    for (const effect of effects) run(effect);
  }, []);
  const readLevel = useCallback(() => level.current, []);
  const stopStream = () => { context.current?.close().catch(() => undefined); context.current = undefined; stream.current?.getTracks().forEach(t => t.stop()); stream.current = undefined; level.current = 0; };
  // Detach before closing so onclose never dispatches for a socket we abandoned on purpose.
  const closeSocket = () => { const ws = socket.current; socket.current = undefined; pending.current.clear(); ws?.close(1000); };
  function run(effect: DictationEffect) {
    const o = latest.current;
    switch (effect.type) {
      case 'request-mic':
        if (!navigator.mediaDevices?.getUserMedia) { dispatch({ type: 'mic-denied' }); return; }
        navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }).then(s => { if (current.current.phase !== 'starting') { s.getTracks().forEach(t => t.stop()); return; } if (stream.current) stopStream(); /* a stream left from an earlier attempt must not block this one */ stream.current = s; dispatch({ type: 'mic-ready' }); }, () => { if (current.current.phase === 'starting') dispatch({ type: 'mic-denied' }); });
        return;
      case 'open-socket': {
        closeSocket();
        const url = new URL('/api/dictation/audio', location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('capability', capabilityToken() ?? ''); url.searchParams.set('session', o.sessionId); url.searchParams.set('language', o.language);
        const ws = new WebSocket(url); ws.binaryType = 'arraybuffer'; socket.current = ws;
        ws.onmessage = e => { if (socket.current !== ws || typeof e.data !== 'string') return; let m: DictationServerMessage; try { m = JSON.parse(e.data) as DictationServerMessage; } catch { return; } dispatch({ type: 'server', message: m }); };
        ws.onclose = e => { if (socket.current === ws) { socket.current = undefined; pending.current.clear(); dispatch({ type: 'socket-closed', clean: e.code === 1000 }); } };
        ws.addEventListener('open', () => { if (socket.current === ws) pending.current.flush(f => ws.send(f)); });
        ws.onerror = () => undefined;
        return;
      }
      case 'start-stream': {
        const s = stream.current; if (!s || context.current) return;
        let ctx: AudioContext; try { ctx = new AudioContext({ sampleRate: SAMPLE_RATE }); } catch { ctx = new AudioContext(); }
        context.current = ctx;
        void ctx.audioWorklet.addModule(workletUrl()).then(() => {
          if (context.current !== ctx) return;
          const node = new AudioWorkletNode(ctx, PCM_PROCESSOR_NAME, { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
          node.port.onmessage = e => { if (context.current !== ctx) return; const { pcm, level: frameLevel } = e.data as { pcm: Int16Array<ArrayBuffer>; level: number }; const ws = socket.current; if (ws?.readyState === WebSocket.OPEN) ws.send(pcm.buffer); else if (ws?.readyState === WebSocket.CONNECTING) pending.current.push(pcm.buffer); level.current = frameLevel; };
          ctx.createMediaStreamSource(s).connect(node);
        }).catch(() => { if (context.current === ctx) dispatch({ type: 'server', message: { type: 'error', code: 'engine-failed', message: 'Audio capture could not start' } }); });
        return;
      }
      case 'stop-stream': stopStream(); return;
      case 'send-stop': {
        // Stopping before the mic or the socket is up: with no socket there is nothing to drain, so finish now;
        // a socket still connecting gets the stop as soon as it opens (the server holds it until the engine is ready).
        const ws = socket.current, stop = JSON.stringify({ type: 'stop' });
        if (!ws) queueMicrotask(() => { if (!socket.current && current.current.phase === 'finishing') dispatch({ type: 'socket-closed', clean: true }); });
        else if (ws.readyState === WebSocket.OPEN) ws.send(stop);
        else if (ws.readyState === WebSocket.CONNECTING) ws.addEventListener('open', () => ws.send(stop), { once: true });
        return;
      }
      case 'close-socket': closeSocket(); return;
      case 'cancel-download': void fetch('/api/dictation/model/cancel', { method: 'POST', headers: authHeaders() }).catch(() => undefined); return;
      case 'append-text': o.appendText(effect.text); return;
      case 'send-now': o.sendNow(); return;
      // The reducer may ask again while already finishing (e.g. Send after Stop shortens the wait): restart, never stack.
      case 'start-finish-timer': window.clearTimeout(finishTimer.current); finishTimer.current = window.setTimeout(() => { finishTimer.current = undefined; dispatch({ type: 'finish-timeout' }); }, effect.ms); return;
      case 'clear-finish-timer': window.clearTimeout(finishTimer.current); finishTimer.current = undefined; return;
    }
  }
  useEffect(() => {
    if (!options.enabled) return;
    const controller = new AbortController();
    fetchStatus(controller.signal).then(status => { modelPresent.current = status.model.present; dispatch({ type: 'status', status }); }, () => { if (!controller.signal.aborted) dispatch({ type: 'status-failed' }); });
    return () => controller.abort();
  }, [options.enabled, dispatch]);
  const press = () => {
    const p = current.current.phase;
    if ((p !== 'idle' && p !== 'error') || downloadAccepted.current || modelPresent.current !== false) { dispatch({ type: 'press', now: Date.now() }); return; }
    // The model looked absent: re-check (another window may have downloaded it) before asking about the one-time download.
    fetchStatus().then(status => { modelPresent.current = status.model.present; return status.model.present; }, () => false).then(present => {
      const q = current.current.phase; if (q !== 'idle' && q !== 'error') return;
      if (present) dispatch({ type: 'press', now: Date.now() }); else setConfirmingDownload(true);
    });
  };
  // On session change or unmount: let the reducer go idle, then release anything still held (the reducer neither clears the
  // finish timer here nor closes a socket left open after an error phase).
  useEffect(() => () => { dispatch({ type: 'session-changed' }); window.clearTimeout(finishTimer.current); finishTimer.current = undefined; closeSocket(); stopStream(); }, [options.sessionId, dispatch]);
  return {
    state,
    readLevel,
    press,
    confirmingDownload,
    acceptDownload: () => { downloadAccepted.current = true; setConfirmingDownload(false); dispatch({ type: 'press', now: Date.now() }); },
    declineDownload: () => setConfirmingDownload(false),
    escape: () => { const p = current.current.phase; if (p !== 'starting' && p !== 'recording') return false; dispatch({ type: 'escape' }); return true; },
    requestSend: () => { const p = current.current.phase; if (p !== 'starting' && p !== 'recording' && p !== 'finishing') return false; dispatch({ type: 'send-requested' }); return true; },
    dismissNotice: () => dispatch({ type: 'dismiss-notice' }),
  };
}
