import { useRef, useState, type FormEvent } from 'react';
import { TerminalView } from './terminal-view.js';
import { errorMessage } from './error-message.js';
import type { SessionClient } from './session-client.js';

/** The session's terminal with a Hebrew line under it: the text is translated, then typed into the terminal. */
export function LiveTerminal({
  launchId,
  client,
  attention,
  autoFocus,
}: {
  launchId: string;
  client: SessionClient;
  attention: boolean;
  autoFocus: boolean;
}) {
  const inputRef = useRef<((text: string) => boolean) | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError('');
    try {
      const translation = await client.translateComposer(value);
      if (!inputRef.current?.(translation + '\r'))
        throw new Error('The terminal is not connected.');
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
          disabled={busy}
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
