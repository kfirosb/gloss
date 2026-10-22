import { BrandMark } from './brand-mark.js';
import { useEffect, useRef, useState } from 'react';
import type { Target } from '../core/contracts.js';
import type { CatalogEntry, CatalogSnapshot } from '../core/session-catalog.js';
import type { AboutInfo, FolderListing } from '../runtime/application.js';
import type { FolderNode, ProjectNode } from './session-navigation.js';
import { useDisplayPreferences } from './display-preferences.js';
import { LanguageDefaultsDialog } from './language-controls.js';
import { SessionConnectionControls } from './session-connection-controls.js';
import { ProjectSidebar, type ProjectActions } from './project-sidebar.js';
import { SidebarFrame } from './sidebar-frame.js';
import { HiddenProjectsDialog, type MissingFolder } from './hidden-projects-dialog.js';
import { ConnectFolderDialog } from './connect-folder-dialog.js';
import { projectAttention, attentionLabel } from './session-navigation.js';
import { AttentionBadge, Spinner } from './attention.js';
import { AboutDialog } from './about-dialog.js';
import { readAbout } from './session-client.js';
import { errorMessage } from './error-message.js';
import { UpdateNotice } from './update-notice.js';
import { updatesBridge, useUpdateState } from './update-state.js';
export function SessionsSidebar({
  tree,
  hidden = [],
  missingFolders = [],
  onRestore,
  onForget,
  onShowSessions,
  onConnected,
  notice,
  onDismissNotice,
  selectedFolderKey,
  onSelectFolder,
  onRemoveClosed,
  catalog,
  catalogError,
  selectedEntry,
  onRegister,
  ...actions
}: {
  tree: ProjectNode[];
  hidden?: ProjectNode[];
  missingFolders?: MissingFolder[];
  onRestore?(key: string): void;
  onForget?(path: string): Promise<void>;
  onShowSessions?(sessionId: string): void;
  onConnected?(folder: FolderListing): void;
  /** One dismissible line under Connect folder (results of create/delete, failed settings writes, hidden-but-selected). */ notice?:
    string | undefined;
  onDismissNotice?(): void;
  onRemoveClosed?(folder: FolderNode): void;
  selectedFolderKey?: string | undefined;
  onSelectFolder(key: string): void;
  catalog: CatalogSnapshot | null;
  catalogError: string | null;
  selectedEntry?: CatalogEntry | undefined;
  onRegister(target: Target): Promise<void>;
} & ProjectActions) {
  const [prefs, updatePrefs] = useDisplayPreferences();
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width:760px)').matches),
    [overlay, setOverlay] = useState(false);
  const [dialog, setDialog] = useState<'language' | 'hidden' | 'connect' | 'about' | null>(null);
  const [about, setAbout] = useState<AboutInfo | null>(null),
    [aboutError, setAboutError] = useState<string | undefined>();
  const root = useRef<HTMLElement>(null),
    toggle = useRef<HTMLButtonElement>(null);
  const collapsed = narrow ? !overlay : prefs.collapsed;
  const selectFolder = (key: string) => {
    onSelectFolder(key);
    if (narrow) {
      setOverlay(false);
      toggle.current?.focus();
    }
  };
  function expand() {
    if (narrow) setOverlay(true);
    else updatePrefs((p) => ({ ...p, collapsed: false }));
  }
  function collapse() {
    setOverlay(false);
    if (!narrow) updatePrefs((p) => ({ ...p, collapsed: true }));
    toggle.current?.focus();
  }
  useEffect(() => {
    const media = matchMedia('(max-width:760px)');
    const change = () => {
      setNarrow(media.matches);
      setOverlay(false);
    };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (!overlay || dialog) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOverlay(false);
        toggle.current?.focus();
      }
    };
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOverlay(false);
    };
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', outside);
    };
  }, [overlay, dialog]);
  useEffect(() => {
    let active = true;
    readAbout().then(
      (v) => {
        if (active && v && typeof v.version === 'string') setAbout(v);
      },
      (e) => {
        if (active) setAboutError(errorMessage(e, 'Version unavailable'));
      },
    );
    return () => {
      active = false;
    };
  }, []);
  const close = () => setDialog(null);
  const updateState = useUpdateState();
  const installUpdate = () => void updatesBridge()?.install();
  const versionLabel = about ? `About Gloss, version ${about.version}` : 'About Gloss';
  return (
    <SidebarFrame
      width={prefs.sidebarWidth}
      collapsed={collapsed || narrow}
      onWidth={(width) => updatePrefs((p) => ({ ...p, sidebarWidth: width }))}
    >
      <nav
        ref={root}
        className="sessions-sidebar"
        aria-label="Sessions"
        dir="ltr"
        data-collapsed={collapsed}
        data-overlay={overlay}
      >
        <div className="sidebar-heading">
          <BrandMark />
          <strong>{collapsed ? 'G' : 'Gloss'}</strong>
          <button
            ref={toggle}
            aria-label={collapsed ? 'Expand sessions' : 'Collapse sessions'}
            aria-expanded={!collapsed}
            onClick={() => (collapsed ? expand() : collapse())}
          >
            {collapsed ? '»' : '«'}
          </button>
        </div>
        <button
          type="button"
          className="connect-folder"
          aria-label="Connect folder"
          title="Connect folder"
          onClick={() => setDialog('connect')}
        >
          <span aria-hidden="true" className="plus">
            ＋
          </span>
          {!collapsed && (
            <>
              <span className="connect-label">Connect folder</span>
              <span aria-hidden="true" className="connect-search">
                ⌕
              </span>
            </>
          )}
        </button>
        {!collapsed && notice && (
          <p role="status" className="sidebar-notice">
            <span>{notice}</span>
            <button type="button" aria-label="Dismiss notice" onClick={() => onDismissNotice?.()}>
              ×
            </button>
          </p>
        )}
        {collapsed ? (
          <div className="session-rail">
            {tree.map((project) => {
              const cue = projectAttention(project);
              return (
                <button
                  key={project.key}
                  title={`${project.name} — ${project.path}`}
                  aria-label={`Open ${project.name} folders: ${project.path}${cue.working ? ', working' : ''}${cue.waiting ? ', ' + attentionLabel(cue) : ''}`}
                  className={
                    project.folders.some((f) => f.key === selectedFolderKey) ? 'selected' : ''
                  }
                  onClick={() => {
                    expand();
                    if (project.folders.some((f) => f.key === selectedFolderKey)) return;
                    const first = project.folders[0];
                    if (first) onSelectFolder(first.key);
                  }}
                >
                  <span>{project.name[0]?.toUpperCase()}</span>
                  {project.folders.some((f) => f.open.length > 0) && (
                    <span className="session-dot active" />
                  )}
                  <AttentionBadge small count={cue.waiting} label={attentionLabel(cue)} />
                  {cue.working && <Spinner label="Working" />}
                </button>
              );
            })}
          </div>
        ) : (
          <>
            <section className="sidebar-content" aria-label="Projects">
              <div className="sidebar-controls">
                <span className="session-sync" title={catalogError ?? catalog?.discovery.error}>
                  {catalogError || catalog?.discovery.state === 'stale'
                    ? 'Discovery stale'
                    : catalog
                      ? 'Discovering automatically'
                      : 'Connecting discovery…'}
                </span>
              </div>
              <div className="section-title">
                <span>PROJECTS</span>
                <button
                  type="button"
                  aria-label="Hidden projects"
                  title={hidden.length ? `Hidden projects (${hidden.length})` : 'Hidden projects'}
                  onClick={() => setDialog('hidden')}
                >
                  ⋯
                  {hidden.length + missingFolders.length > 0 && (
                    <span className="hidden-count" aria-hidden="true">
                      {hidden.length + missingFolders.length}
                    </span>
                  )}
                </button>
              </div>
              {!tree.length && (
                <p className="project-empty">
                  {hidden.length
                    ? 'All projects are hidden. Use the ⋯ button above to restore them.'
                    : 'No sessions discovered yet.'}
                </p>
              )}
              <ProjectSidebar
                tree={tree}
                selectedFolderKey={selectedFolderKey}
                onSelectFolder={selectFolder}
                {...(onRemoveClosed ? { onRemoveClosed } : {})}
                {...actions}
              />
              <SessionConnectionControls
                selected={selectedEntry}
                busy={false}
                onRegister={onRegister}
              />
            </section>
          </>
        )}
        <div className="sidebar-footer">
          <button
            type="button"
            className="sidebar-language-defaults"
            aria-label="Settings"
            title="Settings"
            onClick={() => setDialog('language')}
          >
            ⚙{!collapsed && <span className="settings-label"> Settings</span>}
          </button>
          <span className="version-group">
            <button
              type="button"
              className="version-label"
              aria-label={versionLabel}
              title={versionLabel}
              onClick={() => setDialog('about')}
            >
              {about ? `v${about.version}` : 'v…'}
            </button>
            {updateState && (
              <UpdateNotice state={updateState} install={installUpdate} compact={collapsed} />
            )}
          </span>
        </div>
        <LanguageDefaultsDialog open={dialog === 'language'} onClose={close} />
        <HiddenProjectsDialog
          open={dialog === 'hidden'}
          close={close}
          hidden={hidden}
          missingFolders={missingFolders}
          onRestore={(key) => onRestore?.(key)}
          onForget={(path) => (onForget ? onForget(path) : Promise.resolve())}
          onShowSessions={(id) => {
            onShowSessions?.(id);
            if (narrow) setOverlay(false);
          }}
        />
        <ConnectFolderDialog
          open={dialog === 'connect'}
          close={close}
          onConnected={(folder) => {
            onConnected?.(folder);
            if (narrow) setOverlay(false);
          }}
        />
        <AboutDialog
          open={dialog === 'about'}
          close={close}
          about={about}
          error={aboutError}
          update={updateState}
          install={installUpdate}
        />
      </nav>
    </SidebarFrame>
  );
}
