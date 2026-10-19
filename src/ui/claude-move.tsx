import { useRef, useState } from 'react';
import type { ClaudeMoveFailure, ClaudeMoveRequest } from '../runtime/claude-move.js';
import type { SessionClient } from './session-client.js';
import { MOVE_DONE_TEXT, requestMove, useMoveView } from './claude-move-watch.js';

/** Spec 5.2, verbatim. */
export const MOVE_CONFIRMATION =
  "Claude in the other terminal will close, and the session will continue here with all its history. Text you typed there and didn't send will be lost, and so will commands still running in the background of that session.";

/** Copies `text`; when the clipboard is unavailable, selects the field so the user can copy it by hand. */
export async function copyCommand(text: string, field: HTMLTextAreaElement | null) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    field?.select();
  }
}
/** Spec 5.6: the reason, and when the session was closed, the command that reopens it by hand. */
function FailureNote({ failure }: { failure: ClaudeMoveFailure }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const { manual } = failure;
  return (
    <div role="alert">
      <p>{failure.reason}</p>
      {manual && (
        <>
          <p>The session's history is kept. Open it in a terminal with:</p>
          <textarea
            ref={field}
            aria-label="Claude resume command"
            readOnly
            rows={1}
            value={manual.cdCommand}
          />
          <button type="button" onClick={() => void copyCommand(manual.cdCommand, field.current)}>
            Copy
          </button>
          <button type="button" onClick={() => void copyCommand(manual.command, field.current)}>
            Copy without cd
          </button>
        </>
      )}
    </div>
  );
}
/**
 * Spec 5: Move to Gloss for one outside Claude session. Nothing is sent before the user confirms, and the identity
 * sent is the one the user saw. A move started here keeps being watched after this closes (claude-move-watch).
 */
export function MoveToGloss({ client }: { client: SessionClient }) {
  const { status, pending, error } = useMoveView(client);
  const [confirming, setConfirming] = useState<Exclude<
    ClaudeMoveRequest,
    { action: 'cancel' }
  > | null>(null);
  const act = (request: ClaudeMoveRequest) => {
    setConfirming(null);
    void requestMove(client, request);
  };
  const busy = pending !== undefined;
  return (
    <div className="move-to-gloss" dir="ltr">
      {status?.failure && <FailureNote failure={status.failure} />}
      {confirming ? (
        <div role="group" aria-label="Confirm Move to Gloss">
          <p>{MOVE_CONFIRMATION}</p>
          <button type="button" className="primary" onClick={() => act(confirming)}>
            Move
          </button>
          <button type="button" onClick={() => setConfirming(null)}>
            Cancel
          </button>
        </div>
      ) : status?.state === 'moving' || pending === 'move' ? (
        <p role="status">Moving the session to Gloss…</p>
      ) : status?.state === 'ready' ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirming({ action: 'move', expected: status.process })}
        >
          Move to Gloss
        </button>
      ) : status?.state === 'busy' ? (
        <>
          <button type="button" disabled>
            {status.reason}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming({ action: 'when-idle', expected: status.process })}
          >
            Move when it finishes
          </button>
        </>
      ) : status?.state === 'waiting' ? (
        <>
          <p role="status">Gloss will move this session when Claude finishes.</p>
          <button type="button" disabled={busy} onClick={() => act({ action: 'cancel' })}>
            Don’t move
          </button>
        </>
      ) : status?.state === 'in-gloss' ? (
        <p>{MOVE_DONE_TEXT}</p>
      ) : status?.state === 'unavailable' ? (
        <p>{status.reason}</p>
      ) : null}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
