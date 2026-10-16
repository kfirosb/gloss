import { useEffect, useRef, useState } from 'react';
import type { FolderListing } from '../runtime/application.js';
import type { FolderSearchResult } from '../runtime/folder-search.js';
import { PanelDialog } from './composer-dialogs.js';
import { connectFolder, searchFolders } from './session-client.js';
type Search =
  | { state: 'idle' }
  | { state: 'searching' }
  | { state: 'done'; result: FolderSearchResult }
  | { state: 'error'; message: string };
const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
/** Finds a folder (Spotlight search, or the desktop folder picker) and connects it. */
export function ConnectFolderDialog({
  open,
  close,
  onConnected,
}: {
  open: boolean;
  close(): void;
  onConnected(folder: FolderListing): void;
}) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<Search>({ state: 'idle' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSearch({ state: 'idle' });
    setError('');
    setBusy(false);
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);
  useEffect(() => {
    const q = query.trim();
    if (!open || !q) {
      setSearch({ state: 'idle' });
      return;
    }
    const controller = new AbortController();
    setSearch({ state: 'searching' });
    const timer = setTimeout(() => {
      searchFolders(q, controller.signal).then(
        (result) => setSearch({ state: 'done', result }),
        (e) => {
          if (!controller.signal.aborted)
            setSearch({ state: 'error', message: message(e, 'Search failed') });
        },
      );
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, open]);
  async function choose(path: string) {
    setBusy(true);
    setError('');
    try {
      const folder = await connectFolder(path);
      close();
      onConnected(folder);
    } catch (e) {
      setError(message(e, 'Could not connect this folder'));
    } finally {
      setBusy(false);
    }
  }
  async function browse() {
    let chosen: string | null | undefined;
    try {
      chosen = await window.languageAssistant?.pickFolder();
    } catch (e) {
      setError(message(e, 'Could not open the folder picker'));
      return;
    }
    if (chosen) await choose(chosen);
  }
  const canBrowse = !!window.languageAssistant?.pickFolder;
  const hits = search.state === 'done' ? search.result.hits : [];
  return (
    <PanelDialog
      title="Connect a folder"
      className="sidebar-panel-dialog"
      dir="ltr"
      open={open}
      close={close}
    >
      <div className="review-body sidebar-dialog">
        <p className="review-hint">
          Find a folder on your computer by name, or type its full path (starting with / or ~/). Git
          repositories and ordinary folders are both welcome.
        </p>
        <label className="field">
          Search folders
          <input
            ref={input}
            type="search"
            aria-label="Search folders"
            placeholder="Folder name or path…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
        </label>
        {search.state === 'searching' && (
          <p role="status" className="search-state">
            Searching…
          </p>
        )}
        {search.state === 'error' && (
          <p role="alert" className="search-state error">
            {search.message}
          </p>
        )}
        {search.state === 'done' && search.result.unavailable && (
          <p role="status" className="search-state">
            {canBrowse
              ? 'Search is unavailable here. Use Browse folders to choose a folder instead.'
              : 'Search is unavailable here. Type the folder’s full path instead, such as ~/Projects/app.'}
          </p>
        )}
        {search.state === 'done' && !search.result.unavailable && search.result.timedOut && (
          <p role="status" className="search-state">
            Search took too long. Try a more specific name.
          </p>
        )}
        {search.state === 'done' &&
          !search.result.unavailable &&
          !search.result.timedOut &&
          !hits.length && (
            <p role="status" className="search-state">
              No folders found.
            </p>
          )}
        {hits.length > 0 && (
          <div role="listbox" aria-label="Folders" className="search-results">
            {hits.map((hit) => (
              <div
                key={hit.path}
                role="option"
                aria-selected="false"
                tabIndex={0}
                aria-disabled={busy || undefined}
                className="search-result"
                title={hit.path}
                onClick={() => {
                  if (!busy) void choose(hit.path);
                }}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && !busy) {
                    e.preventDefault();
                    void choose(hit.path);
                  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const sibling = (
                      e.key === 'ArrowDown'
                        ? e.currentTarget.nextElementSibling
                        : e.currentTarget.previousElementSibling
                    ) as HTMLElement | null;
                    sibling?.focus();
                  }
                }}
              >
                <span aria-hidden="true" className="search-icon">
                  {hit.git ? '⑂' : '▢'}
                </span>
                <span className="search-labels">
                  {hit.name}
                  <small>{hit.path}</small>
                </span>
                <span className="tag">{hit.git ? 'Git' : 'Folder'}</span>
              </div>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
      <div className="review-actions">
        <button type="button" onClick={close}>
          Cancel
        </button>
        {canBrowse && (
          <button type="button" disabled={busy} onClick={() => void browse()}>
            Browse folders…
          </button>
        )}
      </div>
    </PanelDialog>
  );
}
