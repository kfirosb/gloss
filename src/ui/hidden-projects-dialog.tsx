import { useEffect, useState } from 'react';
import type { FolderListing } from '../runtime/application.js';
import type { ProjectNode } from './session-navigation.js';
import { PanelDialog } from './composer-dialogs.js';
/** A connected folder no longer on disk; `newestSessionId` is its newest saved session, when it has one. */
export type MissingFolder = FolderListing & { newestSessionId?: string | undefined };
export function HiddenProjectsDialog({
  open,
  close,
  hidden,
  missingFolders,
  onRestore,
  onForget,
  onShowSessions,
}: {
  open: boolean;
  close(): void;
  hidden: ProjectNode[];
  missingFolders: MissingFolder[];
  onRestore(key: string): void;
  onForget(path: string): Promise<void>;
  onShowSessions(sessionId: string): void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setError('');
      setBusy(null);
    }
  }, [open]);
  const forget = async (path: string) => {
    setBusy(path);
    setError('');
    try {
      await onForget(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not forget this folder');
    } finally {
      setBusy(null);
    }
  };
  return (
    <PanelDialog
      title="Hidden projects"
      className="sidebar-panel-dialog"
      dir="ltr"
      open={open}
      close={close}
    >
      <div className="review-body sidebar-dialog">
        <p className="review-hint">
          Hiding only removes a project from your sidebar. Its folders and conversations stay on
          your computer.
        </p>
        {hidden.length ? (
          <ul className="hidden-list">
            {hidden.map((p) => (
              <li key={p.key} className="hidden-row">
                <span>
                  <strong>{p.name}</strong>
                  <small>{p.path}</small>
                </span>
                <button
                  type="button"
                  aria-label={`Restore ${p.name}`}
                  onClick={() => onRestore(p.key)}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="project-empty">No hidden projects.</p>
        )}
        {missingFolders.length > 0 && (
          <>
            <h3>Missing folders</h3>
            <p className="review-hint">
              These connected folders are no longer on disk. Show sessions opens the newest saved
              conversation; forgetting a folder removes it from the sidebar and keeps its saved
              conversations.
            </p>
            <ul className="hidden-list">
              {missingFolders.map((f) => (
                <li key={f.path} className="hidden-row">
                  <span>
                    <strong>{f.path.split('/').filter(Boolean).at(-1) ?? f.path}</strong>
                    <small>{f.path}</small>
                  </span>
                  <span className="hidden-actions">
                    {f.newestSessionId && (
                      <button
                        type="button"
                        aria-label={`Show sessions of ${f.path}`}
                        onClick={() => {
                          close();
                          onShowSessions(f.newestSessionId!);
                        }}
                      >
                        Show sessions
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={`Forget ${f.path}`}
                      disabled={busy === f.path}
                      onClick={() => void forget(f.path)}
                    >
                      Forget
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
      <div className="review-actions">
        <button type="button" className="primary" onClick={close}>
          Done
        </button>
      </div>
    </PanelDialog>
  );
}
