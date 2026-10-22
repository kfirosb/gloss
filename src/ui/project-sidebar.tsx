import { useState } from 'react';
import type { SidebarSettings } from '../runtime/connected-folders.js';
import type { FolderNode, ProjectNode } from './session-navigation.js';
import {
  removableSessions,
  folderAttention,
  projectAttention,
  attentionLabel,
} from './session-navigation.js';
import { AttentionBadge, Spinner } from './attention.js';
import { PopupMenu } from './popup-menu.js';
import { ProjectMenu } from './project-menu.js';
const PROJECT_DRAG_TYPE = 'application/x-gloss-project';
export interface ProjectActions {
  settings?: SidebarSettings | undefined;
  onToggleCollapse?(key: string): void;
  /** Receives the full visible key order after a move or a drop (hidden projects are not in it). */
  onReorder?(keys: string[]): void;
  onHide?(key: string): void;
  onCreateWorktree?(project: ProjectNode): void;
  onInitGit?(project: ProjectNode): void;
  onDeleteWorktree?(folder: FolderNode, project: ProjectNode): void;
}
const moved = (keys: string[], from: number, to: number) => {
  const next = [...keys];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
};
export function ProjectSidebar({
  tree,
  selectedFolderKey,
  onSelectFolder,
  namesFrom,
  onRemoveClosed,
  settings,
  onToggleCollapse,
  onReorder,
  onHide,
  onCreateWorktree,
  onInitGit,
  onDeleteWorktree,
}: {
  tree: ProjectNode[];
  selectedFolderKey?: string | undefined;
  onSelectFolder(key: string): void;
  namesFrom?: ProjectNode[] | undefined;
  onRemoveClosed?(folder: FolderNode): void;
} & ProjectActions) {
  const visible = namesFrom ?? tree;
  const [menu, setMenu] = useState<{ folder: FolderNode; x: number; y: number } | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const buttonFor = (key: string) =>
    document.querySelector<HTMLElement>(`.project-folder[data-folder-key=${JSON.stringify(key)}]`);
  const openMenu = (folder: FolderNode, at: { x: number; y: number }) => {
    if (onRemoveClosed) setMenu({ folder, ...at });
  };
  const count = menu ? removableSessions(menu.folder).length : 0;
  const keys = tree.map((p) => p.key);
  const drop = (target: string) => {
    const from = dragged ? keys.indexOf(dragged) : -1;
    const to = keys.indexOf(target);
    setDragged(null);
    setOver(null);
    if (from < 0 || to < 0 || from === to) return;
    onReorder?.(moved(keys, from, to));
  };
  return (
    <div className="project-list">
      {tree.map((project, index) => {
        const collapsed = settings?.collapsed.includes(project.key) === true;
        const holdsSelection = project.folders.some((f) => f.key === selectedFolderKey);
        const projectCue = projectAttention(project);
        return (
          <div
            role="group"
            aria-label={project.name}
            key={project.key}
            className={
              'project-group' +
              (over === project.key && dragged !== project.key ? ' drag-over' : '')
            }
          >
            <div
              className="project-head"
              title={project.path}
              onDragOver={(e) => {
                if (!dragged) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setOver(project.key);
              }}
              onDragLeave={() => setOver((o) => (o === project.key ? null : o))}
              onDrop={(e) => {
                if (!dragged) return;
                e.preventDefault();
                drop(project.key);
              }}
            >
              {onReorder && (
                <span
                  className="grip"
                  draggable
                  aria-hidden="true"
                  title="Drag to reorder project"
                  onDragStart={(e) => {
                    e.dataTransfer.setData(PROJECT_DRAG_TYPE, project.key);
                    e.dataTransfer.setData('text/plain', project.name);
                    e.dataTransfer.effectAllowed = 'move';
                    setDragged(project.key);
                  }}
                  onDragEnd={() => {
                    setDragged(null);
                    setOver(null);
                  }}
                >
                  ⠿
                </span>
              )}
              <button
                type="button"
                className="project-toggle"
                aria-expanded={!collapsed}
                aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${project.name}${projectCue.working ? ', working' : ''}${projectCue.waiting ? ', ' + attentionLabel(projectCue) : ''}`}
                disabled={!onToggleCollapse}
                onClick={() => onToggleCollapse?.(project.key)}
              >
                <span className="chevron" aria-hidden="true">
                  ›
                </span>
                <span className="project-initial" aria-hidden="true">
                  {project.name[0]?.toUpperCase()}
                </span>
                <span className="project-title">{project.name}</span>
                <AttentionBadge count={projectCue.waiting} label={attentionLabel(projectCue)} />
                {visible.some((p) => p.key !== project.key && p.name === project.name) && (
                  <small className="session-group-path">{project.path}</small>
                )}
                {collapsed && holdsSelection && (
                  <span className="session-dot active" aria-hidden="true" />
                )}
              </button>
              {onReorder && onHide && (
                <ProjectMenu
                  project={project}
                  index={index}
                  count={tree.length}
                  onCreateWorktree={onCreateWorktree ? () => onCreateWorktree(project) : undefined}
                  onInitGit={onInitGit ? () => onInitGit(project) : undefined}
                  onMoveUp={() => onReorder(moved(keys, index, index - 1))}
                  onMoveDown={() => onReorder(moved(keys, index, index + 1))}
                  onHide={() => onHide(project.key)}
                />
              )}
            </div>
            {!collapsed && (
              <div className="folder-list">
                {project.folders.map((folder) => {
                  const cue = folderAttention(folder);
                  return (
                    <div
                      key={folder.key}
                      className={
                        'folder-row' + (folder.key === selectedFolderKey ? ' selected' : '')
                      }
                    >
                      <button
                        type="button"
                        className={
                          'project-folder' + (folder.key === selectedFolderKey ? ' selected' : '')
                        }
                        aria-current={folder.key === selectedFolderKey ? 'true' : undefined}
                        data-folder-key={folder.key}
                        title={folder.path}
                        aria-label={`${folder.name}, ${folder.open.length} open${cue.working ? ', working' : ''}${cue.waiting ? ', ' + attentionLabel(cue) : ''}`}
                        onClick={() => onSelectFolder(folder.key)}
                        onContextMenu={(e) => {
                          if (!onRemoveClosed) return;
                          e.preventDefault();
                          openMenu(folder, { x: e.clientX, y: e.clientY });
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
                            e.preventDefault();
                            const box = e.currentTarget.getBoundingClientRect();
                            openMenu(folder, { x: box.left + 24, y: box.bottom });
                          }
                        }}
                      >
                        {cue.working && <Spinner label="Working" />}
                        <span className="folder-labels">
                          <span className="folder-name">{folder.name}</span>
                          {folder.git && !folder.main && folder.branch && (
                            <small className="folder-branch">{folder.branch}</small>
                          )}
                        </span>
                        <small className="folder-count">{folder.open.length}</small>
                        <AttentionBadge count={cue.waiting} label={attentionLabel(cue)} />
                      </button>
                      {onDeleteWorktree && folder.worktree && !folder.main && (
                        <button
                          type="button"
                          className="folder-delete"
                          aria-label={`Delete ${folder.name} worktree`}
                          title="Delete worktree"
                          onClick={() => onDeleteWorktree(folder, project)}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
                          </svg>
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {menu && (
        <div className="folder-context" style={{ left: menu.x, top: menu.y }}>
          <PopupMenu
            controlled={{
              open: true,
              onOpenChange: (v) => {
                if (!v) setMenu(null);
              },
              restoreFocus: () => {
                const key = menu.folder.key;
                setMenu(null);
                buttonFor(key)?.focus();
              },
            }}
            label="Folder actions"
            menuClassName="session-saved-menu session-context-menu"
            menuLabel="Folder actions"
            items={[
              {
                key: 'remove-closed',
                disabled: count === 0,
                content: count
                  ? `Remove closed sessions from history… (${count})`
                  : 'No closed sessions to remove',
                onChoose: () => {
                  const folder = menu.folder;
                  setMenu(null);
                  onRemoveClosed?.(folder);
                },
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}
