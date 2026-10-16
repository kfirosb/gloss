import { useEffect, useRef, useState, type FormEvent } from 'react';
import { TerminalView } from './terminal-view.js';
import { errorMessage } from './error-message.js';
import type { SessionClient } from './session-client.js';

/** One terminal line: line breaks become spaces and other control characters go, so nothing extra is pressed. */
export const terminalLine = (text: string) =>
  text
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim();

/** The session's terminal with a Hebrew line under it: the text is translated, then typed into the terminal. */
export function LiveTerminal({
  launchId,
  client,
  attention,
  autoFocus,
  onDraft,
}: {
  launchId: string;
  client: SessionClient;
  attention: boolean;
  autoFocus: boolean;
  /** Told whether the line holds unsent text, so the panel does not hide it. */
  onDraft?(hasDraft: boolean): void;
}) {
  const inputRef = useRef<((text: string) => boolean) | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    onDraft?.(text.trim() !== '');
    return () => onDraft?.(false);
  }, [text]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError('');
    try {
      const line = terminalLine(await client.translateComposer(value));
      if (!line) throw new Error('The translation came back empty.');
      if (!inputRef.current?.(line + '\r')) throw new Error('The terminal is not connected.');
      setText('');
    } catch (cause) {
      // Keep the text so nothing the user wrote is lost.
      setError(errorMessage(cause, 'Could not send to the terminal.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`live-terminal${attention ? ' attn-ring' : ''}`}>
      <TerminalView launchId={launchId} autoFocus={autoFocus} inputRef={inputRef} />
      {error && <p role="alert">{error}</p>}
      <form className="live-terminal-line" onSubmit={send}>
        <input
          type="text"
          dir="auto"
          aria-label="Write to the terminal"
          value={text}
          // Read-only rather than disabled while translating, so the focus stays in the line.
          readOnly={busy}
          aria-busy={busy}
          placeholder={busy ? 'Translating…' : undefined}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" disabled={busy || !text.trim()}>
          {busy ? 'Translating…' : 'Send'}
        </button>
      </form>
    </div>
  );
}
