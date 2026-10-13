import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { chunkInput, terminalTicket } from './launch-controls.js';

const COALESCE_MS = 10;
export function TerminalPopup({ launchId, title, open, onClose }: { launchId: string; title: string; open: boolean; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null); const host = useRef<HTMLDivElement>(null); const [error, setError] = useState('');
  useEffect(() => { if (open) { if (!dialog.current?.open) dialog.current?.showModal(); } else dialog.current?.close(); }, [open]);
  useEffect(() => {
    if (!open || !host.current) return;
    const term = new Terminal({ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13, cursorBlink: true });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current); fit.fit(); term.focus();
    let ws: WebSocket | undefined; let disposed = false; let pending = ''; let timer: ReturnType<typeof setTimeout> | undefined;
    const send = (value: unknown) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
    // Coalesce keystrokes/pastes within a short tick, then send in frames far below the server's cap.
    const flush = () => { timer = undefined; const data = pending; pending = ''; for (const part of chunkInput(data)) send({ type: 'input', data: part }); };
    terminalTicket(launchId).then(({ ticket }) => {
      if (disposed) return;
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/launches/${encodeURIComponent(launchId)}/terminal?ticket=${encodeURIComponent(ticket)}`);
      ws.binaryType = 'arraybuffer';
      ws.onmessage = e => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
      ws.onopen = () => { send({ type: 'resize', cols: term.cols, rows: term.rows }); if (pending && !timer) flush(); };
      ws.onclose = () => { if (!disposed) setError('Terminal disconnected. The session keeps running.'); };
    }, e => { if (!disposed) setError(e instanceof Error ? e.message : 'Terminal unavailable'); });
    const input = term.onData(data => { pending += data; timer ??= setTimeout(flush, COALESCE_MS); });
    const resize = () => { try { fit.fit(); } catch { return; } send({ type: 'resize', cols: term.cols, rows: term.rows }); };
    const observer = new ResizeObserver(resize); observer.observe(host.current);
    return () => { disposed = true; if (timer) clearTimeout(timer); observer.disconnect(); input.dispose(); ws?.close(); term.dispose(); setError(''); };
  }, [open, launchId]);
  return <dialog ref={dialog} className="terminal-popup" aria-label={`Terminal: ${title}`} onCancel={e => { e.preventDefault(); onClose(); }}>
    <div className="review-header"><h2>Terminal · {title}</h2><span className="terminal-hint">Answer here, then close. The session keeps running.</span><button type="button" aria-label={`Close terminal ${title}`} onClick={onClose}>×</button></div>
    <div ref={host} className="terminal-host" />{error && <p role="alert">{error}</p>}
  </dialog>;
}
