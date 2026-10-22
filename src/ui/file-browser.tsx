import { useEffect, useState, type Ref } from 'react';
import type { BrowserEntry, FilePreview } from '../core/file-references.js';
import { FileTree, FileRow } from './file-tree.js';
import { FileReview } from './file-review.js';
import { FileContentPreview } from './file-content-preview.js';
import type { LanguageSettings } from '../core/language-settings.js';
import type { SessionClient } from './session-client.js';
import type { FilesSide } from './display-preferences.js';
import { errorMessage } from './error-message.js';
import { FileLocationButtons } from './file-actions.js';
import { DiscardEditsPrompt, FileEditor, type DiscardEditsQuestion } from './file-editor.js';
import { readDraft } from './file-edit-drafts.js';
import { NewFileForm } from './new-file-form.js';
import type { SavedFile } from '../core/file-edits.js';
export const FILE_DRAG_TYPE = 'application/x-session-file';
/** The docked column's header controls. */
interface FileColumnControls {
  side: FilesSide;
  /** The side toggle, so the workspace can refocus it after the flip remounts the column. */
  sideButton?: Ref<HTMLButtonElement>;
  onSide(side: FilesSide): void;
  onClose(): void;
}
export function FileBrowser({
  client,
  onPreview,
  onCreated,
  revealedFile = '',
  column,
}: {
  revealedFile?: string;
  client: SessionClient;
  onPreview(path: string): void;
  /** A new file exists at `path`; the workspace opens it in the editor. */
  onCreated(path: string): void;
  column: FileColumnControls;
}) {
  const [newFileFolder, setNewFileFolder] = useState<string | null>(null);
  const [treeRevision, setTreeRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'name' | 'content'>('name');
  const [entries, setEntries] = useState<BrowserEntry[]>([]);
  const [status, setStatus] = useState('');
  const [guidance, setGuidance] = useState('');
  const [selected, setSelected] = useState('');
  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    setStatus('Searching...');
    setEntries([]);
    setGuidance('');
    const timer = setTimeout(() => {
      void client
        .findFiles(query, mode, controller.signal)
        .then((found) => {
          if (controller.signal.aborted) return;
          setEntries(found.entries.map((entry) => ({ ...entry, kind: 'file' })));
          setGuidance(found.limited ? found.guidance : '');
          setStatus(
            found.limited ? 'Partial results' : found.entries.length ? '' : 'No matching files',
          );
        })
        .catch((error) => {
          if (!controller.signal.aborted) setStatus(errorMessage(error, 'Search unavailable'));
        });
    }, 150);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, query, mode]);
  return (
    <aside className="file-sidebar compact-file-sidebar" aria-label="Session files" dir="ltr">
      <FileColumnHeader {...column} onNewFile={() => setNewFileFolder('')} />
      {newFileFolder !== null && (
        <NewFileForm
          key={newFileFolder}
          client={client}
          folder={newFileFolder}
          onCancel={() => setNewFileFolder(null)}
          onCreated={(path) => {
            setNewFileFolder(null);
            setTreeRevision((n) => n + 1);
            onCreated(path);
          }}
        />
      )}
      {revealedFile && (
        <div className="revealed-file file-entries">
          <small>Opened file</small>
          <FileRow
            entry={{
              name: revealedFile.split('/').at(-1)!,
              relativePath: revealedFile,
              kind: 'file',
            }}
            client={client}
            selected
            onActivate={() => onPreview(revealedFile)}
          />
          <small title={revealedFile}>
            {revealedFile.includes('/')
              ? revealedFile.slice(0, revealedFile.lastIndexOf('/'))
              : 'Session root'}
          </small>
        </div>
      )}
      <div className="file-search-controls">
        <input
          aria-label="Search files"
          placeholder="Search files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="Search mode"
          title="Search mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as 'name' | 'content')}
        >
          <option value="name">Name</option>
          <option value="content">Content</option>
        </select>
      </div>
      <div className="file-tree-container" hidden={Boolean(query)}>
        <FileTree
          key={client.sessionId}
          client={client}
          onPreview={onPreview}
          onNewFile={setNewFileFolder}
          revision={treeRevision}
        />
      </div>
      {query && (
        <>
          <div className="file-entries file-search-results">
            {entries.map((entry) => (
              <div key={entry.relativePath}>
                <FileRow
                  entry={entry}
                  client={client}
                  selected={selected === entry.relativePath}
                  onActivate={() => {
                    setSelected(entry.relativePath);
                    onPreview(entry.relativePath);
                  }}
                />
                {entry.relativePath.includes('/') && (
                  <small className="file-search-parent">
                    {entry.relativePath.slice(0, entry.relativePath.lastIndexOf('/'))}
                  </small>
                )}
              </div>
            ))}
          </div>
          {status && <p role="status">{status}</p>}
          {guidance && <small>{guidance}</small>}
        </>
      )}
    </aside>
  );
}
function FileColumnHeader({
  side,
  sideButton,
  onSide,
  onClose,
  onNewFile,
}: FileColumnControls & { onNewFile(): void }) {
  const other: FilesSide = side === 'left' ? 'right' : 'left';
  const moveLabel = `Move files to the ${other}`;
  return (
    <div className="file-toolbar">
      <strong>Files</strong>
      <button type="button" onClick={onNewFile} aria-label="New file" title="New file">
        +
      </button>
      <button
        ref={sideButton}
        type="button"
        onClick={() => onSide(other)}
        aria-label={moveLabel}
        title={moveLabel}
      >
        ⇄
      </button>
      <button type="button" onClick={onClose} aria-label="Close files" title="Close files">
        ×
      </button>
    </div>
  );
}
/** How the preview pane's editor reports to the workspace. */
export interface FileEditControls {
  /** Open straight in the editor (a file the user just created). */
  startEditing: boolean;
  onDirtyChange(dirty: boolean): void;
  /** Puts the English "I edited <path>." note in the composer; nothing is sent. */
  onTellAgent(path: string): void;
  /** Asked when closing the popup or opening another file would drop unsaved edits. */
  leavePrompt: DiscardEditsQuestion | null;
}
/** Preview of one session file with TL;DR/Translate, Edit and Attach; the preview popup owns closing. */
export function FilePreviewPane({
  languageSettings,
  client,
  path,
  busy,
  attachError,
  attached,
  onAttach,
  edit,
}: {
  client: SessionClient;
  path: string;
  busy: boolean;
  attachError: string;
  attached: string;
  onAttach(): void;
  languageSettings: LanguageSettings;
  edit: FileEditControls;
}) {
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState('');
  // A file with unsaved edits kept from earlier reopens in the editor.
  const [editing, setEditing] = useState(
    () => edit.startEditing || !!readDraft(client.sessionId, path),
  );
  const [saved, setSaved] = useState<SavedFile | null>(null);
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setPreview(null);
    setError('');
    void client
      .previewFile(path, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setPreview(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error, 'Preview unavailable'));
      });
    return () => controller.abort();
  }, [client, path, reloads]);
  const editable = preview?.state === 'text' && !preview.truncated;
  return (
    <section className="file-preview-pane" aria-label="File contents" dir="ltr">
      {/* The popup's title bar names the file; the full path stays here. */}
      <div className="preview-header">
        <p className="preview-path">{path}</p>
        {editable && !editing && (
          <button
            type="button"
            className="file-edit-button"
            onClick={() => {
              setSaved(null);
              setEditing(true);
            }}
          >
            Edit
          </button>
        )}
        <FileLocationButtons client={client} relativePath={path} />
      </div>
      {edit.leavePrompt && <DiscardEditsPrompt {...edit.leavePrompt} />}
      {saved && !editing && (
        <p className="file-saved-note" role="status">
          Saved {saved.relativePath}.
          <button
            type="button"
            title="Puts a short English note in the composer; nothing is sent until you send it"
            onClick={() => {
              edit.onTellAgent(saved.relativePath);
              setSaved(null);
            }}
          >
            Tell the agent
          </button>
        </p>
      )}
      {editing ? (
        <FileEditor
          client={client}
          path={path}
          onDirtyChange={edit.onDirtyChange}
          onClose={(result) => {
            setEditing(false);
            if (!result) return;
            setSaved(result);
            setReloads((n) => n + 1);
          }}
        />
      ) : error ? (
        <div className="preview-content">
          <p role="alert">Preview unavailable: {error}</p>
        </div>
      ) : !preview ? (
        <div className="preview-content">
          <p role="status">Loading preview...</p>
        </div>
      ) : (
        <FileReview
          // Results are per file version and language, so a language change starts a fresh review.
          key={[
            client.sessionId,
            path,
            preview.version ?? preview.text ?? '',
            languageSettings.assist,
            languageSettings.reply,
          ].join(':')}
          client={client}
          preview={preview}
          languageSettings={languageSettings}
        >
          <FileContentPreview preview={preview} client={client} />
        </FileReview>
      )}
      {attached && <p role="status">{attached}</p>}
      {attachError && <p role="alert">{attachError}</p>}
      <div className="file-toolbar">
        <span>{editing ? 'Editing' : 'Preview'}</span>
        {/* aria-disabled, not disabled: disabling the focused button would drop focus to the body,
            where the window's Escape handler no longer sees the key. */}
        <button
          type="button"
          aria-disabled={!preview || busy}
          onClick={() => {
            if (preview && !busy) onAttach();
          }}
        >
          Attach file
        </button>
      </div>
    </section>
  );
}
