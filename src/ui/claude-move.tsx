import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { ClaudeMoveFailure, ClaudeMoveRequest } from '../runtime/claude-move.js';
import type { SessionClient } from './session-client.js';
import {
  MOVE_DONE_TEXT,
  moveViewOf,
  requestMove,
  useMoveView,
  type MoveClient,
} from './claude-move-watch.js';

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
type Confirmable = Exclude<ClaudeMoveRequest, { action: 'cancel' }>;
const WAITING_TEXT = 'Gloss will move this session when Claude finishes.';
const MOVING_TEXT = 'Moving the session to Gloss…';
/**
 * Spec 5: the compact Move to Gloss popover for one outside Claude session, in one step: pressing Move (or Move when
 * it finishes) is the confirmation. Its buttons exist only while the status shows the state they act on, and each
 * posts the identity in the status shown, so a confirmation never outlives its status. A move started here keeps
 * being watched after this closes (claude-move-watch). `onClose(returnFocus)`: false for an outside click.
 */
export function MovePopover({
  client,
  onClose,
  inline = false,
  opener,
}: {
  client: MoveClient;
  onClose(returnFocus: boolean): void;
  /** Shown in place (the connect dialog) rather than floating over the page. */
  inline?: boolean;
  /** The button that toggles the popover; pressing it is not an outside click. */
  opener?: RefObject<HTMLElement | null>;
}) {
  const { status, pending, error } = useMoveView(client);
  const id = useId();
  const root = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    root.current?.focus();
    const outside = (event: PointerEvent) => {
      const { target } = event;
      if (
        target instanceof Node &&
        (root.current?.contains(target) || opener?.current?.contains(target))
      )
        return;
      close.current(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  const busy = pending !== undefined;
  const act = (request: ClaudeMoveRequest) => {
    // One POST per click: a second click before the first one's pending state renders sends nothing.
    if (moveViewOf(client.sessionId).pending) return;
    void requestMove(client, request);
    // The pressed button gives way to the progress line; focus stays here so Escape still closes the popover.
    root.current?.focus();
  };
  const confirmation = (request: Confirmable, label: string) => (
    <>
      <p>{MOVE_CONFIRMATION}</p>
      <div className="move-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => act(request)}>
          {label}
        </button>
        <button type="button" onClick={() => onClose(true)}>
          Cancel
        </button>
      </div>
    </>
  );
  return (
    <section
      ref={root}
      role="dialog"
      aria-labelledby={id}
      tabIndex={-1}
      className={'move-popover' + (inline ? ' inline' : '')}
      dir="ltr"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClose(true);
      }}
    >
      <h3 id={id}>Move to Gloss</h3>
      {status?.failure && <FailureNote failure={status.failure} />}
      {status?.state === 'moving' || pending === 'move' ? (
        <p role="status">{MOVING_TEXT}</p>
      ) : status?.state === 'ready' ? (
        confirmation({ action: 'move', expected: status.process }, 'Move')
      ) : status?.state === 'busy' ? (
        <>
          <p>{status.reason}</p>
          {confirmation({ action: 'when-idle', expected: status.process }, 'Move when it finishes')}
        </>
      ) : status?.state === 'waiting' ? (
        <>
          <p role="status">{WAITING_TEXT}</p>
          <div className="move-actions">
            <button type="button" disabled={busy} onClick={() => act({ action: 'cancel' })}>
              Don’t move
            </button>
          </div>
        </>
      ) : status?.state === 'in-gloss' ? (
        <p>{MOVE_DONE_TEXT}</p>
      ) : status?.state === 'unavailable' ? (
        <p>{status.reason}</p>
      ) : null}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
/**
 * The Live Conversation view switch's control for an outside Claude session, where Split and Terminal would be:
 * it opens the compact popover. Each rendered copy (docked and expanded toolbars) keeps its own popover.
 */
export function MoveSessionHere({ client }: { client: MoveClient }) {
  const [asking, setAsking] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <span className="move-anchor">
      <button
        ref={button}
        type="button"
        className="move-here"
        aria-haspopup="dialog"
        aria-expanded={asking}
        onClick={() => setAsking((open) => !open)}
      >
        Move session here
      </button>
      {asking && (
        <MovePopover
          client={client}
          opener={button}
          onClose={(returnFocus) => {
            setAsking(false);
            if (returnFocus) button.current?.focus();
          }}
        />
      )}
    </span>
  );
}
/** The connect dialog's Move to Gloss control: the status in place, and the compact popover to confirm. */
export function MoveToGloss({ client }: { client: SessionClient }) {
  const { status, pending, error } = useMoveView(client);
  const [asking, setAsking] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (asking)
    return (
      <MovePopover
        client={client}
        inline
        onClose={(returnFocus) => {
          setAsking(false);
          if (returnFocus) requestAnimationFrame(() => trigger.current?.focus());
        }}
      />
    );
  const busy = pending !== undefined;
  return (
    <div className="move-to-gloss" dir="ltr">
      {status?.failure && <FailureNote failure={status.failure} />}
      {status?.state === 'moving' || pending === 'move' ? (
        <p role="status">{MOVING_TEXT}</p>
      ) : status?.state === 'ready' ? (
        <button ref={trigger} type="button" disabled={busy} onClick={() => setAsking(true)}>
          Move to Gloss
        </button>
      ) : status?.state === 'busy' ? (
        <>
          <button type="button" disabled>
            {status.reason}
          </button>
          <button ref={trigger} type="button" disabled={busy} onClick={() => setAsking(true)}>
            Move when it finishes
          </button>
        </>
      ) : status?.state === 'waiting' ? (
        <>
          <p role="status">{WAITING_TEXT}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void requestMove(client, { action: 'cancel' })}
          >
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
