import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { chunkInput, terminalTicket } from './launch-controls.js';

const COALESCE_MS = 10;
/** One live attachment to a launch's tmux session. Mount it to connect; unmount to disconnect (the session keeps running). */
export function TerminalView({ launchId, onSelection }: { launchId: string; onSelection?(text: string): void }) {
  const host = useRef<HTMLDivElement>(null); const [error, setError] = useState('');
  const selection = useRef(onSelection); selection.current = onSelection;
  useEffect(() => {
    if (!host.current) return;
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
    const selected = term.onSelectionChange(() => selection.current?.(term.getSelection()));
    const resize = () => { try { fit.fit(); } catch { return; } send({ type: 'resize', cols: term.cols, rows: term.rows }); };
    const observer = new ResizeObserver(resize); observer.observe(host.current);
    return () => { disposed = true; if (timer) clearTimeout(timer); observer.disconnect(); input.dispose(); selected.dispose(); ws?.close(); term.dispose(); setError(''); };
  }, [launchId]);
  return <><div ref={host} className="terminal-host" />{error && <p role="alert">{error}</p>}</>;
}
