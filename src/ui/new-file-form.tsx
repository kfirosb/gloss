import { useEffect, useRef, useState } from 'react';
import type { SessionClient } from './session-client.js';
import { errorMessage } from './error-message.js';
import './file-editor.css';

/**
 * Names a new, empty text file in the session folder (missing folders are created). The server refuses a name that
 * is already taken, a path outside the folder and anything inside .git.
 */
export function NewFileForm({
  client,
  folder,
  onCancel,
  onCreated,
}: {
  client: SessionClient;
  /** The folder the path starts in; '' for the session root. */
  folder: string;
  onCancel(): void;
  onCreated(path: string): void;
}) {
  const [path, setPath] = useState(folder ? folder + '/' : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const field = input.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);
  const create = async () => {
    const relativePath = path.trim();
    if (busy) return;
    if (!relativePath || relativePath.endsWith('/')) {
      setError('Enter a file name');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const created = await client.createFile(relativePath);
      onCreated(created.relativePath);
    } catch (reason) {
      setError(errorMessage(reason, 'Could not create the file'));
      setBusy(false);
    }
  };
  return (
    <form
      className="file-new-form"
      aria-label="New file"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onCancel();
      }}
    >
      <label htmlFor="new-file-path">New file path in this session</label>
      <input
        id="new-file-path"
        ref={input}
        value={path}
        placeholder="folder/name.txt"
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        dir="ltr"
        onChange={(event) => setPath(event.target.value)}
      />
      {error && <p role="alert">{error}</p>}
      <div className="file-edit-actions">
        <button type="submit" className="primary" aria-disabled={busy}>
          {busy ? 'Creating…' : 'Create'}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
