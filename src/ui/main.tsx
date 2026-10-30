import React, { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { ConversationSnapshot } from '../core/contracts.js';

import './styles.css';
import './dark-styles.css';
import {
  useDisplayPreferences,
  pruneDisplayPreferences,
  readDisplayPreferences,
  applyTheme,
} from './display-preferences.js';
import { PanelDialog } from './composer-dialogs.js';
import {
  SessionClient,
  capabilityToken,
  sessionRequest,
  forgetFolder,
  type SessionEnvelope,
} from './session-client.js';
import { workspaceFor } from './use-workspace.js';
import { useSessionCatalog } from './use-session-catalog.js';
import { AttentionToasts, useAttentionAlerts } from './attention-toast.js';
import { blockedOnTerminal } from '../core/attention.js';
import { SessionsSidebar as SessionSwitcher } from './sessions-sidebar.js';
import { TerminalPopup } from './terminal-popup.js';
import {
  usePopupMode,
  useAutoOpenWaitingLaunch,
  useKeystrokeTracker,
  lastKeystrokeAt,
  retryLaunch,
  useTerminalView,
  saveTerminalView,
  runCommand,
  terminalTitle,
  endLaunch,
  listLaunches,
  type TerminalView,
} from './launch-controls.js';
import { TerminalWorkspace } from './terminal-workspace.js';

import { FolderEmptyState } from './folder-empty-state.js';
import { SessionTabs } from './session-tabs.js';
import { NewSessionDialog } from './new-session-dialog.js';
import { useProjects } from './use-projects.js';
import {
  CreateWorktreeDialog,
  DeleteWorktreeDialog,
  InitGitDialog,
  defaultWorktreeLocation,
  type WorktreeProject,
} from './worktree-dialogs.js';
import {
  sessionTitle,
  buildProjectTree,
  mergeSavedRecords,
  agentName,
  visibleProjectTree,
  applySidebarSettings,
  removableSessions,
  chooseSessionForFolder,
  folderHasLiveSessions,
  folderKeyFor,
  folderInside,
  reorderVisible,
  type FolderNode,
  type ProjectNode,
} from './session-navigation.js';
import type { CatalogEntry } from '../core/session-catalog.js';

import type { SessionRecord, TerminalEntry } from '../core/session-contracts.js';
import type { CreatedWorktree, WorktreeRemoval } from '../runtime/application.js';
import { SessionWorkspace } from './session-workspace.js';
import { errorMessage } from './error-message.js';
import { SelectionErrorNote, type SelectionError } from './selection-error.js';
import { usePastSessions } from './use-past-sessions.js';
import { hidePastSession, manualResumeCommand, reopenPastSession } from './past-sessions.js';
import { pastSessionKey, REOPEN_FAILED_REASON, type PastSession } from '../core/past-sessions.js';

window.addEventListener('hashchange', () => window.location.reload());
applyTheme(readDisplayPreferences());
const token = capabilityToken();
function App() {
  const { catalog, error: catalogError } = useSessionCatalog();
  const [records, setRecords] = useState<SessionRecord[]>([]);
  const [selected, setSelected] = useState(() => {
    try {
      return sessionStorage.getItem('selected-session') ?? '';
    } catch {
      return '';
    }
  });
  const [launch, setLaunch] = useState('');
  const [bootstrapReady, setBootstrapReady] = useState(false);
  const [initial, setInitial] = useState<SessionEnvelope | null>(null);
  const [error, setError] = useState('');
  const [selectionError, setSelectionError] = useState<SelectionError>('');
  const selectionRequest = useRef(0);
  const [retry, setRetry] = useState(0);
  const [removal, setRemoval] = useState<{ entries: CatalogEntry[]; folderName?: string } | null>(
    null,
  );
  // A Saved sessions row with no Gloss history: removing it only hides the conversation from the list.
  const [hiding, setHiding] = useState<{ entry: PastSession; folder: string } | null>(null);
  const [removeError, setRemoveError] = useState('');
  const [removeBusy, setRemoveBusy] = useState(false);
  const requestRemoval = (entries: CatalogEntry[], folderName?: string) => {
    if (!entries.length) return;
    setRemoveError('');
    setRemoval({ entries, ...(folderName ? { folderName } : {}) });
  };
  const requestHide = (entry: PastSession, folder: string) => {
    setRemoveError('');
    setHiding({ entry, folder });
  };
  const confirmHide = async () => {
    if (!hiding) return;
    setRemoveBusy(true);
    setRemoveError('');
    try {
      await hidePastSession(hiding.entry);
      setHiding(null);
      pastSessions.refresh(hiding.folder);
    } catch (e) {
      setRemoveError(errorMessage(e, 'Could not remove from history'));
    } finally {
      setRemoveBusy(false);
    }
  };
  const confirmRemoval = async () => {
    if (!removal) return;
    setRemoveBusy(true);
    setRemoveError('');
    const failed: CatalogEntry[] = [];
    const done: string[] = [];
    let message = '';
    for (const entry of removal.entries) {
      try {
        await sessionRequest(`/api/sessions/${encodeURIComponent(entry.sessionId!)}`, {
          method: 'DELETE',
        });
        done.push(entry.sessionId!);
      } catch (e) {
        failed.push(entry);
        message = errorMessage(e, 'Could not remove from history');
      }
    }
    if (done.length) {
      setRecords((previous) => previous.filter((record) => !done.includes(record.id)));
      if (done.includes(selected)) {
        try {
          sessionStorage.removeItem('selected-session');
        } catch {
          /* local only */
        }
        selectionRequest.current++;
        setSelected('');
        setInitial(null);
      }
    }
    setRemoveBusy(false);
    if (done.length) pastSessions.refresh();
    if (failed.length) {
      setRemoval({
        entries: failed,
        ...(removal.folderName ? { folderName: removal.folderName } : {}),
      });
      setRemoveError(
        failed.length === removal.entries.length
          ? message
          : `${done.length} removed; ${failed.length} could not be removed: ${message}`,
      );
    } else setRemoval(null);
  };
  const [newOpen, setNewOpen] = useState(false);
  const openNewSession = () => setNewOpen(true);
  const [launchTerminal, setLaunchTerminal] = useState<{
    launchId: string;
    title: string;
    terminal?: boolean;
  } | null>(null);
  const [waitingLaunchId, setWaitingLaunchId] = useState<string | undefined>();
  // A launch the catalog does not list yet: the folder already counts as busy, so its empty state stays hidden.
  const [unlistedLaunchId, setUnlistedLaunchId] = useState<string | undefined>();
  useKeystrokeTracker();
  const popupMode = usePopupMode();
  const [dismissedToasts, setDismissedToasts] = useState<string[]>([]);
  const [displayPrefs, updateDisplayPrefs] = useDisplayPreferences();
  useEffect(() => applyTheme(displayPrefs), [displayPrefs.theme, displayPrefs.darkStyle]);
  const allEntries = mergeSavedRecords(catalog?.entries ?? [], records);
  // One dismissible line in the sidebar: create/delete results, failed sidebar writes, a hidden project kept for its session.
  const [notice, setNotice] = useState('');
  const catalogProjects = [
    ...new Map(
      allEntries.map((e) => [e.projectKey, { key: e.projectKey, name: e.projectName }]),
    ).values(),
  ];
  const projects = useProjects(catalog?.sequence, catalogProjects, setNotice);
  const terminals = catalog?.terminals ?? [];
  const tree = buildProjectTree(allEntries, displayPrefs.tabOrder, projects.sources, terminals);
  const folders = tree.flatMap((project) => project.folders);
  const selectedEntry = allEntries.find((e) => e.sessionId === selected);
  useEffect(() => {
    if (unlistedLaunchId && allEntries.some((e) => e.launchId === unlistedLaunchId))
      setUnlistedLaunchId(undefined);
  }, [catalog?.sequence, unlistedLaunchId]);
  const selectedTarget = records.find((r) => r.id === selected)?.target;
  // Folder of the selection, also when the catalog lists its target under no (or another) session id.
  const selectedFolderEntry =
    selectedEntry ??
    (selectedTarget
      ? allEntries.find(
          (e) =>
            e.target.agent === selectedTarget.agent &&
            e.target.sessionRef === selectedTarget.sessionRef,
        )
      : undefined);
  const lastActiveFolder = useRef<string | undefined>(undefined);
  const [folderKey, setFolderKey] = useState<string | undefined>();
  const shownTree = visibleProjectTree(
    tree,
    selectedFolderEntry ? folderKeyFor(selectedFolderEntry) : undefined,
  );
  const [selectedTerminal, setSelectedTerminal] = useState(() => {
    try {
      return sessionStorage.getItem('selected-terminal') ?? '';
    } catch {
      return '';
    }
  });
  const selectedTerminalEntry = terminals.find((t) => t.launchId === selectedTerminal);
  const activeFolderKey =
    folderKey ??
    selectedTerminalEntry?.folder ??
    (selectedFolderEntry ? folderKeyFor(selectedFolderEntry) : undefined) ??
    (folders.some((f) => f.key === lastActiveFolder.current)
      ? lastActiveFolder.current
      : applySidebarSettings(shownTree, projects.settings).visible[0]?.folders[0]?.key);
  // The project holding the selection is never hidden, so the open folder always stays reachable.
  const selectedProjectKey = tree.find((project) =>
    project.folders.some((f) => f.key === activeFolderKey),
  )?.key;
  const sidebarTree = applySidebarSettings(shownTree, projects.settings, selectedProjectKey);
  lastActiveFolder.current = activeFolderKey;
  const activeFolder: FolderNode | undefined = folders.find((f) => f.key === activeFolderKey);
  // Saved sessions rows come from the past-sessions listing; a catalog change in the folder refetches it.
  const pastSessions = usePastSessions(
    activeFolder?.path,
    JSON.stringify([activeFolder?.open, activeFolder?.saved].map((l) => l?.map((e) => e.key))),
  );
  const [reopening, setReopening] = useState<string | undefined>();
  const [reopened, setReopened] = useState(0);
  // A reopen whose launch has not connected yet: if the agent exits first, the user gets the reason and the command.
  const [pendingReopen, setPendingReopen] = useState<
    { launchId: string; entry: PastSession; folder: string; folderKey: string } | undefined
  >();
  useEffect(() => {
    if (!pendingReopen) return;
    const listed = allEntries.find((e) => e.launchId === pendingReopen.launchId);
    // Connected: nothing more to report. Still starting or waiting to connect: the catalog drops the launch once it ends.
    if (listed?.sessionId) setPendingReopen(undefined);
    if (listed) return;
    let current = true;
    void listLaunches().then(
      (launches) => {
        const launch = launches.find((l) => l.id === pendingReopen.launchId);
        if (!current || (launch && launch.state !== 'ended')) return;
        setPendingReopen(undefined);
        const { entry, folder, folderKey } = pendingReopen;
        if (
          launch?.reason?.startsWith(REOPEN_FAILED_REASON) &&
          lastActiveFolder.current === folderKey
        )
          setSelectionError({
            message: `Could not reopen ${entry.title}: the agent exited.`,
            command: manualResumeCommand(entry.agent, entry.sessionRef, folder).cdCommand,
          });
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [catalog?.sequence, pendingReopen]);
  const reopenPast = (entry: PastSession) => {
    if (!activeFolder) return;
    const folder = activeFolder.path;
    const folderKeyAtClick = activeFolder.key;
    const key = pastSessionKey(entry.agent, entry.sessionRef);
    const request = selectionRequest.current;
    // A late answer must not change a session or folder the user picked meanwhile.
    const unchanged = () =>
      request === selectionRequest.current && lastActiveFolder.current === folderKeyAtClick;
    setReopening(key);
    setSelectionError('');
    void reopenPastSession(entry, folder)
      .then(
        (launch) => {
          if (!unchanged()) return;
          setReopened((n) => n + 1);
          setWaitingLaunchId(launch.id);
          setUnlistedLaunchId(launch.id);
          if (launch.panelSessionId) chooseSession(launch.panelSessionId);
          else
            setPendingReopen({ launchId: launch.id, entry, folder, folderKey: folderKeyAtClick });
        },
        (e: unknown) => {
          if (unchanged())
            setSelectionError({
              message: `Could not reopen ${entry.title}: ${errorMessage(e, 'unknown error')}`,
              command: manualResumeCommand(entry.agent, entry.sessionRef, folder).cdCommand,
            });
        },
      )
      .finally(() => {
        setReopening((current) => (current === key ? undefined : current));
        pastSessions.refresh(folder);
      });
  };
  // The shown terminal always belongs to the folder whose tabs are shown; moving to another folder drops it.
  const shownTerminal =
    selectedTerminalEntry?.folder === activeFolderKey ? selectedTerminalEntry : undefined;
  useEffect(() => {
    if (selectedTerminalEntry && !shownTerminal) setSelectedTerminal('');
  }, [selectedTerminalEntry?.launchId, activeFolderKey]);
  useEffect(() => {
    const missing = folders.filter((f) =>
      f.open.some((e) => !(displayPrefs.tabOrder[f.key] ?? []).includes(e.key)),
    );
    if (missing.length)
      updateDisplayPrefs((p) => ({
        ...p,
        tabOrder: {
          ...p.tabOrder,
          ...Object.fromEntries(
            missing.map((f) => [
              f.key,
              [
                ...(p.tabOrder[f.key] ?? []),
                ...f.open.map((e) => e.key).filter((k) => !(p.tabOrder[f.key] ?? []).includes(k)),
              ],
            ]),
          ),
        },
      }));
  }, [catalog?.sequence]);
  const presentSignature = JSON.stringify(
    folders.map((f) => [f.key, [...f.open, ...f.saved].map((e) => [e.key, e.sessionId])]),
  );
  useEffect(() => {
    if (!catalog || !bootstrapReady) return;
    const present = Object.fromEntries(
      folders.map((f) => [
        f.key,
        {
          keys: [...f.open, ...f.saved].map((e) => e.key),
          ids: [...f.open, ...f.saved].flatMap((e) => (e.sessionId ? [e.sessionId] : [])),
        },
      ]),
    );
    updateDisplayPrefs((p) => pruneDisplayPreferences(p, present));
  }, [presentSignature, !!catalog, bootstrapReady]);
  const [bootstrapRetry, setBootstrapRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    void (async () => {
      if (!token) throw new Error('Open the authenticated panel link printed by the server.');
      const list = await sessionRequest<SessionRecord[]>('/api/sessions');
      const legacy = await sessionRequest<{ snapshot: ConversationSnapshot }>('/api/snapshot');
      if (!active) return;
      const id = list.some((r) => r.id === legacy.snapshot.id) ? legacy.snapshot.id : '';
      // Publish the fixed launch ID with the list so restored tab selection cannot
      // hydrate before launch-only legacy layout migration has its destination.
      setRecords(list);
      setLaunch(id);
      setBootstrapReady(true);
      setSelected((current) => (list.some((r) => r.id === current) ? current : id));
    })().catch((e) => {
      if (active) setError(e.message);
    });
    return () => {
      active = false;
    };
  }, [bootstrapRetry]);
  const missingCatalogIds = (catalog?.entries ?? [])
    .flatMap((entry) =>
      entry.sessionId && !records.some((record) => record.id === entry.sessionId)
        ? [entry.sessionId]
        : [],
    )
    .sort()
    .join(',');
  useEffect(() => {
    if (!missingCatalogIds) return;
    let active = true;
    void sessionRequest<SessionRecord[]>('/api/sessions')
      .then((list) => {
        if (active)
          setRecords((previous) => [
            ...previous,
            ...list.filter((record) => !previous.some((existing) => existing.id === record.id)),
          ]);
      })
      .catch(() => {
        /* A later catalog frame retries discovery of complete records. */
      });
    return () => {
      active = false;
    };
  }, [missingCatalogIds, catalog?.sequence]);
  const selectedExists = records.some((record) => record.id === selected);
  useEffect(() => {
    if (!bootstrapReady || !selected || !selectedExists) return;
    let active = true;
    setInitial(null);
    setError('');
    try {
      sessionStorage.setItem('selected-session', selected);
    } catch {
      /* Selection remains local to this document. */
    }
    void (async () => {
      const value = await new SessionClient(selected).snapshot();
      await workspaceFor(selected).hydrate(value.snapshot, launch);
      if (active) setInitial(value);
    })().catch((e) => {
      if (active) setError(e.message);
    });
    return () => {
      active = false;
      void workspaceFor(selected).flush();
    };
  }, [selected, selectedExists, bootstrapReady, launch, retry]);
  const selectSession = async (id: string) => {
    setSelectedTerminal('');
    const request = ++selectionRequest.current;
    setSelectionError('');
    if (!records.some((record) => record.id === id)) {
      const list = await sessionRequest<SessionRecord[]>('/api/sessions');
      if (request !== selectionRequest.current) return;
      if (!list.some((record) => record.id === id)) throw new Error('Session is not available yet');
      setRecords((previous) => [
        ...previous,
        ...list.filter((record) => !previous.some((existing) => existing.id === record.id)),
      ]);
    }
    setSelected(id);
    const entry = allEntries.find((e) => e.sessionId === id);
    setFolderKey(undefined);
    if (entry) {
      updateDisplayPrefs((p) => ({
        ...p,
        lastByFolder: { ...p.lastByFolder, [folderKeyFor(entry)]: id },
      }));
    }
  };
  const chooseSession = (id: string) => {
    const pending = selectSession(id);
    const request = selectionRequest.current;
    void pending.catch((e) => {
      if (request === selectionRequest.current)
        setSelectionError(errorMessage(e, 'Could not select session'));
    });
  };
  const selectFolder = (key: string) => {
    setSelectedTerminal('');
    setFolderKey(key);
    const folder = folders.find((f) => f.key === key);
    const id =
      folder &&
      chooseSessionForFolder(
        folder,
        key === activeFolderKey && selected ? selected : displayPrefs.lastByFolder[key],
      );
    if (id) chooseSession(id);
    else {
      selectionRequest.current++;
      setSelectionError('');
      setSelected('');
    }
  };
  // Create, delete and Initialize Git dialogs, opened from the sidebar's project menu and folder rows.
  const [worktreeDialog, setWorktreeDialog] = useState<
    | { kind: 'create' | 'init'; project: WorktreeProject }
    | { kind: 'delete'; project: WorktreeProject; folder: FolderNode }
    | null
  >(null);
  const worktreeProject = (project: ProjectNode): WorktreeProject => ({
    key: project.key,
    name: project.name,
    path: project.path,
    hasCommits: projects.sources.find((s) => s.key === project.key)?.hasCommits,
  });
  const worktreeCreated = async (project: WorktreeProject, created: CreatedWorktree) => {
    setWorktreeDialog(null);
    const name = created.path.split('/').filter(Boolean).at(-1) ?? created.path;
    setNotice(
      created.ignore?.added ? `Created ${name} · Added ${created.ignore.line} to .gitignore` : '',
    );
    // The server remembered the location; only collapse state is the client's to change here.
    projects.saveSettings((s) =>
      s.collapsed.includes(project.key)
        ? { ...s, collapsed: s.collapsed.filter((k) => k !== project.key) }
        : s,
    );
    await Promise.all([projects.refreshProjects(), projects.reloadWorktreeLocations()]);
    selectFolder(created.path);
  };
  // The shown session's folder is never deleted from under it: when it lives in the worktree, the client moves to the main checkout.
  const shownInside = (folder: FolderNode) =>
    selectedEntry !== undefined && folderInside(folderKeyFor(selectedEntry), folder.path);
  const worktreeDeleted = async (
    project: WorktreeProject,
    folder: FolderNode,
    removal: WorktreeRemoval,
    removedConversations: boolean,
  ) => {
    setWorktreeDialog(null);
    setNotice(
      removal.skipped > 0
        ? `Deleted ${folder.name} · ${removal.skipped === 1 ? '1 conversation kept because its session is open' : `${removal.skipped} conversations kept because their sessions are open`}`
        : '',
    );
    if (shownInside(folder)) selectFolder(project.path);
    else if (folderKey === folder.key) setFolderKey(undefined);
    if (lastActiveFolder.current === folder.key) lastActiveFolder.current = undefined;
    await projects.refreshProjects();
    if (removedConversations) {
      try {
        setRecords(await sessionRequest<SessionRecord[]>('/api/sessions'));
      } catch {
        /* the next catalog frame catches up */
      }
    }
  };
  const gitInitialized = async (project: WorktreeProject, key: string | undefined) => {
    setWorktreeDialog(null);
    // The project's key changes from its path to its .git directory; carry its sidebar settings over.
    if (key && key !== project.key) {
      const swap = (keys: string[]) => keys.map((k) => (k === project.key ? key : k));
      projects.saveSettings((s) => ({
        ...s,
        order: swap(s.order),
        hidden: swap(s.hidden),
        collapsed: swap(s.collapsed),
      }));
    }
    await projects.refreshProjects();
  };
  // A missing connected folder offers its newest saved session (records are listed oldest first).
  const inside = (path: string, folder: string) =>
    path === folder || path.startsWith(folder.endsWith('/') ? folder : folder + '/');
  const missingFolders = projects.folders
    .filter((f) => f.missing)
    .map((f) => ({
      ...f,
      newestSessionId: records.findLast((r) => inside(r.worktreePath ?? r.target.projectId, f.path))
        ?.id,
    }));
  const waitingEntry = waitingLaunchId
    ? allEntries.find((e) => e.launchId === waitingLaunchId)
    : undefined;
  useAutoOpenWaitingLaunch(waitingEntry, selected, popupMode, lastKeystrokeAt, (e) =>
    setLaunchTerminal({
      launchId: e.launchId!,
      title:
        e.sessionTitle ?? `${e.projectName} (${e.target.agent === 'claude' ? 'Claude' : 'Codex'})`,
    }),
  );
  const closeLaunchTerminal = () => {
    const id = launchTerminal?.launchId;
    setLaunchTerminal(null);
    const e = id ? allEntries.find((x) => x.launchId === id) : undefined;
    if (id && e && !e.sessionId && !launchTerminal?.terminal)
      void retryLaunch(id).catch((err) =>
        setSelectionError(errorMessage(err, 'Could not retry the connection')),
      );
  };
  const waitingCount = (catalog?.entries ?? []).filter(
    (e) => e.open && e.attention !== undefined && e.attention !== 'none',
  ).length;
  useEffect(() => {
    window.gloss?.setAttentionCount?.(waitingCount);
  }, [waitingCount]);
  const alerts = useAttentionAlerts(catalog?.entries, selected);
  // Plain shell terminals: shown as a popup over the session, or filling the workspace (the terminalView setting).
  const terminalView = useTerminalView();
  const shownTerminalFolder = useRef<string | undefined>(undefined);
  // A terminal just opened may reach the catalog a frame later; it is not treated as ended until then.
  const awaitedTerminal = useRef<string | undefined>(undefined);
  if (shownTerminal) {
    shownTerminalFolder.current = shownTerminal.folder;
    if (awaitedTerminal.current === shownTerminal.launchId) awaitedTerminal.current = undefined;
  }
  useEffect(() => {
    try {
      if (selectedTerminal) sessionStorage.setItem('selected-terminal', selectedTerminal);
      else sessionStorage.removeItem('selected-terminal');
    } catch {
      /* local only */
    }
  }, [selectedTerminal]);
  // Leaving the terminal view without a session to go back to: the folder's first open session, else the empty state.
  const leaveTerminal = (folderKey: string | undefined) => {
    setSelectedTerminal('');
    const first = folders
      .find((f) => f.key === folderKey)
      ?.open.find((e) => e.sessionId && e.availability !== 'unavailable')?.sessionId;
    if (first) chooseSession(first);
    else if (folderKey) {
      selectionRequest.current++;
      setSelectionError('');
      setSelected('');
    }
  };
  // A selected terminal that ended falls back to its folder's first open session.
  useEffect(() => {
    if (
      selectedTerminal &&
      catalog &&
      awaitedTerminal.current !== selectedTerminal &&
      !terminals.some((t) => t.launchId === selectedTerminal)
    )
      leaveTerminal(shownTerminalFolder.current);
  }, [catalog?.sequence]);
  // A terminal popup whose shell exited closes the same way; agent-session popups are left alone.
  const awaitedPopup = useRef<string | undefined>(undefined);
  if (
    launchTerminal?.terminal &&
    awaitedPopup.current === launchTerminal.launchId &&
    terminals.some((t) => t.launchId === launchTerminal.launchId)
  )
    awaitedPopup.current = undefined;
  useEffect(() => {
    if (
      launchTerminal?.terminal &&
      catalog &&
      awaitedPopup.current !== launchTerminal.launchId &&
      !terminals.some((t) => t.launchId === launchTerminal.launchId)
    )
      setLaunchTerminal(null);
  }, [catalog?.sequence, launchTerminal?.launchId]);
  // End terminal closes at once: a shell has no prompt that could be answered by mistake, and a failure is shown in the error line.
  const endTerminal = (ended: TerminalEntry) => {
    setSelectionError('');
    void endLaunch(ended.launchId).then(
      () => {
        if (launchTerminal?.launchId === ended.launchId) setLaunchTerminal(null);
        if (selectedTerminal === ended.launchId) leaveTerminal(ended.folder);
      },
      (e) => setSelectionError(`Could not end ${ended.title}: ${errorMessage(e, 'unknown error')}`),
    );
  };
  // End session closes at once from the tab's X or menu; the agent is asked to exit first, and a failure is shown in the error line.
  const endSession = (launchId: string) => {
    const ended = allEntries.find((e) => e.launchId === launchId);
    const name = ended ? (ended.sessionTitle ?? agentName(ended)) : 'session';
    setSelectionError('');
    void endLaunch(launchId).then(
      () => pastSessions.refresh(),
      (e) => setSelectionError(`Could not end ${name}: ${errorMessage(e, 'unknown error')}`),
    );
  };
  const [composerInsert, setComposerInsert] = useState<{
    sessionId: string;
    text: string;
    nonce: number;
  } | null>(null);
  // One-off status for a terminal (Run could not type the command); replaced the next time a terminal is shown.
  const [terminalNotice, setTerminalNotice] = useState<{ launchId: string; text: string } | null>(
    null,
  );
  const noticeFor = (launchId: string) =>
    terminalNotice?.launchId === launchId ? terminalNotice.text : undefined;
  const showTerminal = (
    t: TerminalEntry | { launchId: string; title: string; projectName: string; folder: string },
    view: TerminalView = terminalView,
    notice?: string,
  ) => {
    const entry = 'key' in t ? t : terminals.find((x) => x.launchId === t.launchId);
    setTerminalNotice(notice ? { launchId: t.launchId, text: notice } : null);
    if (view === 'workspace') {
      setLaunchTerminal(null);
      if (!entry) awaitedTerminal.current = t.launchId;
      setSelectedTerminal(t.launchId);
      setFolderKey(t.folder);
    } else {
      if (selectedTerminal === t.launchId) setSelectedTerminal('');
      awaitedPopup.current = entry ? undefined : t.launchId;
      setLaunchTerminal({ launchId: t.launchId, title: terminalTitle(entry ?? t), terminal: true });
    }
  };
  // Send output (and Shrink): the origin session if still open, else the folder's last shown session, else its first open one.
  const outputTarget = (t: TerminalEntry) => {
    const folder = folders.find((f) => f.key === t.folder);
    const open = folder?.open.filter((e) => e.sessionId && e.availability !== 'unavailable') ?? [];
    const origin = t.originSessionId
      ? open.find((e) => e.sessionId === t.originSessionId)
      : undefined;
    const last = displayPrefs.lastByFolder[t.folder];
    return origin ?? open.find((e) => e.sessionId === last) ?? open[0];
  };
  // Expand means 'workspace', Shrink means 'popup'. A failed save still switches this view, and says the setting was not kept.
  const switchTerminalView = async (t: TerminalEntry, next: TerminalView) => {
    const saved = await saveTerminalView(next).then(
      () => true,
      () => false,
    );
    showTerminal(t, next);
    if (next === 'popup') {
      const back = outputTarget(t)?.sessionId;
      if (back) chooseSession(back);
      else setSelectedTerminal('');
    }
    if (!saved) setSelectionError('Could not save the terminal view');
  };

  const sessionTitleFor = (id: string) => {
    const e = allEntries.find((x) => x.sessionId === id);
    return e ? sessionTitle(e) : undefined;
  };
  const sendOutput = (t: TerminalEntry, text: string) => {
    const target = outputTarget(t);
    if (!target?.sessionId) return;
    const nonce = Date.now();
    setComposerInsert({ sessionId: target.sessionId, text, nonce });
    const pending = selectSession(target.sessionId);
    const request = selectionRequest.current;
    // A failed switch drops the insert, so it never lands in a session opened later by hand.
    void pending.catch((e) => {
      setComposerInsert((c) => (c?.nonce === nonce ? null : c));
      if (request === selectionRequest.current)
        setSelectionError(errorMessage(e, 'Could not select session'));
    });
  };
  const runFromSession = async (record: SessionRecord, command: string) => {
    const result = await runCommand(
      record.worktreePath ?? record.target.projectId,
      command,
      record.id,
    );
    const t = terminals.find((x) => x.launchId === result.launch.id);
    showTerminal(
      t ?? {
        launchId: result.launch.id,
        title: result.launch.title ?? 'Terminal',
        projectName: record.projectName,
        folder: result.launch.folder,
      },
      terminalView,
      result.typed
        ? undefined
        : 'The terminal may not have been ready. Check whether the command ran before running it again.',
    );
  };
  const projectNameFor = (folder: string) =>
    tree.find((p) => p.folders.some((f) => f.key === folder))?.name ??
    folder.split('/').filter(Boolean).at(-1) ??
    folder;
  const approvalToasts =
    popupMode === 'auto'
      ? allEntries.filter(
          (e) =>
            e.launchId &&
            blockedOnTerminal(e) &&
            e.sessionId &&
            e.sessionId !== selected &&
            !dismissedToasts.includes(e.launchId),
        )
      : [];
  const waitingLaunches = allEntries
    .filter((e) => e.launchId && blockedOnTerminal(e))
    .map((e) => e.launchId!)
    .join(',');
  useEffect(() => {
    setDismissedToasts((list) => {
      const keep = list.filter((id) => waitingLaunches.split(',').includes(id));
      return keep.length === list.length ? list : keep;
    });
  }, [waitingLaunches]);
  return (
    <>
      <AttentionToasts banners={alerts.banners} onOpen={chooseSession} onDismiss={alerts.dismiss} />
      <div className="session-brand" dir="ltr">
        Gloss
      </div>
      <SessionSwitcher
        catalog={catalog}
        catalogError={catalogError}
        tree={sidebarTree.visible}
        hidden={sidebarTree.hidden}
        missingFolders={missingFolders}
        settings={projects.settings}
        onToggleCollapse={(key) =>
          projects.saveSettings((s) => ({
            ...s,
            collapsed: s.collapsed.includes(key)
              ? s.collapsed.filter((k) => k !== key)
              : [...s.collapsed, key],
          }))
        }
        onReorder={(keys) =>
          projects.saveSettings((s) => ({ ...s, order: reorderVisible(s.order, keys) }))
        }
        onHide={(key) => {
          projects.saveSettings((s) => ({
            ...s,
            hidden: s.hidden.includes(key) ? s.hidden : [...s.hidden, key],
          }));
          if (key === selectedProjectKey)
            setNotice(
              `${tree.find((p) => p.key === key)?.name ?? 'This project'} is hidden — shown while its session is open`,
            );
        }}
        onRestore={(key) =>
          projects.saveSettings((s) => ({ ...s, hidden: s.hidden.filter((k) => k !== key) }))
        }
        onForget={(path) => forgetFolder(path).then(() => projects.refreshProjects())}
        onShowSessions={chooseSession}
        notice={notice}
        onDismissNotice={() => setNotice('')}
        onConnected={(folder) => {
          projects.addFolder(folder);
          projects.saveSettings((s) =>
            s.hidden.includes(folder.projectKey) || s.collapsed.includes(folder.projectKey)
              ? {
                  ...s,
                  hidden: s.hidden.filter((k) => k !== folder.projectKey),
                  collapsed: s.collapsed.filter((k) => k !== folder.projectKey),
                }
              : s,
          );
          selectFolder(folder.path);
        }}
        onCreateWorktree={(project) =>
          setWorktreeDialog({ kind: 'create', project: worktreeProject(project) })
        }
        onInitGit={(project) =>
          setWorktreeDialog({ kind: 'init', project: worktreeProject(project) })
        }
        onDeleteWorktree={(folder, project) =>
          setWorktreeDialog({ kind: 'delete', project: worktreeProject(project), folder })
        }
        onRemoveClosed={(folder) => requestRemoval(removableSessions(folder), folder.name)}
        selectedFolderKey={activeFolderKey}
        selectedEntry={selectedEntry}
        onSelectFolder={selectFolder}
        onRegister={async (target) => {
          const value = await sessionRequest<SessionEnvelope>('/api/sessions', {
            method: 'POST',
            body: JSON.stringify({ target }),
          });
          setRecords(await sessionRequest<SessionRecord[]>('/api/sessions'));
          selectionRequest.current++;
          setSelectionError('');
          setSelectedTerminal('');
          setSelected(value.sessionId);
          setFolderKey(undefined);
          setRetry((value) => value + 1);
        }}
      />
      <div className="session-column">
        <SessionTabs
          folder={activeFolder}
          selectedId={selected}
          onSelect={chooseSession}
          onNewSession={openNewSession}
          onEnd={endSession}
          onShowTerminal={(launchId, title) => setLaunchTerminal({ launchId, title })}
          selectedTerminalId={selectedTerminal || undefined}
          terminalView={terminalView}
          onSelectTerminal={(t) => showTerminal(t)}
          onExpandTerminal={(t) =>
            void switchTerminalView(t, terminalView === 'workspace' ? 'popup' : 'workspace')
          }
          onEndTerminal={endTerminal}
          onRemove={requestRemoval}
          pastSessions={pastSessions.list}
          onOpenSaved={() => pastSessions.refresh()}
          onReopen={reopenPast}
          onRemovePast={(entry) => {
            if (activeFolder) requestHide(entry, activeFolder.path);
          }}
          reopening={reopening}
          reopened={reopened}
          offerMoveToGloss
          onRetry={(launchId) => {
            setSelectionError('');
            void retryLaunch(launchId).catch((e) =>
              setSelectionError(errorMessage(e, 'Could not retry the connection')),
            );
          }}
        />
        <PanelDialog
          title="Remove from history"
          open={!!removal || !!hiding}
          close={() => {
            if (removeBusy) return;
            setRemoval(null);
            setHiding(null);
          }}
        >
          <div className="review-body">
            {hiding ? (
              <p>
                Gloss keeps no history for this conversation. Hiding it removes it from Saved
                sessions; the agent's own files stay.
              </p>
            ) : (
              <>
                <p>
                  {removal
                    ? removal.entries.length === 1
                      ? `Remove “${sessionTitle(removal.entries[0]!)}” from Gloss's history?`
                      : `Remove ${removal.entries.length} closed sessions${removal.folderName ? ` in ${removal.folderName}` : ''} from Gloss's history?`
                    : ''}
                </p>
                <p>
                  This deletes only the saved Gloss conversation, drafts and settings for{' '}
                  {removal && removal.entries.length === 1 ? 'this session' : 'these sessions'}. The
                  agent's own transcript in Claude Code or Codex is not touched, and a session
                  reappears here if you open it again.
                </p>
              </>
            )}
            {removeError && (
              <p role="alert" className="error">
                {removeError}
              </p>
            )}
          </div>
          <div className="review-actions">
            <button
              type="button"
              disabled={removeBusy}
              onClick={() => {
                setRemoval(null);
                setHiding(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={removeBusy}
              onClick={() => void (hiding ? confirmHide() : confirmRemoval())}
            >
              {removeBusy ? 'Removing…' : 'Remove from history'}
            </button>
          </div>
        </PanelDialog>
        {worktreeDialog?.kind === 'create' && (
          <CreateWorktreeDialog
            key={'create:' + worktreeDialog.project.key}
            project={worktreeDialog.project}
            defaultLocation={
              projects.settings.worktreeLocation[worktreeDialog.project.key] ??
              defaultWorktreeLocation(worktreeDialog.project)
            }
            close={() => setWorktreeDialog(null)}
            onCreated={(created) => void worktreeCreated(worktreeDialog.project, created)}
          />
        )}
        {worktreeDialog?.kind === 'delete' && (
          <DeleteWorktreeDialog
            key={'delete:' + worktreeDialog.folder.key}
            project={worktreeDialog.project}
            folder={worktreeDialog.folder}
            currentSessionId={
              shownInside(worktreeDialog.folder) ? undefined : selected || undefined
            }
            close={() => setWorktreeDialog(null)}
            onDeleted={(removal, removed) =>
              void worktreeDeleted(worktreeDialog.project, worktreeDialog.folder, removal, removed)
            }
          />
        )}
        {worktreeDialog?.kind === 'init' && (
          <InitGitDialog
            key={'init:' + worktreeDialog.project.key}
            project={worktreeDialog.project}
            close={() => setWorktreeDialog(null)}
            onInitialized={(key) => void gitInitialized(worktreeDialog.project, key)}
          />
        )}
        {launchTerminal && (
          <TerminalPopup
            launchId={launchTerminal.launchId}
            title={launchTerminal.title}
            open
            onClose={closeLaunchTerminal}
            {...(launchTerminal.terminal
              ? {
                  status:
                    noticeFor(launchTerminal.launchId) ??
                    (terminals.find((t) => t.launchId === launchTerminal.launchId)?.busy
                      ? 'Running · the conversation stays underneath'
                      : 'At the prompt · the conversation stays underneath'),
                  onExpand: () => {
                    const t = terminals.find((x) => x.launchId === launchTerminal.launchId);
                    if (t) void switchTerminalView(t, 'workspace');
                  },
                }
              : {})}
          />
        )}
        <NewSessionDialog
          open={newOpen}
          folders={folders.map((f) => ({ key: f.key, name: f.name }))}
          defaultFolder={activeFolderKey}
          onClose={() => setNewOpen(false)}
          onLaunched={(id, launchId, launched) => {
            if (launched.agent === 'shell' && launchId) {
              showTerminal({
                launchId,
                title: launched.title ?? 'Terminal',
                projectName: projectNameFor(launched.folder),
                folder: launched.folder,
              });
              return;
            }
            setWaitingLaunchId(launchId);
            setUnlistedLaunchId(launchId);
            if (id) chooseSession(id);
          }}
        />
        {approvalToasts.map((e) => {
          const name =
            e.sessionTitle ??
            `${e.projectName} (${e.target.agent === 'claude' ? 'Claude' : 'Codex'})`;
          return (
            <div key={e.launchId} role="status" className="approval-toast">
              <span>
                {e.attention === 'question'
                  ? `${name} is waiting for your answer`
                  : `${name} needs approval`}
              </span>
              <button
                type="button"
                aria-label={`Show ${name}`}
                onClick={() => chooseSession(e.sessionId!)}
              >
                Show
              </button>
              <button
                type="button"
                aria-label={`Dismiss ${name}`}
                onClick={() => setDismissedToasts((l) => [...l, e.launchId!])}
              >
                ×
              </button>
            </div>
          );
        })}
        {selectionError && <SelectionErrorNote error={selectionError} />}
        {error && (
          <p role="alert">
            {error}
            <button
              onClick={() => {
                if (!bootstrapReady) setBootstrapRetry((value) => value + 1);
                else setRetry((value) => value + 1);
              }}
            >
              Retry connection
            </button>
          </p>
        )}
        {shownTerminal ? (
          <TerminalWorkspace
            key={shownTerminal.launchId}
            terminal={shownTerminal}
            originTitle={
              shownTerminal.originSessionId
                ? sessionTitleFor(shownTerminal.originSessionId)
                : undefined
            }
            agentLabel={(() => {
              const t = outputTarget(shownTerminal);
              return t ? (t.target.agent === 'claude' ? 'Claude' : 'Codex') : undefined;
            })()}
            notice={noticeFor(shownTerminal.launchId)}
            onShrink={() => void switchTerminalView(shownTerminal, 'popup')}
            onEnd={() => endTerminal(shownTerminal)}
            onSendOutput={(text) => sendOutput(shownTerminal, text)}
          />
        ) : initial?.sessionId === selected && initial && records.find((r) => r.id === selected) ? (
          <SessionWorkspace
            key={selected}
            initial={initial}
            record={records.find((r) => r.id === selected)!}
            entry={selectedEntry}
            usage={catalog?.usage}
            onRun={(command) =>
              runFromSession(
                records.find((r) => r.id === selected)!,
                command,
              )
            }
            composerInsert={composerInsert?.sessionId === selected ? composerInsert : null}
            onComposerInserted={() => setComposerInsert(null)}
          />
        ) : selected && !error ? (
          <p role="status">Loading workspace…</p>
        ) : activeFolder && !error && !unlistedLaunchId && !folderHasLiveSessions(activeFolder) ? (
          <FolderEmptyState
            key={activeFolder.key}
            folderName={activeFolder.name}
            hasSaved={(pastSessions.list?.entries.length ?? activeFolder.saved.length) > 0}
            onNewSession={openNewSession}
          />
        ) : null}
      </div>
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
