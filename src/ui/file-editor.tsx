import { useEffect, useRef, useState } from 'react';
import { MAX_EDITABLE_FILE_BYTES, MAX_EDITABLE_FILE_LABEL } from '../core/content-policy.js';
import {
  dominantLineEnding,
  normalizeLineBreaks,
  withLineEnding,
  type SavedFile,
} from '../core/file-edits.js';
import { FileEditConflictError, type SessionClient } from './session-client.js';
import { clearDraft, readDraft, writeDraft, type FileEditDraft } from './file-edit-drafts.js';
import { hostPlatform } from './host-platform.js';
import { errorMessage } from './error-message.js';
import './file-editor.css';

/** The question asked before unsaved edits would be dropped. */
export interface DiscardEditsQuestion {
  message: string;
  discardLabel: string;
  onKeep(): void;
  onDiscard(): void;
}
/** An in-app "discard unsaved edits?" question; never a browser confirm dialog. */
export function DiscardEditsPrompt({
  message,
  discardLabel,
  onKeep,
  onDiscard,
}: DiscardEditsQuestion) {
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => keep.current?.focus(), []);
  return (
    <div
      className="file-edit-prompt"
      role="alertdialog"
      aria-label="Unsaved edits"
      onKeyDown={(event) => {
        // Escape answers "Keep editing" instead of closing the popup underneath.
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onKeep();
      }}
    >
      <p>{message}</p>
      <div className="file-edit-actions">
        <button ref={keep} type="button" onClick={onKeep}>
          Keep editing
        </button>
        <button type="button" className="file-edit-danger" onClick={onDiscard}>
          {discardLabel}
        </button>
      </div>
    </div>
  );
}
type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready' };
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/**
 * Plain-text editor for one session file, with explicit Save (Cmd/Ctrl+S) and Cancel. Unsaved text is kept in the
 * draft store while the file is open elsewhere; a save is refused, never forced, when the file changed on disk.
 * The text is never translated: no review tools run here and the browser is told not to translate it.
 */
export function FileEditor({
  client,
  path,
  onDirtyChange,
  onClose,
}: {
  client: SessionClient;
  path: string;
  onDirtyChange(dirty: boolean): void;
  /** Leaves edit mode; `saved` is set after a successful save. */
  onClose(saved?: SavedFile): void;
}) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [draft, setDraft] = useState<FileEditDraft | null>(null);
  const [restored, setRestored] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [note, setNote] = useState('');
  const [reloads, setReloads] = useState(0);
  const editor = useRef<HTMLTextAreaElement>(null);
  const dirty = !!draft && draft.text !== normalizeLineBreaks(draft.base.text);
  useEffect(() => {
    const kept = reloads === 0 ? readDraft(client.sessionId, path) : undefined;
    if (kept) {
      setDraft(kept);
      setRestored(true);
      setLoad({ state: 'ready' });
      return;
    }
    const controller = new AbortController();
    setLoad({ state: 'loading' });
    void client
      .readEditableFile(path, controller.signal)
      .then((base) => {
        if (controller.signal.aborted) return;
        setDraft({
          base,
          lineEnding: dominantLineEnding(base.text),
          text: normalizeLineBreaks(base.text),
        });
        setLoad({ state: 'ready' });
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setLoad({ state: 'error', message: errorMessage(reason, 'File unavailable') });
      });
    return () => controller.abort();
  }, [client, path, reloads]);
  useEffect(() => {
    if (load.state === 'ready') editor.current?.focus();
  }, [load.state]);
  const latestDirty = useRef(onDirtyChange);
  latestDirty.current = onDirtyChange;
  useEffect(() => latestDirty.current(dirty), [dirty]);
  // Leaving the editor (saved, cancelled or discarded) leaves nothing unsaved in the open popup.
  useEffect(() => () => latestDirty.current(false), []);
  const change = (text: string) => {
    if (!draft) return;
    const next = { ...draft, text };
    setDraft(next);
    setNote('');
    if (text !== normalizeLineBreaks(draft.base.text)) writeDraft(client.sessionId, path, next);
    else clearDraft(client.sessionId, path);
  };
  const save = async () => {
    if (!draft || saving || conflict) return;
    const content = withLineEnding(draft.text, draft.lineEnding);
    if (utf8Bytes(content) > MAX_EDITABLE_FILE_BYTES) {
      setError(`Editing is limited to ${MAX_EDITABLE_FILE_LABEL} of text`);
      return;
    }
    setSaving(true);
    setError('');
    setNote('');
    try {
      const saved = await client.saveFile(path, content, draft.base.version);
      clearDraft(client.sessionId, path);
      onClose(saved);
    } catch (reason) {
      if (reason instanceof FileEditConflictError && reason.code === 'file-changed')
        setConflict(true);
      else setError(errorMessage(reason, 'Saving failed'));
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    clearDraft(client.sessionId, path);
    onDirtyChange(false);
    onClose();
  };
  const reload = () => {
    clearDraft(client.sessionId, path);
    setConflict(false);
    setRestored(false);
    setError('');
    setNote('');
    setReloads((n) => n + 1);
  };
  const copyEdits = async () => {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(withLineEnding(draft.text, draft.lineEnding));
      setNote('Your edits are copied. Reload, then paste what you need.');
    } catch (reason) {
      setNote(`Could not copy: ${errorMessage(reason, 'clipboard unavailable')}`);
    }
  };
  const saveKey = hostPlatform() === 'darwin' ? 'Cmd+S' : 'Ctrl+S';
  if (load.state === 'loading')
    return (
      <div className="preview-content">
        <p role="status">Opening for editing…</p>
      </div>
    );
  if (load.state === 'error' || !draft)
    return (
      <div className="preview-content file-editor-failed">
        <p role="alert">
          Cannot edit this file: {load.state === 'error' ? load.message : 'unavailable'}
        </p>
        <button type="button" onClick={() => onClose()}>
          Back to preview
        </button>
      </div>
    );
  return (
    <section
      className="file-editor"
      aria-label={`Editing ${path}`}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
          event.preventDefault();
          void save();
        }
      }}
    >
      {restored && dirty && (
        <p className="preview-format-note" role="status">
          Your unsaved edits were kept while the file was closed.
        </p>
      )}
      {conflict && (
        <div className="file-edit-prompt" role="alert">
          <p>
            This file changed on disk since you opened it, perhaps by the agent. Your edits were not
            saved.
          </p>
          <div className="file-edit-actions">
            <button type="button" onClick={reload}>
              Reload (lose my edits)
            </button>
            <button type="button" onClick={() => void copyEdits()}>
              Copy my edits
            </button>
          </div>
        </div>
      )}
      {confirmCancel && (
        <DiscardEditsPrompt
          message="Discard your unsaved edits to this file?"
          discardLabel="Discard edits"
          onKeep={() => {
            setConfirmCancel(false);
            editor.current?.focus();
          }}
          onDiscard={discard}
        />
      )}
      <textarea
        ref={editor}
        className="file-editor-text notranslate"
        translate="no"
        aria-label={`Contents of ${path}`}
        dir="ltr"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        wrap="off"
        value={draft.text}
        onChange={(event) => change(event.target.value)}
      />
      {note && <p role="status">{note}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="file-edit-actions">
        <span className="preview-format-note">
          {dirty ? 'Unsaved changes' : 'No changes'} · {saveKey} saves
        </span>
        <button
          type="button"
          onClick={() => {
            if (dirty) setConfirmCancel(true);
            else discard();
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          aria-disabled={saving || conflict}
          onClick={() => {
            if (!saving && !conflict) void save();
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  );
}
