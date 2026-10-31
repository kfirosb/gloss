import { useEffect, useMemo, useRef, useState } from 'react';
import { PopupMenu } from './popup-menu.js';
import { MovePopover, useMoveLauncher } from './claude-move.js';
import { SessionClient } from './session-client.js';
import { providerLabel } from './provider-label.js';
import { relativeTime } from './past-sessions.js';
import type { CatalogEntry } from '../core/session-catalog.js';
import { pastSessionKey, type PastSession } from '../core/past-sessions.js';
import type { TerminalEntry, TerminalView } from '../core/session-contracts.js';
import {
  activityLabel,
  agentName,
  folderHasLiveSessions,
  launchPending,
  sessionIdentity,
  sessionTitle,
  type FolderNode,
} from './session-navigation.js';

const tabTitle = (entry: CatalogEntry) =>
  launchPending(entry)
    ? entry.launchState === 'starting'
      ? 'Starting…'
      : (entry.reason ?? 'Started, not connected')
    : sessionTitle(entry);
const dotClass = (entry: CatalogEntry) =>
  entry.attention === 'approval' ||
  entry.attention === 'question' ||
  entry.attention === 'response' ||
  entry.activity === 'dialog-open' ||
  entry.activity === 'approval-required'
    ? 'needs-you'
    : entry.activity;
export function ActivityDot({ entry }: { entry: CatalogEntry }) {
  const label = activityLabel(entry);
  return (
    <span
      className={'activity-dot ' + dotClass(entry)}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}
/** The folder's past conversations; undefined until the first answer is asked for. */
export interface PastSessionsList {
  entries: PastSession[];
  loading: boolean; // no answer yet for this folder
  error?: string | undefined; // the last fetch failed; `entries` are from an earlier answer, if any
  folderMissing?: boolean | undefined; // the folder no longer exists: its rows can be removed, not reopened
}
const PAST_STATE_LABEL: Record<Exclude<PastSession['state'], 'closed'>, string> = {
  'open-in-gloss': 'Open in Gloss',
  'open-outside': 'Open elsewhere',
};
// `saved` is the folder's saved Gloss session for the row, whose live activity the row keeps showing.
function PastSessionRow({ entry, saved }: { entry: PastSession; saved: CatalogEntry | undefined }) {
  const details = [
    providerLabel(entry.agent),
    ...(entry.lastActiveAt ? [relativeTime(entry.lastActiveAt)] : []),
    ...(entry.branch ? [entry.branch] : []),
  ];
  return (
    <>
      <span className="past-session-text">
        <span className="past-session-title">{entry.title}</span>
        <span className="past-session-details">{details.join(' · ')}</span>
      </span>
      {entry.state !== 'closed' && (
        <span className="past-session-state">{PAST_STATE_LABEL[entry.state]}</span>
      )}
      {saved && <ActivityDot entry={saved} />}
    </>
  );
}
export function SessionTabs({
  folder,
  selectedId,
  onSelect,
  onNewSession,
  onEnd,
  onShowTerminal,
  onRetry,
  onRemove,
  pastSessions,
  onOpenSaved,
  onReopen,
  onRemovePast,
  reopening,
  reopened = 0,
  offerMoveToGloss = false,
  selectedTerminalId,
  onSelectTerminal,
  onExpandTerminal,
  terminalView,
  onEndTerminal,
}: {
  folder: FolderNode | undefined;
  selectedId: string;
  onSelect(id: string): void;
  onNewSession?(): void;
  onEnd?(launchId: string): void;
  onShowTerminal?(launchId: string, title: string): void;
  onRetry?(launchId: string): void;
  onRemove?(entries: CatalogEntry[]): void;
  pastSessions?: PastSessionsList | undefined; // the Saved sessions rows; undefined = not fetched yet
  onOpenSaved?(): void; // the Saved sessions popup opened: the parent refetches
  onReopen?(entry: PastSession): void;
  onRemovePast?(entry: PastSession): void; // a row with no saved Gloss session to remove (onRemove covers those)
  reopening?: string | undefined; // pastSessionKey of the row being reopened
  reopened?: number; // counts successful reopens; each one closes the Saved sessions popup
  offerMoveToGloss?: boolean; // context menu: Move to Gloss for an outside Claude session
  selectedTerminalId?: string | undefined; // launchId shown in the workspace view
  onSelectTerminal?(terminal: TerminalEntry): void; // click on a terminal tab
  onExpandTerminal?(terminal: TerminalEntry): void; // context menu: Expand (popup mode) / Shrink (workspace mode)
  terminalView?: TerminalView;
  onEndTerminal?(terminal: TerminalEntry): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{
    key: string;
    launchId?: string;
    moveSessionId?: string;
    pending: boolean;
    title: string;
    x: number;
    y: number;
  } | null>(null);
  const [savedMenu, setSavedMenu] = useState<{ entry: PastSession; x: number; y: number } | null>(
    null,
  );
  // The compact Move to Gloss popover, opened from a tab's menu at the menu's place; a move started there is
  // watched after it closes (I6).
  const [movePopover, setMovePopover] = useState<{
    key: string;
    sessionId: string;
    x: number;
    y: number;
  } | null>(null);
  const moveSessionId = movePopover?.sessionId;
  const moveClient = useMemo(
    () => (moveSessionId ? new SessionClient(moveSessionId) : undefined),
    [moveSessionId],
  );
  const launchMove = useMoveLauncher();
  // The tab's Move icon that opened the popover, so pressing it again closes rather than reopens it.
  const moveOpener = useRef<HTMLButtonElement | null>(null);
  const askToMove = (key: string, sessionId: string, x: number, y: number) =>
    launchMove(new SessionClient(sessionId), () => setMovePopover({ key, sessionId, x, y }));
  const [terminalMenu, setTerminalMenu] = useState<{
    terminal: TerminalEntry;
    x: number;
    y: number;
  } | null>(null);
  // A Claude session no Gloss launch owns can be moved into Gloss (spec 5); the server decides whether it may.
  const movable = (entry: CatalogEntry) =>
    offerMoveToGloss &&
    entry.target.agent === 'claude' &&
    !!entry.sessionId &&
    !entry.launchId &&
    entry.availability !== 'unavailable';
  // A placeholder row has no session to select, so its terminal and retry live in the tab's context menu.
  const hasMenu = (entry: CatalogEntry) =>
    movable(entry) ||
    (!!entry.launchId && (!!onEnd || (launchPending(entry) && !!(onShowTerminal || onRetry))));
  const tabFor = (key: string) =>
    root.current?.querySelector<HTMLElement>(`[data-session-key=${JSON.stringify(key)}]`);
  const openSavedMenu = (entry: PastSession, anchor: { x: number; y: number }) => {
    const box = root.current?.getBoundingClientRect();
    setSavedMenu({ entry, x: anchor.x - (box?.left ?? 0), y: anchor.y - (box?.top ?? 0) });
  };
  // A row with a Gloss session is removed through its saved catalog entry; only a row with no Gloss session is hidden.
  const savedFor = (entry: PastSession) =>
    entry.panelSessionId ? saved.find((e) => e.sessionId === entry.panelSessionId) : undefined;
  const removePast = (entry: PastSession) => {
    if (!entry.panelSessionId) return onRemovePast?.(entry);
    const record = savedFor(entry);
    if (record) onRemove?.([record]);
  };
  const canRemove = (entry: PastSession) =>
    entry.state !== 'open-in-gloss' &&
    (entry.panelSessionId ? !!savedFor(entry) && !!onRemove : !!onRemovePast);
  // Reopening runs the agent in the folder, so a folder that no longer exists offers none.
  const canReopen = (entry: PastSession) =>
    entry.state === 'closed' && !pastSessions?.folderMissing && !!onReopen;
  const savedMenuItems = (entry: PastSession) => [
    ...(canReopen(entry) && onReopen
      ? [{ key: 'reopen', content: 'Reopen', onChoose: () => onReopen(entry) }]
      : []),
    ...(canRemove(entry)
      ? [{ key: 'remove', content: 'Remove from history…', onChoose: () => removePast(entry) }]
      : []),
  ];
  const openMenu = (
    entry: CatalogEntry,
    anchor: { x: number; y: number } | undefined,
    tab: HTMLElement,
  ) => {
    if (!hasMenu(entry)) return;
    const box = tab.parentElement?.parentElement?.getBoundingClientRect();
    const at = tab.getBoundingClientRect();
    setMenu({
      key: entry.key,
      ...(entry.launchId ? { launchId: entry.launchId } : {}),
      ...(movable(entry) && entry.sessionId ? { moveSessionId: entry.sessionId } : {}),
      pending: launchPending(entry),
      title: entry.sessionTitle ?? agentName(entry),
      x: (anchor?.x ?? at.left) - (box?.left ?? 0),
      y: (anchor?.y ?? at.bottom) - (box?.top ?? 0),
    });
  };
  const menuItems = ({
    key,
    launchId,
    moveSessionId,
    pending,
    title,
    x,
    y,
  }: {
    key: string;
    launchId?: string;
    moveSessionId?: string;
    pending: boolean;
    title: string;
    x: number;
    y: number;
  }) => [
    ...(moveSessionId
      ? [
          {
            key: 'move',
            content: 'Move to Gloss…',
            onChoose: () => {
              moveOpener.current = null;
              askToMove(key, moveSessionId, x, y);
            },
          },
        ]
      : []),
    ...(launchId && pending && onShowTerminal
      ? [
          {
            key: 'terminal',
            content: 'Show terminal',
            onChoose: () => onShowTerminal(launchId, title),
          },
        ]
      : []),
    ...(launchId && pending && onRetry
      ? [{ key: 'retry', content: 'Retry connection', onChoose: () => onRetry(launchId) }]
      : []),
    ...(launchId && onEnd
      ? [{ key: 'end', content: 'End session', onChoose: () => onEnd(launchId) }]
      : []),
  ];
  const openTerminalMenu = (
    terminal: TerminalEntry,
    anchor: { x: number; y: number } | undefined,
    tab: HTMLElement,
  ) => {
    const box = root.current?.getBoundingClientRect();
    const at = tab.getBoundingClientRect();
    setTerminalMenu({
      terminal,
      x: (anchor?.x ?? at.left) - (box?.left ?? 0),
      y: (anchor?.y ?? at.bottom) - (box?.top ?? 0),
    });
  };
  const open = folder?.open ?? [];
  const saved = folder?.saved ?? [];
  const terminals = folder?.terminals ?? [];
  // While a terminal fills the workspace, its tab is the selected one, not the session underneath.
  const terminalShown =
    !!selectedTerminalId && terminals.some((t) => t.launchId === selectedTerminalId);
  const keys = [...open.map((e) => e.key), ...terminals.map((t) => t.key)];
  const [focusKey, setFocusKey] = useState<string | undefined>();
  const current =
    (terminalShown ? terminals.find((t) => t.launchId === selectedTerminalId)?.key : undefined) ??
    open.find((e) => e.sessionId === selectedId)?.key ??
    open[0]?.key ??
    terminals[0]?.key;
  const tabbable = focusKey !== undefined && keys.includes(focusKey) ? focusKey : current;
  useEffect(() => {
    setFocusKey(undefined);
  }, [selectedId, selectedTerminalId, folder?.key]);
  useEffect(() => {
    setMenu(null);
    setSavedMenu(null);
    setTerminalMenu(null);
    setMovePopover(null);
  }, [folder?.key]);
  useEffect(() => {
    if (menu && !open.some((e) => e.key === menu.key && e.launchId === menu.launchId))
      setMenu(null);
  }, [menu, open]);
  useEffect(() => {
    if (terminalMenu && !terminals.some((t) => t.key === terminalMenu.terminal.key))
      setTerminalMenu(null);
  }, [terminalMenu, terminals]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedId, selectedTerminalId, folder?.key]);
  const moveKey = (from: string, delta: number) => {
    const i = keys.indexOf(from);
    const next = keys[(i + delta + keys.length) % keys.length];
    if (!next) return;
    setFocusKey(next);
    list.current?.querySelector<HTMLElement>(`[data-session-key=${JSON.stringify(next)}]`)?.focus();
  };
  const pastEntries = pastSessions?.entries ?? [];
  // The count is shown once an answer is in; a failed first fetch keeps the menu open to say why.
  const savedKnown =
    !!pastSessions && (pastEntries.length > 0 || (!pastSessions.loading && !pastSessions.error));
  const savedStatus = pastSessions?.error
    ? `Could not load saved sessions: ${pastSessions.error}`
    : savedKnown
      ? 'No saved sessions'
      : 'Loading…';
  const pastItem = (entry: PastSession) => {
    const key = pastSessionKey(entry.agent, entry.sessionRef);
    const panelId = entry.panelSessionId;
    const menu = savedMenuItems(entry);
    return {
      key,
      unavailable: !panelId,
      current: !!panelId && panelId === selectedId,
      data: { sessionKey: key, sessionId: panelId },
      content: <PastSessionRow entry={entry} saved={savedFor(entry)} />,
      onChoose: () => {
        if (panelId) onSelect(panelId);
      },
      ...(canReopen(entry) && onReopen
        ? {
            action: {
              label: reopening === key ? 'Reopening…' : 'Reopen',
              ariaLabel: `Reopen ${entry.title}`,
              disabled: reopening !== undefined,
              onAction: () => onReopen(entry),
            },
          }
        : {}),
      ...(menu.length
        ? { onContext: (anchor: { x: number; y: number }) => openSavedMenu(entry, anchor) }
        : {}),
    };
  };
  const newButton = onNewSession && (
    <button type="button" className="session-new" aria-label="New session" onClick={onNewSession}>
      +
    </button>
  );
  if (!folder)
    return (
      <div className="session-tabs empty" dir="ltr">
        {newButton}
      </div>
    );
  return (
    <div ref={root} className="session-tabs" dir="ltr">
      <div
        ref={list}
        role="tablist"
        aria-label={`Sessions in ${folder.name}`}
        className="session-tab-list"
      >
        {open.map((entry) => {
          const selected = !terminalShown && entry.sessionId === selectedId;
          const unselectable = !entry.sessionId || entry.availability === 'unavailable';
          const launchId = entry.launchId;
          const name = entry.sessionTitle ?? agentName(entry);
          const endLabel = `End ${name}`;
          const moveLabel = `Move ${name} to Gloss`;
          const moveId = movable(entry) ? entry.sessionId : undefined;
          const moveShown = movePopover?.key === entry.key;
          return (
            // The X and the Move icon are siblings of the tab because a button cannot contain another button.
            <span key={entry.key} className="session-tab-item" role="presentation">
              <button
                role="tab"
                className={'session-tab' + (selected ? ' selected' : '')}
                aria-selected={selected}
                aria-disabled={unselectable || undefined}
                tabIndex={tabbable === entry.key ? 0 : -1}
                data-session-key={entry.key}
                data-session-id={entry.sessionId}
                title={sessionIdentity(entry)}
                aria-description={sessionIdentity(entry)}
                onFocus={() => setFocusKey(entry.key)}
                onContextMenu={(e) => {
                  if (!hasMenu(entry)) return;
                  e.preventDefault();
                  openMenu(entry, { x: e.clientX, y: e.clientY }, e.currentTarget);
                }}
                onClick={() => {
                  if (!unselectable && entry.sessionId) onSelect(entry.sessionId);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
                    if (hasMenu(entry)) {
                      e.preventDefault();
                      openMenu(entry, undefined, e.currentTarget);
                    }
                  } else if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    moveKey(entry.key, 1);
                  } else if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    moveKey(entry.key, -1);
                  }
                }}
              >
                <span className="session-tab-agent" role="img" aria-label={agentName(entry)}>
                  {entry.target.agent === 'claude' ? '✳' : '◎'}
                </span>
                <span className="session-tab-title">{tabTitle(entry)}</span>
                <ActivityDot entry={entry} />
              </button>
              {onEnd && launchId && (
                <button
                  type="button"
                  className="session-tab-close"
                  tabIndex={-1}
                  aria-label={endLabel}
                  title={endLabel}
                  onClick={() => onEnd(launchId)}
                >
                  ×
                </button>
              )}
              {/* An outside Claude session has nothing to end; its tab offers Move to Gloss in the X's place. */}
              {moveId && (
                <button
                  type="button"
                  className="session-tab-close session-tab-move"
                  tabIndex={-1}
                  aria-label={moveLabel}
                  title={moveLabel}
                  aria-haspopup="dialog"
                  aria-expanded={moveShown}
                  onClick={(e) => {
                    if (moveShown) return setMovePopover(null);
                    moveOpener.current = e.currentTarget;
                    const box = root.current?.getBoundingClientRect();
                    const tab = tabFor(entry.key)?.getBoundingClientRect();
                    askToMove(
                      entry.key,
                      moveId,
                      (tab?.left ?? 0) - (box?.left ?? 0),
                      (tab?.bottom ?? 0) - (box?.top ?? 0),
                    );
                  }}
                >
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                    <path
                      d="M6 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10M8 8l6-6M8 8h3.5M8 8V4.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}
            </span>
          );
        })}
        {terminals.map((terminal) => {
          const selected = terminal.launchId === selectedTerminalId;
          const label = terminal.busy ? 'Running' : 'At the prompt';
          const endLabel = `End ${terminal.title}`;
          return (
            <span key={terminal.key} className="session-tab-item" role="presentation">
              <button
                role="tab"
                className={'session-tab terminal' + (selected ? ' selected' : '')}
                aria-selected={selected}
                tabIndex={tabbable === terminal.key ? 0 : -1}
                data-session-key={terminal.key}
                data-terminal-id={terminal.launchId}
                title={`${terminal.title} in ${folder.name}`}
                onFocus={() => setFocusKey(terminal.key)}
                onClick={() => onSelectTerminal?.(terminal)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openTerminalMenu(terminal, { x: e.clientX, y: e.clientY }, e.currentTarget);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
                    e.preventDefault();
                    openTerminalMenu(terminal, undefined, e.currentTarget);
                  } else if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    moveKey(terminal.key, 1);
                  } else if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    moveKey(terminal.key, -1);
                  }
                }}
              >
                <span className="session-tab-agent terminal" role="img" aria-label="Terminal">
                  &gt;_
                </span>
                <span className="session-tab-title">{terminal.title}</span>
                <span
                  className={'activity-dot ' + (terminal.busy ? 'working' : 'idle')}
                  role="img"
                  aria-label={label}
                  title={label}
                />
              </button>
              {onEndTerminal && (
                <button
                  type="button"
                  className="session-tab-close"
                  tabIndex={-1}
                  aria-label={endLabel}
                  title={endLabel}
                  onClick={() => onEndTerminal(terminal)}
                >
                  ×
                </button>
              )}
            </span>
          );
        })}
      </div>
      {newButton}
      {menu && (
        <div className="session-context" style={{ left: menu.x, top: menu.y }}>
          <PopupMenu
            controlled={{
              open: true,
              onOpenChange: (v) => {
                if (!v) setMenu(null);
              },
              restoreFocus: () => {
                const key = menu.key;
                setMenu(null);
                tabFor(key)?.focus();
              },
            }}
            label="Session actions"
            menuClassName="session-saved-menu session-context-menu"
            menuLabel="Session actions"
            items={menuItems(menu)}
          />
        </div>
      )}
      {movePopover && moveClient && (
        <div className="session-context" style={{ left: movePopover.x, top: movePopover.y }}>
          <MovePopover
            client={moveClient}
            opener={moveOpener}
            onClose={(returnFocus) => {
              const key = movePopover.key;
              setMovePopover(null);
              if (returnFocus) tabFor(key)?.focus();
            }}
          />
        </div>
      )}
      {terminalMenu && (
        <div className="session-context" style={{ left: terminalMenu.x, top: terminalMenu.y }}>
          <PopupMenu
            controlled={{
              open: true,
              onOpenChange: (v) => {
                if (!v) setTerminalMenu(null);
              },
              restoreFocus: () => {
                const key = terminalMenu.terminal.key;
                setTerminalMenu(null);
                tabFor(key)?.focus();
              },
            }}
            label="Terminal actions"
            menuClassName="session-saved-menu session-context-menu"
            menuLabel="Terminal actions"
            items={[
              {
                key: 'show',
                content: 'Show terminal',
                onChoose: () => onSelectTerminal?.(terminalMenu.terminal),
              },
              ...(onExpandTerminal
                ? [
                    {
                      key: 'expand',
                      content: terminalView === 'workspace' ? 'Shrink to popup' : 'Expand',
                      onChoose: () => onExpandTerminal(terminalMenu.terminal),
                    },
                  ]
                : []),
              ...(onEndTerminal
                ? [
                    {
                      key: 'end',
                      content: 'End terminal',
                      onChoose: () => onEndTerminal(terminalMenu.terminal),
                    },
                  ]
                : []),
            ]}
          />
        </div>
      )}
      {savedMenu && (
        <div className="session-context" style={{ left: savedMenu.x, top: savedMenu.y }}>
          <PopupMenu
            controlled={{
              open: true,
              onOpenChange: (v) => {
                if (!v) setSavedMenu(null);
              },
              restoreFocus: () => {
                setSavedMenu(null);
                root.current?.querySelector<HTMLElement>('.session-saved > button')?.focus();
              },
            }}
            label="Session actions"
            menuClassName="session-saved-menu session-context-menu"
            menuLabel="Session actions"
            items={savedMenuItems(savedMenu.entry)}
          />
        </div>
      )}
      {!folderHasLiveSessions(folder) && (
        <p className="session-tabs-empty">No open sessions in this folder.</p>
      )}
      <PopupMenu
        className="session-saved"
        menuClassName="session-saved-menu session-past-menu"
        resetKey={`${folder.key}\0${reopened}`}
        label={savedKnown ? <>Saved sessions ({pastEntries.length})</> : 'Saved sessions'}
        triggerDisabled={savedKnown && pastEntries.length === 0}
        onOpen={onOpenSaved}
        description={
          pastEntries.some((e) => e.panelSessionId && e.panelSessionId === selectedId)
            ? '(current session inside)'
            : undefined
        }
        items={
          pastEntries.length
            ? pastEntries.map(pastItem)
            : [{ key: 'status', disabled: true, content: savedStatus, onChoose: () => {} }]
        }
      />
    </div>
  );
}
