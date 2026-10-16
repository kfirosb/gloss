import { AttachmentCards } from './attachment-cards.js';
import { useEffect, useRef, useState } from 'react';
import type { Draft, Delivery } from '../core/contracts.js';
import { RichText } from './rich-text.js';
import { providerLabel } from './provider-label.js';
export interface InstructionReview {
  draft: Draft;
  localizedText: string;
}
export function InstructionReviewDialog({
  review,
  open,
  busy,
  blocked,
  channelReady = true,
  peerBlocked,
  delivery,
  error,
  onChange,
  onClose,
  onSend,
  onPeerSend,
  onReset,
}: {
  review: InstructionReview;
  open: boolean;
  busy: boolean;
  blocked: boolean;
  delivery?: Delivery;
  error: string;
  channelReady?: boolean;
  peerBlocked?: boolean;
  onPeerSend?: () => void;
  onChange(text: string): void;
  onClose(): void;
  onSend(): void;
  onReset(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    setEditing(false);
  }, [review.draft.id]);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  const pending = Boolean(
    delivery && ['sending', 'queued', 'unconfirmed'].includes(delivery.state),
  );
  const status = busy
    ? 'Preparing / Sending'
    : delivery
      ? {
          sending: 'Sending',
          held: 'Waiting for the terminal',
          queued: 'Queued',
          unconfirmed:
            review.draft.target.agent === 'claude' ? 'Awaiting Claude confirmation' : 'Unconfirmed',
          failed: 'Failed',
          sent: 'Sent',
        }[delivery.state]
      : blocked
        ? 'Blocked: agent is working or unavailable'
        : !channelReady
          ? 'Channel setup required for normal Send'
          : 'Ready';
  return (
    <dialog
      ref={dialog}
      className="instruction-review"
      aria-label="Review instruction"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="review-header">
        <h2>Review instruction</h2>
        <button type="button" aria-label="Close review" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="review-hint">
        Review and edit in Hebrew. Send delivers the equivalent concise English instruction to the
        coding agent.
      </p>
      <div className="review-body">
        {editing ? (
          <textarea
            dir="rtl"
            aria-label="Edit Hebrew instruction"
            disabled={busy || pending}
            value={review.localizedText}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <RichText language={review.draft.language} text={review.localizedText} />
        )}
        <AttachmentCards references={review.draft.attachments} />
      </div>
      <p className="review-hint" role="status">
        {status}
        {delivery?.reason ? ` · ${delivery.reason}` : ''}
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="review-actions">
        <button type="button" disabled={busy} onClick={onReset}>
          Reset instruction
        </button>
        <button
          type="button"
          disabled={busy || pending}
          onClick={() => setEditing((value) => !value)}
        >
          {editing ? 'Preview instruction' : 'Edit instruction'}
        </button>
        <button
          className="primary"
          data-testid="coding-delivery"
          type="button"
          disabled={busy || blocked || !channelReady || pending || !review.localizedText.trim()}
          onClick={onSend}
        >
          Send to Terminal
        </button>
        {onPeerSend && (
          <button
            type="button"
            disabled={busy || (peerBlocked ?? blocked) || pending || !review.localizedText.trim()}
            onClick={onPeerSend}
          >
            Send as peer
          </button>
        )}
        <span className="review-destination">{providerLabel(review.draft.target.agent)}</span>
      </div>
    </dialog>
  );
}
