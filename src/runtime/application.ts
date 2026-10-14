import { createSessionCatalog, type SessionCatalog } from './session-catalog.js';
import type { SeenStore } from '../core/session-catalog.js';
import { readFileContext } from './file-content.js';
import type { FileReferenceStore, FileRegistry } from '../core/file-references.js';
import type { ImageAttachment } from '../core/contracts.js';
import { createFileRegistry } from './file-registry.js';
import { splitArgs } from './session-launcher.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { PACKAGE_NAME, packageRoot } from './package-root.js';
import { realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { searchFolders, type FolderSearchResult } from './folder-search.js';
import { validateSidebarSettings, type ConnectedFolder, type ConnectedFolderStore, type FolderKind, type SidebarSettings } from './connected-folders.js';
import type { ProjectMetadata } from './project-metadata.js';
import type { AgentAdapter, AgentKind, HostAdapter, LanguageBackend, ConversationStore, Target } from '../core/contracts.js';
import type { SessionRecord, SessionStore, WorkspaceData, WorkspaceRecord } from '../core/session-contracts.js';
import { createWorkflow, type Workflow } from '../core/workflow.js';
import { buildProjectContext } from '../core/project-context.js';
import { SqliteStore } from '../storage/sqlite-store.js';
import type { Action, RuntimeSnapshot, SourcePayload, DiscoveredTarget } from './protocol.js';
import { createSessionManager, type SessionManager } from './session-manager.js';
import { readProjectMetadata } from './project-metadata.js';
import { effectiveLanguageSettings, validateLanguageOverride, validateLanguageSettings, type LanguageOverride, type LanguageSettings, type LanguageSettingsStore } from '../core/language-settings.js';
import type { SessionLauncher, LaunchSettings, LaunchStore } from './session-launcher.js';
import type { TerminalBridge } from './terminal-bridge.js';
import type { DictationBridge } from './dictation/bridge.js';
import { createUsageService, type SessionUsageReport, type UsageService } from './usage.js';
import type { UsageSnapshot } from '../core/usage.js';
import type { AttentionMonitor } from './attention-monitor.js';
import { createClaudeChannelSetup, type ChannelSetupService } from './claude-channel-setup.js';
import { createNestedWorktreeLookup, createWorktreeService, insideFolderReal, type WorktreeInfo, type WorktreeInspection, type WorktreeService } from './worktrees.js';

export interface ApplicationOptions {
  channelSetup?: ChannelSetupService;
  capability?: string; store: ConversationStore & SessionStore & FileReferenceStore & Partial<LanguageSettingsStore> & Partial<LaunchStore> & Partial<ConnectedFolderStore> & Partial<SeenStore>; agents: AgentAdapter[];
  languageBackends: Partial<Record<AgentKind, LanguageBackend>>; host?: HostAdapter;
  /** Shared with the language backends so their calls feed the same tracker; created here when absent. */
  usage?: UsageService;
  launcher?: SessionLauncher; terminals?: TerminalBridge; attention?: AttentionMonitor; approveLaunchFolder?(folder: string): void;
  dictation?: DictationBridge;
  conversationId?: string; language?: string; model?: string; projectPath?: string; attachmentRoot?: string;
  folderSearch?: (query: string) => Promise<FolderSearchResult>;
  /** Ends every live launch whose folder is `folder` (used before deleting a worktree). */
  endLaunchesInFolder?(folder: string): Promise<unknown>;
  worktrees?: WorktreeService;
}
export interface WorktreeListing { hasCommits: boolean; worktrees: WorktreeInfo[] }
export interface WorktreeRemoval { removed: true; conversationsRemoved: number; skipped: number }
/** What deleting a worktree would affect: its changes, plus sessions that would be ended (`launchedSessions`) or left running without a folder (`otherOpenSessions`). */
export interface WorktreeDeletePreview extends WorktreeInspection { launchedSessions: number; launchedTerminals: number; otherOpenSessions: number }
export interface CreatedWorktree { path: string; branch: string; location: string; ignore?: { added: boolean; line: string } }
export interface FolderListing extends ConnectedFolder { projectName: string; branch?: string; missing: boolean }
export interface AboutInfo { name: string; version: string; platform: string; arch: string }
/** This package's name and version, read from the package root's package.json (see packageRoot). */
function readPackage(): { name: string; version: string } {
  const root = packageRoot(dirname(fileURLToPath(import.meta.url)));
  if (root) try {
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof version === 'string') return { name: PACKAGE_NAME, version };
  } catch { /* fall back */ }
  return { name: PACKAGE_NAME, version: '0.0.0' };
}
export interface SessionLanguage { defaults: LanguageSettings; override: LanguageOverride; effective: LanguageSettings }
export interface Application {
  claudeChannelStatus?(id: string): ReturnType<ChannelSetupService['status']>;
  prepareClaudeChannel?(id: string): ReturnType<ChannelSetupService['createChannelSetup']>;
  uploadImage?(input: { name: string; data: string }, sessionId?: string): Promise<ImageAttachment>;
  readonly files?: FileRegistry;
  readImage?(id: string, sessionId?: string): Promise<ImageAttachment>;
  readonly capability: string;
  readonly launcher?: SessionLauncher;
  readonly terminals?: TerminalBridge;
  readonly dictation?: DictationBridge;
  approveLaunchFolder?(folder: string): void;
  about?(): AboutInfo;
  listFolders?(): Promise<FolderListing[]>;
  searchFolders?(query: string): Promise<FolderSearchResult>;
  connectFolder?(path: unknown): Promise<ConnectedFolder & { projectName: string; branch?: string; missing: false }>;
  forgetFolder?(path: unknown): void;
  sidebarSettings?(): SidebarSettings;
  setSidebarSettings?(value: unknown): SidebarSettings;
  listWorktrees?(projectKey: string): Promise<WorktreeListing>;
  inspectWorktree?(projectKey: string, path: unknown): Promise<WorktreeDeletePreview>;
  /** Creates in `location` (or the remembered/default one); the server remembers a non-default canonical location for the project. */
  createWorktree?(projectKey: string, input: { name?: unknown; location?: unknown }): Promise<CreatedWorktree>;
  /** `current` is the session the UI shows; its folder cannot be deleted. Dirty worktrees are never refused. */
  removeWorktree?(projectKey: string, input: { path: unknown; removeConversations?: boolean; current?: string }): Promise<WorktreeRemoval>;
  initGit?(projectKey: string): Promise<{ projectKey: string }>;
  summarizeWorktreeChanges?(projectKey: string, path: unknown): Promise<{ text: string }>;
  launchSettings?(): LaunchSettings;
  setLaunchSettings?(value: unknown): LaunchSettings;
  languageDefaults?(): LanguageSettings;
  setLanguageDefaults?(value: unknown): LanguageSettings;
  sessionLanguage?(id: string): SessionLanguage;
  setSessionLanguage?(id: string, override: unknown | null): SessionLanguage;
  readonly sessions?: SessionManager;
  /** Removes a closed session from this app's history only; agent transcripts are never touched. */
  removeSession?(id: string): Promise<void>;
  readonly catalog?: SessionCatalog;
  readonly usage?: UsageService;
  /** The selected session's provider quota and what Gloss spent for it, today and overall. */
  sessionUsage?(id: string): SessionUsageReport;
  refreshUsage?(provider: unknown): Promise<UsageSnapshot>;
  restore?(preferredId?: string): Promise<void>;
  discoverSessions?(projectPath: string): Promise<DiscoveredTarget[]>;
  createSession?(target: Target): Promise<RuntimeSnapshot>;
  readWorkspace?(id: string): WorkspaceRecord;
  writeWorkspace?(id: string, expectedRevision: number, data: WorkspaceData): WorkspaceRecord | Promise<WorkspaceRecord>;
  snapshot(): RuntimeSnapshot;
  action(action: Action): Promise<RuntimeSnapshot>;
  ingestSourceMessage?: (message: SourcePayload) => Promise<RuntimeSnapshot>;
  subscribe(listener: (value: RuntimeSnapshot) => void): () => void;
  close(): Promise<void>;
}
export function createApplication(options: ApplicationOptions): Application {
  const id = options.conversationId ?? 'language-default';
  let closed = false;
  let closing: Promise<void> | undefined;
  const settingsStore = options.store as Partial<LanguageSettingsStore>;
  const launchStore = options.store as Partial<LaunchStore>;
  const readDefaults = (): LanguageSettings | undefined => settingsStore.readLanguageDefaults?.();
  const readOverride = (sessionId: string): LanguageOverride => settingsStore.readLanguageOverride?.(sessionId) ?? {};
  const worktrees = options.worktrees ?? createWorktreeService();
  const usage = options.usage ?? createUsageService({ store: options.store as Partial<import('../core/usage.js').SpendStore> });
  const files = createFileRegistry({store: options.store, nestedWorktrees: createNestedWorktreeLookup(worktrees), ...(options.attachmentRoot ? {attachmentRoot:options.attachmentRoot} : {})});
  /** The model a session's language calls use: the launch flag for the launch session, else its saved choice, else the provider default. */
  const languageModelFor = (record: SessionRecord): string => { const saved = options.store.load(record.id); return (record.id === id ? options.model : undefined) ?? (saved?.languageModel !== 'default' ? saved?.languageModel : undefined) ?? (record.target.agent === 'claude' ? 'haiku' : 'gpt-5.6-sol'); };
  const sessions = createSessionManager({ store: options.store, agents: options.agents, files,
    ...(settingsStore.readLanguageDefaults ? { languageSettings: (sessionId: string) => effectiveLanguageSettings(readDefaults()!, readOverride(sessionId)) } : {}),
    async createWorkflowForSession(record) {
      const current = options.store.load(record.id);
      const backend = options.languageBackends[record.target.agent];
      if (!backend) throw Object.assign(new Error('No language backend available'), { code: 'model-unavailable' });
      const project = record.target.projectId;
      if (!(await readProjectMetadata(project)).available) throw Object.assign(new Error('Project directory is unavailable'), { code: 'project-unavailable' });
      const selectedModel = languageModelFor(record);
      const session = await backend.open(selectedModel, current?.languageSessionId, { scope: record.id });
      let workflow: Workflow | undefined;
      try {
        workflow = createWorkflow({ files, readFileContext, conversationId: record.id, language: current?.language ?? options.language ?? 'he', languageModel: selectedModel, languageSession: session,
          projectContext: () => buildProjectContext({ notes: options.store.readContext(project) ?? '', messages: workflow?.snapshot().codingMessages ?? [], maxCharacters: 12000 }), agents: options.agents, store: options.store, onUsage: value => usage.tracker.observe(value),
          ...(readDefaults() ? { languageSettings: () => effectiveLanguageSettings(readDefaults()!, readOverride(record.id)) } : {}) });
        await workflow.connect(record.target);
        return workflow;
      } catch (error) { if (workflow) await workflow.close(); else await session.close(); throw error; }
    },
  });
  const catalog = createSessionCatalog({ sessions, agents: options.agents, usage: () => usage.tracker.snapshot(), ...(options.launcher ? { launcher: options.launcher } : {}), ...(options.attention ? { attention: options.attention } : {}), ...(options.store.markSeen && options.store.seenSequence ? { seen: options.store as SeenStore } : {}) });
  const unsubscribeUsage = usage.tracker.subscribe(() => catalog.refresh());
  const channelSetup = options.channelSetup ?? createClaudeChannelSetup();
  const savedTarget = (id: string) => { sessions.snapshot(id); return sessions.list().find(record => record.id === id)!.target; };
  const pkg = readPackage();
  const folderStore = options.store as Partial<ConnectedFolderStore>;
  const folderStoreOrThrow = () => { if (!folderStore.listConnectedFolders || !folderStore.putConnectedFolder || !folderStore.deleteConnectedFolder || !folderStore.readSidebarSettings || !folderStore.writeSidebarSettings) throw new Error('Folder storage unavailable'); return folderStore as ConnectedFolderStore; };
  const metadataCache = new Map<string, { at: number; value: Promise<ProjectMetadata> }>();
  const folderMetadata = (path: string) => {
    const cached = metadataCache.get(path);
    if (cached && Date.now() - cached.at < 30000) return cached.value;
    const value = readProjectMetadata(path); metadataCache.set(path, { at: Date.now(), value }); return value;
  };
  const failure = (message: string, code: string) => Object.assign(new Error(message), { code });
  const recordFolder = (record: { worktreePath?: string; target: Target }) => record.worktreePath ?? record.target.projectId;
  // A Git project is named after its main checkout (the parent of its common dir), whichever of its folders was connected —
  // also when that folder is gone and only its stored projectKey remains.
  const projectDisplayName = (projectKey: string | undefined, fallback: string) =>
    projectKey?.endsWith('/.git') ? basename(dirname(projectKey)) : fallback;
  // projectKey is a Git common dir (main checkout = its parent when named .git) or a plain folder. Members are the
  // connected folders and catalog rows carrying the key; only known keys resolve.
  const resolveProject = async (projectKey: unknown): Promise<{ key: string; main: string; git: boolean }> => {
    requireOpen();
    if (typeof projectKey !== 'string' || !projectKey) throw failure('Unknown project', 'unknown-project');
    const connected = folderStore.listConnectedFolders?.().filter(f => f.projectKey === projectKey) ?? [];
    const rows = catalog.snapshot().entries.filter(e => e.projectKey === projectKey);
    if (!connected.length && !rows.length) throw failure('Unknown project', 'unknown-project');
    if (basename(projectKey) === '.git') return { key: projectKey, main: dirname(projectKey), git: true };
    for (const member of [projectKey, ...connected.map(f => f.path), ...rows.map(recordFolder)]) {
      const meta = await readProjectMetadata(member);
      if (!meta.available || !meta.worktreePath) continue;
      if (meta.projectKey !== projectKey && member !== projectKey) continue;
      // A separate Git dir has no .git parent; the first worktree Git lists is the main checkout.
      const [first] = await worktrees.list(meta.worktreePath);
      return { key: projectKey, main: first?.path ?? meta.worktreePath, git: true };
    }
    if (!(await readProjectMetadata(projectKey)).available) throw failure('Project directory is unavailable', 'project-unavailable');
    return { key: projectKey, main: projectKey, git: false };
  };
  const requireGit = (project: { git: boolean }) => { if (!project.git) throw failure('This folder does not use Git yet.', 'bad-request'); };
  const worktreePath = async (value: unknown) => {
    if (typeof value !== 'string' || !isAbsolute(value)) throw failure('Choose a worktree folder', 'bad-request');
    return realpath(value).catch(() => value);
  };
  const requireOpen = () => { if (closed) throw Object.assign(new Error('Application is closed'), { code: 'closed' }); };
  const ensureLaunchRegistration = async () => {
    if (sessions.list().some(r => r.id === id)) return;
    const target = options.store.load(id)?.target;
    if (target) await sessions.register(target, id);
  };
  return {
    capability: options.capability ?? randomUUID(), sessions, files, catalog,
    ...(options.launcher ? { launcher: options.launcher } : {}), ...(options.terminals ? { terminals: options.terminals } : {}), ...(options.dictation ? { dictation: options.dictation } : {}), ...(options.approveLaunchFolder ? { approveLaunchFolder: options.approveLaunchFolder } : {}),
    async removeSession(sessionId) {
      requireOpen(); sessions.snapshot(sessionId);
      const conflict = (message: string) => Object.assign(new Error(message), { code: 'session-open' });
      const entry = catalog.entryFor(sessionId);
      if (entry?.open) throw conflict('Session is open; close it before removing it from history');
      if (options.launcher?.list().some(l => l.panelSessionId === sessionId && l.state !== 'ended')) throw conflict('Session is still running; end it before removing it from history');
      // Uploaded copies live in the app's own attachment folder; worktree references are never deleted.
      const uploads = options.store.listFileReferences(sessionId).filter(file => file.source === 'upload' && options.store.fileOwners(file.id).every(owner => owner === sessionId));
      await sessions.remove(sessionId, { catalogClosed: entry !== undefined });
      catalog.forget(sessionId);
      await Promise.all(uploads.map(file => unlink(file.path).catch(() => {})));
    },
    about() { requireOpen(); return { name: pkg.name, version: pkg.version, platform: process.platform, arch: process.arch }; },
    usage,
    sessionUsage(sessionId) { requireOpen(); const record = sessions.list().find(r => r.id === sessionId); if (!record) throw Object.assign(new Error('Unknown session'), { code: 'unknown-session' }); return usage.report(sessionId, record.target.agent, languageModelFor(record)); },
    async refreshUsage(provider) { requireOpen(); if (provider !== 'claude' && provider !== 'codex') throw new Error('Unknown provider'); return usage.refresh(provider, options.languageBackends, AbortSignal.timeout(60_000)); },
    searchFolders(query) { requireOpen(); return (options.folderSearch ?? ((q: string) => searchFolders(q, { home: homedir() })))(query); },
    async listFolders() {
      requireOpen();
      return Promise.all(folderStoreOrThrow().listConnectedFolders().map(async folder => {
        const meta = await folderMetadata(folder.path);
        return { ...folder, projectName: projectDisplayName(folder.projectKey, meta.projectName), ...(meta.branch ? { branch: meta.branch } : {}), missing: !meta.available };
      }));
    },
    async connectFolder(path) {
      requireOpen(); const folders = folderStoreOrThrow();
      if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Choose a folder on this computer');
      const real = await realpath(path).catch(() => { throw new Error('Folder unavailable'); });
      if (!(await stat(real)).isDirectory()) throw new Error('Folder must be a directory');
      metadataCache.delete(real);
      const meta = await folderMetadata(real);
      // projectKey is the Git common dir (its parent is the main checkout) or the folder itself outside Git.
      const kind: FolderKind = !meta.worktreePath || !meta.projectKey ? 'plain' : meta.worktreePath === dirname(meta.projectKey) ? 'main' : 'worktree';
      const existing = folders.listConnectedFolders().find(f => f.path === real);
      const folder: ConnectedFolder = { path: real, projectKey: meta.projectKey ?? real, kind, createdByApp: existing?.createdByApp ?? false, connectedAt: existing?.connectedAt ?? Date.now() };
      folders.putConnectedFolder(folder); options.approveLaunchFolder?.(real); catalog.refresh();
      return { ...folder, projectName: projectDisplayName(folder.projectKey, meta.projectName), ...(meta.branch ? { branch: meta.branch } : {}), missing: false };
    },
    forgetFolder(path) {
      requireOpen(); const folders = folderStoreOrThrow();
      if (typeof path !== 'string' || !path) throw new Error('Folder path required');
      let real = path; try { real = realpathSync(path); } catch { /* folder may be gone; forget the stored path */ }
      for (const known of new Set([path, real])) folders.deleteConnectedFolder(known);
      metadataCache.delete(path); catalog.refresh();
    },
    async listWorktrees(projectKey) {
      const project = await resolveProject(projectKey);
      if (!project.git) return { hasCommits: false, worktrees: [] };
      const [hasCommits, list] = await Promise.all([worktrees.hasCommits(project.main), worktrees.list(project.main)]);
      return { hasCommits, worktrees: list };
    },
    async inspectWorktree(projectKey, path) {
      const project = await resolveProject(projectKey); requireGit(project);
      const folder = await worktreePath(path);
      const info = await worktrees.inspect(project.main, folder);
      // Launches inside the folder are ended on delete; other open sessions there are not ours to end.
      const live = options.launcher?.list().filter(l => l.state !== 'ended') ?? [];
      const inside = await Promise.all(live.map(l => insideFolderReal(l.folder, folder)));
      const launched = live.filter((_, i) => inside[i]);
      const launchedIds = launched.map(l => l.id);
      const open = catalog.snapshot().entries.filter(e => e.open && !(e.launchId && launchedIds.includes(e.launchId)));
      const others = (await Promise.all(open.map(e => insideFolderReal(recordFolder(e), folder)))).filter(Boolean).length;
      return { ...info, launchedSessions: launched.filter(l => l.agent !== 'shell').length, launchedTerminals: launched.filter(l => l.agent === 'shell').length, otherOpenSessions: others };
    },
    async createWorktree(projectKey, input) {
      const project = await resolveProject(projectKey); requireGit(project);
      const folders = folderStoreOrThrow();
      const fallback = join(project.main, '.worktrees');
      const location = input?.location === undefined || input.location === null || input.location === '' ? folders.readSidebarSettings().worktreeLocation[project.key] ?? fallback : input.location;
      if (typeof location !== 'string') throw failure('Choose an absolute folder for worktrees.', 'bad-request');
      const created = await worktrees.create(project.main, typeof input?.name === 'string' ? input.name : '', location);
      folders.putConnectedFolder({ path: created.path, projectKey: project.key, kind: 'worktree', createdByApp: true, connectedAt: Date.now() });
      // The server owns worktreeLocation: a non-default canonical location is remembered, the default one forgets it.
      const settings = folders.readSidebarSettings(); const remembered = { ...settings.worktreeLocation };
      if (created.location === await realpath(fallback).catch(() => fallback)) delete remembered[project.key]; else remembered[project.key] = created.location;
      if (remembered[project.key] !== settings.worktreeLocation[project.key]) folders.writeSidebarSettings({ ...settings, worktreeLocation: remembered });
      metadataCache.delete(created.path); options.approveLaunchFolder?.(created.path); catalog.refresh();
      return created;
    },
    async removeWorktree(projectKey, input) {
      const project = await resolveProject(projectKey); requireGit(project);
      const path = await worktreePath(input?.path);
      const conflict = (message: string) => failure(message, 'worktree-conflict');
      if (path === project.main) throw conflict('The main checkout cannot be deleted from here.');
      if (!(await worktrees.list(project.main)).some(w => w.path === path && !w.main)) throw conflict('This path is not a worktree of this project.');
      if (input.current) {
        const shown = sessions.list().find(r => r.id === input.current);
        if (shown && await insideFolderReal(recordFolder(shown), path)) throw conflict('This worktree is open in the current session; switch to another session first.');
      }
      await options.endLaunchesInFolder?.(path);
      // Resolve which sessions live in the worktree (or a subfolder) while its paths still exist.
      const owned: string[] = [];
      if (input.removeConversations) for (const record of sessions.list()) if (await insideFolderReal(recordFolder(record), path) || await insideFolderReal(record.canonicalRoot, path)) owned.push(record.id);
      const keptRow = folderStore.listConnectedFolders?.().find(f => f.path === path);
      const hasSaved = !input.removeConversations && (await Promise.all(sessions.list().map(record => insideFolderReal(recordFolder(record), path)))).some(Boolean);
      await worktrees.remove(project.main, path);
      // Kept conversations stay reachable: the folder's row remains (a missing folder with Show sessions). Removing them drops it.
      if (input.removeConversations) folderStore.deleteConnectedFolder?.(path);
      else if (!keptRow && hasSaved) folderStore.putConnectedFolder?.({ path, projectKey: project.key, kind: 'worktree', createdByApp: false, connectedAt: Date.now() });
      metadataCache.delete(path);
      let conversationsRemoved = 0; let skipped = 0;
      if (input.removeConversations) {
        for (const sessionId of owned) {
          // Launches were just ended, but the catalog may still show a session open; those are kept and counted.
          try { await this.removeSession!(sessionId); conversationsRemoved += 1; }
          catch (error) { if ((error as { code?: string }).code !== 'session-open') throw error; skipped += 1; }
        }
      }
      catalog.refresh();
      return { removed: true, conversationsRemoved, skipped };
    },
    async initGit(projectKey) {
      const project = await resolveProject(projectKey);
      if (project.git) throw failure('This folder already uses Git.', 'bad-request');
      await worktrees.initGit(project.main);
      metadataCache.delete(project.main);
      const meta = await folderMetadata(project.main);
      const key = meta.projectKey ?? project.main;
      for (const folder of folderStore.listConnectedFolders?.().filter(f => f.projectKey === project.key) ?? []) {
        metadataCache.delete(folder.path);
        const folderMeta = await folderMetadata(folder.path);
        folderStore.putConnectedFolder!({ ...folder, projectKey: folderMeta.projectKey ?? key, kind: folderMeta.worktreePath && folderMeta.projectKey ? 'main' : 'plain' });
      }
      catalog.refresh();
      return { projectKey: key };
    },
    async summarizeWorktreeChanges(projectKey, path) {
      const project = await resolveProject(projectKey); requireGit(project);
      const info = await worktrees.inspect(project.main, await worktreePath(path));
      const backend = options.languageBackends.claude ?? options.languageBackends.codex;
      if (!backend) throw failure('No language backend available', 'model-unavailable');
      const session = await backend.open(options.languageBackends.claude ? 'haiku' : 'gpt-5.6-sol');
      try {
        const assist = readDefaults()?.assist ?? 'he';
        return { text: await session.summarize(describeInspection(info), assist, AbortSignal.timeout(20000)) };
      } finally { await session.close(); }
    },
    sidebarSettings() { requireOpen(); return folderStoreOrThrow().readSidebarSettings(); },
    // worktreeLocation is written only by createWorktree; a client copy (possibly stale) is ignored.
    setSidebarSettings(value) { requireOpen(); const folders = folderStoreOrThrow(); folders.writeSidebarSettings({ ...validateSidebarSettings(value), worktreeLocation: folders.readSidebarSettings().worktreeLocation }); catalog.refresh(); return folders.readSidebarSettings(); },
    launchSettings() { requireOpen(); if (!launchStore.readLaunchSettings) throw new Error('Launch settings unavailable'); return launchStore.readLaunchSettings(); },
    setLaunchSettings(value) { requireOpen(); if (!launchStore.writeLaunchSettings || !launchStore.readLaunchSettings) throw new Error('Launch settings unavailable'); launchStore.writeLaunchSettings(normalizeLaunchSettings(value)); return launchStore.readLaunchSettings(); },
    languageDefaults() { requireOpen(); if (!settingsStore.readLanguageDefaults) throw new Error('Language settings unavailable'); return settingsStore.readLanguageDefaults(); },
    setLanguageDefaults(value) {
      requireOpen(); if (!settingsStore.writeLanguageDefaults) throw new Error('Language settings unavailable');
      settingsStore.writeLanguageDefaults(validateLanguageSettings(value)); sessions.refreshLanguageSettings(); catalog.refresh(); return settingsStore.readLanguageDefaults!();
    },
    sessionLanguage(sessionId) {
      requireOpen(); sessions.snapshot(sessionId);
      const defaults = this.languageDefaults!(); const override = readOverride(sessionId);
      return { defaults, override, effective: effectiveLanguageSettings(defaults, override) };
    },
    setSessionLanguage(sessionId, override) {
      requireOpen(); sessions.snapshot(sessionId); if (!settingsStore.writeLanguageOverride) throw new Error('Language settings unavailable');
      settingsStore.writeLanguageOverride(sessionId, override === null ? null : validateLanguageOverride(override));
      sessions.refreshLanguageSettings(sessionId); catalog.refresh(); return this.sessionLanguage!(sessionId);
    },
    async claudeChannelStatus(id) { requireOpen(); return channelSetup.status(savedTarget(id)); },
    async prepareClaudeChannel(id) { requireOpen(); return channelSetup.createChannelSetup(savedTarget(id)); },
    async uploadImage(input, sessionId = id) {
      requireOpen();
      const file = await files.upload(sessionId,{...input,mime:'image/png'});
      return {...file,kind:'image'};
    },
    async readImage(fileId, sessionId = id) {
      requireOpen();
      const [file] = await files.resolve(sessionId,[fileId]);
      if (!file || file.kind !== 'image') throw new Error('Attachment is not an image');
      return {...file,kind:'image'};
    },
    async discoverSessions(projectPath) {
      requireOpen();
      if (typeof projectPath !== 'string' || !projectPath.trim()) throw new Error('Project path required');
      const project = await readProjectMetadata(projectPath);
      if (!project.available) throw Object.assign(new Error('Project directory is unavailable'), { code: 'project-unavailable' });
      const targets = await Promise.all(options.agents.map(async adapter => (await adapter.discover(projectPath)).filter(target => target.agent === adapter.kind)));
      return Promise.all(targets.flat().map(async target => ({ target, ...await readProjectMetadata(target.projectId) })));
    },
    async createSession(target) {
      requireOpen();
      if (!target || !['claude', 'codex'].includes(target.agent) || typeof target.sessionRef !== 'string' || !target.sessionRef || typeof target.projectId !== 'string') throw new Error('Invalid target');
      const adapter = options.agents.find(adapter => adapter.kind === target.agent);
      const verified = (await adapter?.discover(target.projectId))?.find(candidate => candidate.agent === target.agent && candidate.sessionRef === target.sessionRef && candidate.projectId === target.projectId);
      if (!verified) throw Object.assign(new Error('Target is unavailable'), { code: 'target-unavailable' });
      const record = await sessions.register(verified);
      return sessions.action(record.id, { type: 'connect', target: record.target });
    },
    readWorkspace(sessionId) { requireOpen(); sessions.snapshot(sessionId); return options.store.readWorkspace(sessionId); },
    async writeWorkspace(sessionId, expectedRevision, data) {
      requireOpen(); sessions.snapshot(sessionId);
      if (options.store.readWorkspace(sessionId).revision !== expectedRevision) return options.store.writeWorkspace(sessionId,expectedRevision,data);
      const ids = [...new Set([...(data.attachmentIds ?? []), ...(data.composerAttempt?.attachmentIds ?? [])])];
      await files.importLegacyWorkspace(sessionId,ids);
      return options.store.writeWorkspace(sessionId, expectedRevision, data);
    },
    async restore(preferredId) { requireOpen(); await options.launcher?.reconcile(); await ensureLaunchRegistration(); await sessions.restore(preferredId); if (!closed) { options.attention?.start(); options.launcher?.watch?.(); catalog.start(); } },
    snapshot() {
      if (sessions.list().some(r => r.id === id)) return sessions.snapshot(id);
      const saved = options.store.load(id);
      return { sequence: 0, snapshot: saved ? { ...saved, codingState: 'disconnected' } : { id, codingState: 'disconnected', codingMessages: [], discussion: [], deliveries: [], language: options.language ?? 'he', languageSessionId: '', languageModel: options.model ?? 'default', sourceRevision: 0 } };
    },
    async action(action) {
      requireOpen(); await ensureLaunchRegistration();
      if (action.type === 'connect' && !sessions.list().some(r => r.id === id)) {
        const record = await sessions.register(action.target, id);
        if (record.id !== id) throw new Error('Target belongs to another registered session');
      }
      if (!sessions.list().some(r => r.id === id)) throw Object.assign(new Error('Connect a coding session first'), { code: 'session-required' });
      return sessions.action(id, action);
    },
    async ingestSourceMessage(message) {
      requireOpen(); await ensureLaunchRegistration();
      if (!message || typeof message.sourceSessionId !== 'string') throw new Error('Invalid source identity');
      const matching = sessions.list().filter(record => record.target.sessionRef === message.sourceSessionId && (message.agent === undefined || record.target.agent === message.agent));
      if (matching.length !== 1) throw Object.assign(new Error('Unknown or ambiguous source session'), { code: 'source-identity' });
      return sessions.ingest(matching[0]!.target.agent, message);
    },
    subscribe(listener) { return sessions.subscribe(id, listener); },
    close() {
      closing ??= (async () => {
        closed = true;
        try { unsubscribeUsage(); options.dictation?.close(); options.attention?.close(); options.terminals?.close(); options.launcher?.close(); await catalog.close(); await sessions.close(); }
        finally { (options.store as ConversationStore & { close?: () => void }).close?.(); }
      })();
      return closing;
    },
  };
}
export { SqliteStore };

/** Accepts each agent's extra arguments as a string (split here, so quoting rules live in splitArgs) or an array. */
function normalizeLaunchSettings(value: unknown): LaunchSettings {
  const input = value as { extraArgs?: Record<string, unknown> } | null;
  if (!input || typeof input !== 'object' || !input.extraArgs || typeof input.extraArgs !== 'object') return value as LaunchSettings;
  const extraArgs = Object.fromEntries(Object.entries(input.extraArgs).map(([agent, args]) => [agent, typeof args === 'string' ? splitArgs(args) : args]));
  return { ...(value as object), extraArgs } as LaunchSettings;
}

/** Statuses, file names and change times only; file contents never leave the computer here. */
function describeInspection(info: WorktreeInspection): string {
  const when = (time?: number) => time === undefined ? 'unknown time' : new Date(time).toISOString();
  const lines = [`Worktree ${basename(info.path)}, branch ${info.branch ?? 'detached'}: ${info.modified} modified, ${info.untracked} untracked, ${info.unmergedCommits} unmerged commits`,
    ...info.changedFiles.slice(0, 199).map(file => `${file.status} ${file.path} — changed ${when(file.changedAt)}`)];
  const unlisted = info.modified + info.untracked - Math.min(info.changedFiles.length, 199);
  return [...lines, ...(unlisted > 0 ? [`(${unlisted} more changed files not listed)`] : [])].join('\n');
}
