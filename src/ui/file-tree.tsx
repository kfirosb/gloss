import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { BrowserEntry } from '../core/file-references.js';
import type { SessionClient } from './session-client.js';
import './file-tree.css';

export function FileRow({
  entry,
  sessionId,
  onActivate,
  selected = false,
  depth = 0,
  expanded,
  onKeyDown,
}: {
  entry: BrowserEntry;
  sessionId: string;
  onActivate(): void;
  selected?: boolean;
  depth?: number;
  expanded?: boolean;
  onKeyDown?(event: KeyboardEvent<HTMLButtonElement>): void;
}) {
  const directory = entry.kind === 'directory';
  return (
    <button
      type="button"
      className="file-tree-row"
      style={depth ? { marginLeft: depth * 14, width: `calc(100% - ${depth * 14}px)` } : undefined}
      title={entry.relativePath}
      aria-label={`${directory ? 'Open folder' : 'Preview'} ${entry.name}`}
      aria-expanded={directory ? Boolean(expanded) : undefined}
      aria-current={selected ? 'true' : undefined}
      draggable={!directory}
      onDragStart={(event) => {
        if (directory) return;
        event.dataTransfer.setData(
          'application/x-session-file',
          JSON.stringify({ sessionId, relativePath: entry.relativePath }),
        );
        event.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={onActivate}
      onKeyDown={onKeyDown}
    >
      <svg className="file-tree-chevron" aria-hidden="true" viewBox="0 0 16 16">
        {directory && <path d={expanded ? 'm4 6 4 4 4-4' : 'm6 4 4 4-4 4'} />}
      </svg>
      <svg
        className={`file-tree-icon ${directory ? 'folder-icon' : 'document-icon'}`}
        aria-hidden="true"
        viewBox="0 0 16 16"
      >
        {directory ? (
          <path d={expanded ? 'M2 5V3h5l2 2h5v2M1 7h14l-2 6H2z' : 'M2 3h5l2 2h5v8H2z'} />
        ) : (
          <>
            <path d="M4 2h5l3 3v9H4zM9 2v4h3" />
            <path d="M6 9h4M6 11h3" />
          </>
        )}
      </svg>
      <span className="file-tree-name">{entry.name}</span>
    </button>
  );
}
interface FolderState {
  entries: BrowserEntry[];
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  next?: number | undefined;
  limited: boolean;
  error: string;
  offset: number;
}
const emptyFolder = (): FolderState => ({
  entries: [],
  expanded: false,
  loaded: false,
  loading: false,
  limited: false,
  error: '',
  offset: 0,
});
export function FileTree({
  client,
  onPreview,
}: {
  client: SessionClient;
  onPreview(path: string): void;
}) {
  return <SessionFileTree key={client.sessionId} client={client} onPreview={onPreview} />;
}
function SessionFileTree({
  client,
  onPreview,
}: {
  client: SessionClient;
  onPreview(path: string): void;
}) {
  const [folders, setFolders] = useState<Record<string, FolderState>>({});
  const [selected, setSelected] = useState('');
  const pending = useRef(new Map<string, AbortController>());
  const load = (path: string, offset = 0) => {
    if (pending.current.has(path)) return;
    const controller = new AbortController();
    pending.current.set(path, controller);
    setFolders((current) => ({
      ...current,
      [path]: {
        ...(current[path] ?? emptyFolder()),
        expanded: true,
        loading: true,
        error: '',
        offset,
      },
    }));
    void client
      .browseFiles(path, offset, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setFolders((current) => {
          const previous = current[path] ?? emptyFolder();
          const entries = new Map(
            (offset ? previous.entries : []).map((entry) => [entry.relativePath, entry]),
          );
          for (const entry of page.entries) entries.set(entry.relativePath, entry);
          return {
            ...current,
            [path]: {
              ...previous,
              entries: [...entries.values()],
              loaded: true,
              loading: false,
              next: page.nextOffset,
              limited: page.limited,
              error: '',
            },
          };
        });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setFolders((current) => ({
            ...current,
            [path]: {
              ...(current[path] ?? emptyFolder()),
              loading: false,
              error: error instanceof Error ? error.message : 'Files unavailable',
            },
          }));
      })
      .finally(() => {
        if (pending.current.get(path) === controller) pending.current.delete(path);
      });
  };
  useEffect(() => {
    setFolders({});
    setSelected('');
    load('');
    return () => {
      for (const controller of pending.current.values()) controller.abort();
      pending.current.clear();
    };
  }, [client]);
  const expand = (path: string, expanded: boolean) => {
    const state = folders[path];
    if (expanded && !state?.loaded && !state?.loading) {
      load(path, state?.offset ?? 0);
      return;
    }
    setFolders((current) => ({
      ...current,
      [path]: { ...(current[path] ?? emptyFolder()), expanded },
    }));
  };
  const contents = (path: string): React.ReactNode => {
    const state = folders[path];
    if (!state) return null;
    return (
      <ul className="file-tree-list" aria-label={path || 'Session root'}>
        {state.entries.map((entry) => (
          <li key={entry.relativePath}>
            <FileRow
              entry={entry}
              sessionId={client.sessionId}
              selected={selected === entry.relativePath}
              expanded={Boolean(folders[entry.relativePath]?.expanded)}
              onActivate={() => {
                setSelected(entry.relativePath);
                if (entry.kind === 'directory')
                  expand(entry.relativePath, !folders[entry.relativePath]?.expanded);
                else onPreview(entry.relativePath);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight' && entry.kind === 'directory') {
                  event.preventDefault();
                  if (!folders[entry.relativePath]?.expanded) expand(entry.relativePath, true);
                  else
                    event.currentTarget.parentElement
                      ?.querySelector<HTMLButtonElement>('ul button')
                      ?.focus();
                }
                if (event.key === 'ArrowLeft') {
                  event.preventDefault();
                  if (entry.kind === 'directory' && folders[entry.relativePath]?.expanded)
                    expand(entry.relativePath, false);
                  else
                    event.currentTarget
                      .closest('ul')
                      ?.parentElement?.querySelector<HTMLButtonElement>(':scope > button')
                      ?.focus();
                }
              }}
            />
            {entry.kind === 'directory' &&
              folders[entry.relativePath]?.expanded &&
              contents(entry.relativePath)}
          </li>
        ))}
        {state.loading && (
          <li className="file-tree-message" role="status">
            Loading files...
          </li>
        )}
        {state.error && (
          <li className="file-tree-message">
            <span role="alert">{state.error}</span>
            <button
              type="button"
              className="file-tree-action"
              aria-label={`Retry ${path || 'session root'}`}
              onClick={() => load(path, state.offset)}
            >
              Retry
            </button>
          </li>
        )}
        {state.loaded && !state.loading && !state.error && state.entries.length === 0 && (
          <li className="file-tree-message" role="status">
            Empty folder
          </li>
        )}
        {!state.loading && !state.error && state.next !== undefined && (
          <li>
            <button
              type="button"
              className="file-tree-action"
              aria-label={`More files in ${path || 'session root'}`}
              onClick={() => load(path, state.next)}
            >
              More files
            </button>
          </li>
        )}
        {state.limited && state.next === undefined && !state.loading && (
          <li className="file-tree-message" role="status">
            Folder scan limit reached.
          </li>
        )}
      </ul>
    );
  };
  return <div className="file-entries file-tree">{contents('')}</div>;
}
