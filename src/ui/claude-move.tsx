import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { ClaudeMoveFailure, ClaudeMoveRequest } from '../runtime/claude-move.js';
import type { SessionClient } from './session-client.js';
import { useDisplayPreferences } from './display-preferences.js';
import {
  MOVE_DONE_TEXT,
  MOVE_MOVING_TEXT,
  MOVE_WAITING_TEXT,
  moveViewOf,
  moveWithoutAsking,
  requestMove,
  useMoveProgress,
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
/**
 * Starts Move to Gloss from a click. Normally `ask` shows the popover; with "Don’t ask again" set on this device the
 * click is the confirmation and the move starts at once (claude-move-watch reads the status it acts on), and the
 * popover opens only when there is nothing to do at once, so the user sees why. A late answer for an older click
 * or an unmounted caller opens nothing.
 */
export function useMoveLauncher(): (client: MoveClient, ask: () => void) => void {
  const [preferences] = useDisplayPreferences();
  const latest = useRef(0);
  useEffect(
    () => () => {
      latest.current++;
    },
    [],
  );
  return (client, ask) => {
    const click = ++latest.current;
    if (!preferences.moveWithoutConfirmation) return ask();
    void moveWithoutAsking(client).then((started) => {
      if (!started && click === latest.current) ask();
    });
  };
}
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
  const [, updatePreferences] = useDisplayPreferences();
  const [dontAsk, setDontAsk] = useState(false);
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
    if (request.action !== 'cancel' && dontAsk)
      updatePreferences((value) => ({ ...value, moveWithoutConfirmation: true }));
    void requestMove(client, request);
    // The pressed button gives way to the progress line; focus stays here so Escape still closes the popover.
    root.current?.focus();
  };
  const confirmation = (request: Confirmable, label: string) => (
    <>
      <p>{MOVE_CONFIRMATION}</p>
      <label className="move-dont-ask">
        <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />{' '}
        Don’t ask again
      </label>
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
        <p role="status">{MOVE_MOVING_TEXT}</p>
      ) : status?.state === 'ready' ? (
        confirmation({ action: 'move', expected: status.process }, 'Move')
      ) : status?.state === 'busy' ? (
        <>
          <p>{status.reason}</p>
          {confirmation({ action: 'when-idle', expected: status.process }, 'Move when it finishes')}
        </>
      ) : status?.state === 'waiting' ? (
        <>
          <p role="status">{MOVE_WAITING_TEXT}</p>
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
  const launch = useMoveLauncher();
  // A move started without the popover reports here: its progress, then the outcome as the session's notice.
  const progress = useMoveProgress(client.sessionId);
  return (
    <span className="move-anchor">
      <button
        ref={button}
        type="button"
        className="move-here"
        aria-haspopup="dialog"
        aria-expanded={asking}
        onClick={() => (asking ? setAsking(false) : launch(client, () => setAsking(true)))}
      >
        Move session here
      </button>
      {!asking && progress && (
        <small className="live-attention-notice" role="status" dir="auto">
          {progress}
        </small>
      )}
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
  const launch = useMoveLauncher();
  const ask = () => launch(client, () => setAsking(true));
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
        <p role="status">{MOVE_MOVING_TEXT}</p>
      ) : status?.state === 'ready' ? (
        <button ref={trigger} type="button" disabled={busy} onClick={ask}>
          Move to Gloss
        </button>
      ) : status?.state === 'busy' ? (
        <>
          <button type="button" disabled>
            {status.reason}
          </button>
          <button ref={trigger} type="button" disabled={busy} onClick={ask}>
            Move when it finishes
          </button>
        </>
      ) : status?.state === 'waiting' ? (
        <>
          <p role="status">{MOVE_WAITING_TEXT}</p>
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
