import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FolderListing, WorktreeListing } from '../runtime/application.js';
import type { SidebarSettings } from '../runtime/connected-folders.js';
import type { ProjectSource } from './session-navigation.js';
import {
  listFolders,
  listWorktrees,
  readSidebarSettings,
  writeSidebarSettings,
} from './session-client.js';
export const defaultSidebarSettings = (): SidebarSettings => ({
  order: [],
  hidden: [],
  collapsed: [],
  worktreeLocation: {},
});
const basename = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path;
export const isGitProject = (key: string) => key.endsWith('/.git');
/** Worktree listings refresh when the set of Git projects changes, after an action, and otherwise at most this often. */
export const WORKTREE_REFRESH_MS = 30_000;
const SETTINGS_RETRY_MS = 2_000;
const validSettings = (v: unknown): v is SidebarSettings =>
  !!v && typeof v === 'object' && Array.isArray((v as SidebarSettings).order);
/**
 * One project per connected projectKey, plus each catalog Git project that has a worktree listing. Git projects list
 * their worktrees (plus any connected folder Git did not report), plain projects their folders.
 */
export function projectSources(
  folders: FolderListing[],
  worktrees: Record<string, WorktreeListing | undefined>,
  catalogProjects: { key: string; name: string }[] = [],
): ProjectSource[] {
  const byKey = new Map<string, { name: string; connected: FolderListing[] }>();
  for (const folder of folders) {
    const known = byKey.get(folder.projectKey);
    if (known) known.connected.push(folder);
    else byKey.set(folder.projectKey, { name: folder.projectName, connected: [folder] });
  }
  for (const { key, name } of catalogProjects)
    if (!byKey.has(key) && isGitProject(key) && worktrees[key])
      byKey.set(key, { name, connected: [] });
  return [...byKey].map(([key, { name, connected }]) => {
    const git = isGitProject(key);
    const path = git ? key.slice(0, -'/.git'.length) : connected[0]!.path;
    const missing = (p: string) => connected.find((f) => f.path === p)?.missing === true;
    const list: ProjectSource['folders'] = git
      ? (worktrees[key]?.worktrees ?? [])
          .filter((w) => !w.prunable)
          .map((w) => ({
            path: w.path,
            name: basename(w.path),
            ...(w.branch ? { branch: w.branch } : {}),
            main: w.main,
            missing: missing(w.path),
            worktree: true,
          }))
      : [];
    for (const f of connected)
      if (!list.some((x) => x.path === f.path))
        list.push({
          path: f.path,
          name: basename(f.path),
          ...(f.branch ? { branch: f.branch } : {}),
          main: f.path === path || f.kind !== 'worktree',
          missing: f.missing,
        });
    const hasCommits = worktrees[key]?.hasCommits;
    return {
      key,
      name,
      path,
      git,
      main: path,
      folders: list,
      ...(git && hasCommits !== undefined ? { hasCommits } : {}),
    };
  });
}
/**
 * Connected folders, the worktree listing of every Git project in the sidebar (connected or discovered), and the sidebar
 * settings. Folders refresh on each catalog frame (the server caches their metadata); worktrees as WORKTREE_REFRESH_MS says.
 * Settings writes wait for the first read and replay on top of it; a failed write reverts and is reported through `onError`.
 */
export function useProjects(
  catalogSequence: number | undefined,
  catalogProjects: { key: string; name: string }[],
  onError: (message: string) => void,
) {
  const [folders, setFolders] = useState<FolderListing[]>([]);
  const [worktrees, setWorktrees] = useState<Record<string, WorktreeListing | undefined>>({});
  const [settings, setSettings] = useState<SidebarSettings>(defaultSidebarSettings);
  const request = useRef(0),
    settingsWrite = useRef(0),
    generation = useRef(new Map<string, number>());
  const report = useRef(onError);
  report.current = onError;
  const gitKeys = [
    ...new Set(
      [...folders.map((f) => f.projectKey), ...catalogProjects.map((p) => p.key)].filter(
        isGitProject,
      ),
    ),
  ].sort();
  const keySignature = gitKeys.join('\n');
  const currentKeys = useRef(gitKeys);
  currentKeys.current = gitKeys;
  /** Lists the worktrees of `keys`; a key's answer is dropped when a newer request for that key started meanwhile. */
  const refreshWorktrees = useCallback(async (keys: string[]) => {
    const started = keys.map((key) => {
      const id = (generation.current.get(key) ?? 0) + 1;
      generation.current.set(key, id);
      return [key, id] as const;
    });
    const listed = await Promise.all(
      started.map(([key, id]) =>
        listWorktrees(key).then(
          (v) => [key, id, v] as const,
          () => [key, id, undefined] as const,
        ),
      ),
    );
    setWorktrees((previous) => {
      const next: Record<string, WorktreeListing | undefined> = {};
      for (const key of currentKeys.current) if (key in previous) next[key] = previous[key];
      for (const [key, id, value] of listed)
        if (generation.current.get(key) === id && currentKeys.current.includes(key))
          next[key] = value;
      return next;
    });
  }, []);
  const refreshFolders = useCallback(async () => {
    const id = ++request.current;
    let list: FolderListing[];
    try {
      list = await listFolders();
    } catch {
      return undefined;
    }
    if (!Array.isArray(list) || id !== request.current) return undefined;
    setFolders(list);
    return list;
  }, []);
  /** After a connect, create, delete, init or forget: folders, then the worktrees of every Git project. */
  const refreshProjects = useCallback(async () => {
    const list = await refreshFolders();
    currentKeys.current = [
      ...new Set([
        ...(list ?? []).map((f) => f.projectKey).filter(isGitProject),
        ...currentKeys.current,
      ]),
    ];
    await refreshWorktrees(currentKeys.current);
  }, [refreshFolders, refreshWorktrees]);
  useEffect(() => {
    void refreshFolders();
  }, [catalogSequence, refreshFolders]);
  // A changed set of Git projects lists only the projects new to it; the timer refreshes them all.
  const listedKeys = useRef(new Set<string>());
  useEffect(() => {
    const added = gitKeys.filter((key) => !listedKeys.current.has(key));
    listedKeys.current = new Set(gitKeys);
    if (added.length) void refreshWorktrees(added);
  }, [keySignature, refreshWorktrees]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (currentKeys.current.length) void refreshWorktrees(currentKeys.current);
    }, WORKTREE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshWorktrees]);
  // `saved` is the server's last answer; changes made before the first read are queued and replayed on top of it.
  const latest = useRef(settings);
  latest.current = settings;
  const saved = useRef<SidebarSettings | undefined>(undefined);
  const queued = useRef<((current: SidebarSettings) => SidebarSettings)[]>([]);
  const write = useCallback((next: SidebarSettings) => {
    const id = ++settingsWrite.current;
    void writeSidebarSettings(next)
      .then((value) => {
        if (!validSettings(value)) throw new Error('unexpected answer');
        saved.current = value;
        if (id === settingsWrite.current) {
          latest.current = value;
          setSettings(value);
        }
      })
      .catch((e) => {
        if (id !== settingsWrite.current || !saved.current) return;
        latest.current = saved.current;
        setSettings(saved.current);
        report.current(
          `Could not save the sidebar layout: ${e instanceof Error ? e.message : 'request failed'}`,
        );
      });
  }, []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      readSidebarSettings().then(
        (value) => {
          if (!active) return;
          const base = validSettings(value) ? value : defaultSidebarSettings();
          saved.current = base;
          const next = queued.current.reduce((current, update) => update(current), base);
          queued.current = [];
          latest.current = next;
          setSettings(next);
          if (next !== base) write(next);
        },
        () => {
          if (active) timer = setTimeout(load, SETTINGS_RETRY_MS);
        },
      );
    load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [write]);
  const saveSettings = useCallback(
    (update: (current: SidebarSettings) => SidebarSettings) => {
      const next = update(latest.current);
      if (next === latest.current) return;
      latest.current = next;
      setSettings(next);
      if (saved.current) write(next);
      else queued.current.push(update);
    },
    [write],
  );
  /** Picks up the location the server remembered after a create; the server owns worktreeLocation. */
  const reloadWorktreeLocations = useCallback(async () => {
    try {
      const value = await readSidebarSettings();
      if (!validSettings(value)) return;
      if (saved.current)
        saved.current = { ...saved.current, worktreeLocation: value.worktreeLocation };
      latest.current = { ...latest.current, worktreeLocation: value.worktreeLocation };
      setSettings(latest.current);
    } catch {
      /* the dialog still sends the location it shows */
    }
  }, []);
  /** Shows a just-connected folder at once; the refresh that follows confirms it. */
  const addFolder = useCallback(
    (folder: FolderListing) => {
      setFolders((list) => [...list.filter((f) => f.path !== folder.path), folder]);
      void refreshProjects();
    },
    [refreshProjects],
  );
  const catalogSignature = JSON.stringify(catalogProjects);
  const sources = useMemo(
    () => projectSources(folders, worktrees, catalogProjects),
    [folders, worktrees, catalogSignature],
  );
  return {
    folders,
    sources,
    settings,
    saveSettings,
    refreshProjects,
    reloadWorktreeLocations,
    addFolder,
  };
}
