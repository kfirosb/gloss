import { AttachmentCards } from './attachment-cards.js';
import { useEffect, useRef, type ReactNode } from 'react';
import type { LanguageTurn } from '../core/contracts.js';
import { RichText } from './rich-text.js';
export function PanelDialog({
  title,
  open,
  close,
  children,
  className = '',
  dir,
}: {
  title: string;
  open: boolean;
  close(): void;
  children: ReactNode;
  className?: string;
  dir?: 'ltr' | 'rtl';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) ref.current?.showModal();
    else ref.current?.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={['instruction-review', className].filter(Boolean).join(' ')}
      {...(dir ? { dir } : {})}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className="review-header">
        <h2>{title}</h2>
        <button type="button" aria-label={`Close ${title}`} onClick={close}>
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function SelectionDialog({
  open,
  messages,
  close,
  remove,
  clear,
  language = 'auto',
}: {
  language?: string;
  open: boolean;
  messages: (LanguageTurn & { index: number })[];
  close(): void;
  remove(index: number): void;
  clear(): void;
}) {
  return (
    <PanelDialog title="Selected messages" open={open} close={close}>
      <div className="review-body selected-list">
        {messages.length ? (
          messages.map((m) => (
            <article className="message" data-selected-index={m.index} key={m.index}>
              <small>{m.role === 'user' ? 'You' : 'Language Assistant'}</small>
              <RichText language={m.role === 'assistant' ? language : 'auto'} text={m.text} />
              <AttachmentCards references={m.attachments} />
              <button
                aria-label={`Deselect message ${m.index + 1}`}
                onClick={() => remove(m.index)}
              >
                Deselect
              </button>
            </article>
          ))
        ) : (
          <p>No messages selected.</p>
        )}
      </div>
      <div className="review-actions selection-actions">
        <span role="status" dir="ltr">
          {messages.length} selected
        </span>
        <button disabled={!messages.length} onClick={clear}>
          Clear all selected
        </button>
      </div>
    </PanelDialog>
  );
}
export function ReplaceInstructionDialog({
  open,
  text,
  close,
  keep,
  replace,
  language = 'auto',
}: {
  language?: string;
  open: boolean;
  text: string;
  close(): void;
  keep(): void;
  replace(): void;
}) {
  return (
    <PanelDialog title="An instruction is already prepared" open={open} close={close}>
      <p className="review-hint">
        The messages below are your CURRENT selections for the new instruction. Replace instruction
        prepares a fresh answer from these messages. Your existing instruction is preserved until
        the new preparation succeeds.
      </p>
      <div className="review-body">
        <h3>Selected messages for the new instruction</h3>
        <RichText language={language} text={text} />
      </div>
      <div className="review-actions">
        <button onClick={keep}>Keep existing instruction</button>
        <button className="primary" onClick={replace}>
          Replace instruction
        </button>
      </div>
    </PanelDialog>
  );
}

export function ResetInstructionDialog({
  open,
  pending,
  busy,
  error,
  close,
  reset,
}: {
  open: boolean;
  pending: boolean;
  busy: boolean;
  error: string;
  close(): void;
  reset(): void;
}) {
  return (
    <PanelDialog title="Reset prepared instruction" open={open} close={close}>
      <div className="review-body">
        <p dir="auto">
          Clear the prepared instruction and its review edits? Your selected messages and composer
          text will stay unchanged. You can then use Prepare instruction to create a fresh answer.
        </p>
        {pending && (
          <p className="notice">
            This instruction has already been submitted. Reset does not cancel its delivery or stop
            Codex from processing it.
          </p>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
      <div className="review-actions">
        <button disabled={busy} onClick={close}>
          Keep instruction
        </button>
        <button disabled={busy} className="primary" onClick={reset}>
          {busy ? 'Resetting…' : 'Confirm reset'}
        </button>
      </div>
    </PanelDialog>
  );
}
