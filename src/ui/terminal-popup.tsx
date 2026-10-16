import { useLayoutEffect, useRef } from 'react';
import { TerminalView } from './terminal-view.js';

export function TerminalPopup({
  launchId,
  title,
  open,
  onClose,
  status,
  onExpand,
}: {
  launchId: string;
  title: string;
  open: boolean;
  onClose(): void;
  status?: string;
  onExpand?(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    if (open) {
      if (!dialog.current?.open) dialog.current?.showModal();
    } else dialog.current?.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="terminal-popup"
      aria-label={`Terminal: ${title}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="review-header">
        <h2>{title.startsWith('Terminal') ? title : 'Terminal · ' + title}</h2>
        <span className="terminal-hint">
          {status ?? 'Answer here, then close. The session keeps running.'}
        </span>
        {onExpand && (
          <button type="button" onClick={onExpand}>
            Expand
          </button>
        )}
        <button type="button" aria-label={`Close terminal ${title}`} onClick={onClose}>
          ×
        </button>
      </div>
      {open && <TerminalView launchId={launchId} />}
    </dialog>
  );
}
