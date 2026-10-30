import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { AgentAdapter, AgentKind, Target } from '../core/contracts.js';
import { attentionFor, latestResponseSequence } from '../core/attention.js';
import type {
  CatalogEntry,
  CatalogSnapshot,
  OpenSessionCandidate,
  SeenStore,
  SessionCatalog,
} from '../core/session-catalog.js';
import { languageShortCode } from '../core/language-settings.js';
import type { SessionRecord, TerminalEntry } from '../core/session-contracts.js';
import type { SessionManager } from './session-manager.js';
import type { SessionLauncher, LaunchRecord } from './session-launcher.js';
import type { AttentionMonitor } from './attention-monitor.js';
import { readProjectMetadata, type ProjectMetadata } from './project-metadata.js';
export type { SessionCatalog } from '../core/session-catalog.js';
export interface CatalogClock {
  now(): number;
  setInterval(callback: () => void, milliseconds: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}
export interface SessionCatalogOptions {
  seen?: SeenStore;
  sessions: SessionManager;
  agents: AgentAdapter[];
  readProjectMetadata?: (path: string) => Promise<ProjectMetadata>;
  clock?: CatalogClock;
  launcher?: Pick<SessionLauncher, 'list' | 'subscribe'> &
    Partial<Pick<SessionLauncher, 'noticeDiscovery'>>;
  attention?: Pick<AttentionMonitor, 'current' | 'subscribe'>;
  /** Latest quota windows per provider; republished whenever refresh() runs. */
  usage?: () => import('../core/usage.js').UsageSnapshot;
}
const nativeKey = (target: Target) => `${target.agent}:${target.sessionRef}`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
export function createSessionCatalog(options: SessionCatalogOptions): SessionCatalog {
  const { sessions } = options;
  const clock = options.clock ?? { now: Date.now, setInterval, clearInterval };
  const metadataReader = options.readProjectMetadata ?? readProjectMetadata;
  const controller = new AbortController();
  const rows = new Map<string, CatalogEntry>();
  const candidates = new Map<string, OpenSessionCandidate>();
  const subscriptions = new Map<string, () => void>();
  const sourceSubscriptions: (() => void)[] = [];
  const metadata = new Map<string, { at: number; value: ProjectMetadata }>();
  const metadataReads = new Map<string, Promise<ProjectMetadata>>();
  const listeners = new Set<(snapshot: CatalogSnapshot) => void>();
  let current: CatalogSnapshot = {
    epoch: randomUUID(),
    sequence: 0,
    entries: [],
    terminals: [],
    discovery: { state: 'healthy' },
  };
  let started = false;
  let closed = false;
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let unregister: (() => void) | undefined;
  // Language codes are cached per session; refresh() clears them after settings change.
  const codes = new Map<string, string | undefined>();
  const languageCodeFor = (sessionId: string) => {
    if (!codes.has(sessionId)) {
      try {
        const settings = sessions.snapshot(sessionId).snapshot.languageSettings;
        codes.set(sessionId, settings ? languageShortCode(settings) : undefined);
      } catch {
        return undefined;
      }
    }
    return codes.get(sessionId);
  };
  // The catalog is the only writer of seen markers, so each is read from the store once and then served from memory.
  const seenCache = new Map<string, number | undefined>();
  const seenOf = (sessionId: string) => {
    if (!options.seen) return undefined;
    if (!seenCache.has(sessionId)) seenCache.set(sessionId, options.seen.seenSequence(sessionId));
    return seenCache.get(sessionId);
  };
  // The store keeps the higher of the stored and written sequence; the cache follows the same rule.
  const writeSeen = (sessionId: string, sequence: number) => {
    if (!options.seen) return;
    const previous = seenOf(sessionId);
    options.seen.markSeen(sessionId, sequence);
    seenCache.set(sessionId, Math.max(previous ?? -1, sequence));
  };
  const agentLabel = (launch: LaunchRecord) => (launch.agent === 'claude' ? 'Claude' : 'Codex');
  // Launch rows use cached project metadata; a missing entry is read once and republished.
  const launchProject = (folder: string) => {
    const cached = metadata.get(folder)?.value;
    if (!cached && !metadataReads.has(folder) && !closed) {
      const read = Promise.resolve()
        .then(() => metadataReader(folder))
        .finally(() => {
          metadataReads.delete(folder);
        });
      metadataReads.set(folder, read);
      read.then(
        (value) => {
          if (!closed && !metadata.has(folder)) {
            metadata.set(folder, { at: clock.now(), value });
            publish();
          }
        },
        () => {},
      );
    }
    return cached?.available
      ? { projectKey: cached.projectKey ?? cached.canonicalRoot, projectName: cached.projectName }
      : {
          projectKey: resolve(folder),
          projectName: folder.split('/').filter(Boolean).pop() ?? folder,
        };
  };
  const decorate = (
    entry: CatalogEntry,
    launch: LaunchRecord,
    attention: ReturnType<AttentionMonitor['current']>,
  ): CatalogEntry => {
    const seen = attention.get(launch.id);
    return {
      ...entry,
      launchId: launch.id,
      launchState: launch.state,
      ...(seen?.state === 'needs-user' ? { activity: 'approval-required' as const } : {}),
      // The screen shows Claude's question dialog; its session record normally says so too, but not every version does.
      ...(seen?.state === 'question' && (entry.activity === 'idle' || entry.activity === 'working')
        ? { activity: 'dialog-open' as const }
        : {}),
      ...(seen?.state === 'unknown-version'
        ? {
            attentionNotice: `Approval detection unavailable for this ${agentLabel(launch)} version`,
          }
        : {}),
    };
  };
  const launchEntries = (entries: CatalogEntry[]): CatalogEntry[] => {
    if (!options.launcher) return entries;
    const launches = options.launcher
      .list()
      .filter(
        (launch): launch is LaunchRecord & { agent: AgentKind } =>
          launch.state !== 'ended' && launch.agent !== 'shell',
      );
    const attention = options.attention?.current() ?? new Map();
    // A launch owns the row registered for its panel, or the row discovered under its native session.
    const owner = (entry: CatalogEntry) =>
      launches.find(
        (l) =>
          (entry.sessionId !== undefined && l.panelSessionId === entry.sessionId) ||
          (l.sessionRef !== undefined &&
            entry.key ===
              nativeKey({ agent: l.agent, sessionRef: l.sessionRef, projectId: l.folder })),
      );
    const owned = new Set<string>();
    const result = entries.map((entry) => {
      const launch = owner(entry);
      if (!launch) return entry;
      owned.add(launch.id);
      return decorate(entry, launch, attention);
    });
    for (const launch of launches) {
      if (
        owned.has(launch.id) ||
        launch.panelSessionId ||
        (launch.state !== 'starting' && launch.state !== 'unidentified')
      )
        continue;
      const sessionRef = 'launch:' + launch.id;
      result.push(
        decorate(
          {
            key: sessionRef,
            target: { agent: launch.agent, sessionRef, projectId: launch.folder },
            ...launchProject(launch.folder),
            worktreePath: launch.folder,
            open: true,
            activity: launch.state === 'starting' ? 'connecting' : 'unknown',
            availability: 'unavailable',
            reason:
              launch.state === 'starting'
                ? 'Starting…'
                : (launch.reason ?? 'Started, not connected'),
          },
          launch,
          attention,
        ),
      );
    }
    return result;
  };
  const titleNumber = (title: string) => Number(/^Terminal(?: (\d+))?$/.exec(title)?.[1] ?? 1);
  const terminalEntries = (): TerminalEntry[] => {
    if (!options.launcher) return [];
    return options.launcher
      .list()
      .filter((l) => l.agent === 'shell' && l.state !== 'ended')
      .map((l) => ({
        key: 'terminal:' + l.id,
        launchId: l.id,
        title: l.title ?? 'Terminal',
        busy: l.busy === true,
        folder: l.folder,
        ...launchProject(l.folder),
        ...(l.originSessionId ? { originSessionId: l.originSessionId } : {}),
      }))
      .sort(
        (a, b) =>
          a.projectKey.localeCompare(b.projectKey) ||
          a.folder.localeCompare(b.folder) ||
          titleNumber(a.title) - titleNumber(b.title),
      );
  };
  const publish = () => {
    if (closed) return;
    const entries = launchEntries(
      [...rows.values()].map((row) => {
        const { languageCode: _stale, ...rest } = row;
        const languageCode = row.sessionId ? languageCodeFor(row.sessionId) : undefined;
        return languageCode ? { ...rest, languageCode } : rest;
      }),
    ).sort(
      (a, b) =>
        a.projectKey.localeCompare(b.projectKey) ||
        Number(b.open) - Number(a.open) ||
        a.key.localeCompare(b.key),
    );
    // Cached metadata (30s TTL per folder) is the only source; no extra filesystem reads happen here.
    for (const entry of entries) {
      delete entry.folderMissing;
      if (metadata.get(entry.target.projectId)?.value.available === false)
        entry.folderMissing = true;
    }
    for (const entry of entries) {
      const attention = attentionFor(entry, entry.sessionId ? seenOf(entry.sessionId) : undefined);
      if (attention === 'none') delete entry.attention;
      else entry.attention = attention;
    }
    const terminals = terminalEntries();
    const usage = options.usage?.();
    if (
      isDeepStrictEqual(entries, current.entries) &&
      isDeepStrictEqual(terminals, current.terminals ?? []) &&
      isDeepStrictEqual(health, current.discovery) &&
      isDeepStrictEqual(usage, current.usage)
    )
      return;
    current = {
      epoch: current.epoch,
      sequence: current.sequence + 1,
      entries: structuredClone(entries),
      terminals: structuredClone(terminals),
      discovery: { ...health },
      ...(usage ? { usage } : {}),
    };
    for (const listener of listeners) listener(structuredClone(current));
  };
  let health: CatalogSnapshot['discovery'] = { state: 'healthy' };
  // A session's own event publishes at once; a scan's row pass passes a no-op and publishes once after the pass.
  const updateActivity = (record: SessionRecord, publishChange: () => void = publish) => {
    const row = rows.get(nativeKey(record.target));
    if (!row || closed || candidates.get(row.key)?.support === 'unsupported') return;
    const live = sessions.snapshot(record.id).snapshot; // `current` is the published catalog snapshot
    const state = live.codingState;
    const latest = latestResponseSequence(live.codingMessages);
    if (latest === undefined) delete row.latestResponseSequence;
    else row.latestResponseSequence = latest;
    // A session never seen before starts seen at whatever history was present when Gloss first connected it (0 when none), so only responses arriving after that count.
    if (options.seen && state !== 'disconnected' && seenOf(record.id) === undefined)
      writeSeen(record.id, latest ?? 0);
    // A manually connected Claude row has no discovery result; its connection is the liveness signal.
    if (record.target.agent === 'claude' && !candidates.has(row.key))
      row.open = state !== 'disconnected';
    if (metadata.get(record.target.projectId)?.value.available === false) {
      row.activity = 'disconnected';
      row.availability = 'unavailable';
      row.reason = 'Project directory is unavailable';
      publishChange();
      return;
    }
    row.activity = record.target.agent === 'codex' && !row.open ? 'disconnected' : state;
    if (row.open && state === 'disconnected') {
      row.availability = 'unavailable';
      row.reason = 'Native session is disconnected';
    } else if (
      state !== 'disconnected' ||
      (record.target.agent === 'claude' &&
        metadata.get(record.target.projectId)?.value.available === true)
    ) {
      row.availability = 'available';
      delete row.reason;
    }
    publishChange();
  };
  const addRecord = (record: SessionRecord) => {
    const key = nativeKey(record.target);
    const prior = rows.get(key);
    rows.set(key, {
      key,
      target: record.target,
      projectKey: resolve(record.target.projectId),
      projectName: record.projectName,
      ...(record.sessionTitle ? { sessionTitle: record.sessionTitle } : {}),
      ...(record.branch ? { branch: record.branch } : {}),
      ...(record.worktreePath ? { worktreePath: record.worktreePath } : {}),
      open: false,
      activity: 'disconnected',
      availability: 'available',
      ...prior,
      ...(candidates.get(key)?.support === 'unsupported' ? {} : { sessionId: record.id }),
    });
    if (!subscriptions.has(record.id))
      subscriptions.set(
        record.id,
        sessions.subscribe(record.id, () => updateActivity(record)),
      );
    updateActivity(record);
    publish();
  };
  const refreshMetadata = async (row: CatalogEntry) => {
    let cached = metadata.get(row.target.projectId);
    if (!cached || clock.now() - cached.at >= 30000) {
      const path = row.target.projectId;
      let read = metadataReads.get(path);
      if (!read) {
        read = Promise.resolve()
          .then(() => metadataReader(path))
          .finally(() => {
            metadataReads.delete(path);
          });
        metadataReads.set(path, read);
      }
      const value = await read;
      if (closed) return;
      cached = { at: clock.now(), value };
      metadata.set(row.target.projectId, cached);
    }
    if (cached.value.available) {
      row.projectKey = cached.value.projectKey ?? cached.value.canonicalRoot;
      row.projectName = cached.value.projectName;
      delete row.branch;
      delete row.worktreePath;
      if (cached.value.branch) row.branch = cached.value.branch;
      if (cached.value.worktreePath) row.worktreePath = cached.value.worktreePath;
    } else {
      row.availability = 'unavailable';
      row.reason = 'Project directory is unavailable';
      row.activity = 'disconnected';
    }
  };
  // `records` is the session list read once for the whole pass; a session registered here is used directly.
  const processRow = async (row: CatalogEntry, records: readonly SessionRecord[]) => {
    try {
      await refreshMetadata(row);
      if (closed) return;
      const candidate = candidates.get(row.key);
      if (candidate?.support === 'unsupported') {
        delete row.sessionId;
        row.availability = 'unavailable';
        row.activity = candidate.activity ?? 'unknown';
        row.reason = candidate.reason ?? 'Unsupported session';
      } else if (
        row.target.agent === 'claude' &&
        row.sessionId &&
        !candidate &&
        sessions.hasWorkflow(row.sessionId)
      ) {
        // Metadata refresh can recover a quiet manual connection without any
        // workflow event. Reproject its snapshot; never reconnect it here. A saved
        // session without a workflow takes the saved-row branch below instead of
        // reloading its whole conversation every scan.
        const record = records.find((record) => record.id === row.sessionId);
        if (record) updateActivity(record, () => {});
      } else if (!row.open && metadata.get(row.target.projectId)?.value.available === true) {
        // Saved availability describes access to its project, not a departed native connection.
        row.availability = 'available';
        delete row.reason;
      } else if (row.open && metadata.get(row.target.projectId)?.value.available !== false) {
        const existing = records.find((record) => nativeKey(record.target) === row.key);
        if (!existing || sessions.snapshot(existing.id).snapshot.codingState === 'disconnected') {
          row.activity = 'connecting';
          publish();
        }
        const record =
          existing ?? (await sessions.register(row.target, undefined, controller.signal));
        if (closed) return;
        // Registration notification may replace the projected row; keep a single owned object.
        rows.set(row.key, row);
        row.sessionId = record.id;
        if (row.sessionTitle && row.sessionTitle !== record.sessionTitle)
          sessions.updateSessionTitle(record.id, row.sessionTitle);
        const connected =
          sessions.snapshot(record.id).snapshot.codingState === 'disconnected'
            ? await sessions.action(record.id, { type: 'connect', target: record.target })
            : sessions.snapshot(record.id);
        if (closed) return;
        row.activity = connected.snapshot.codingState;
        row.availability = row.activity === 'disconnected' ? 'unavailable' : 'available';
        if (row.availability === 'available') delete row.reason;
        else row.reason = 'Native session is disconnected';
      }
    } catch (error) {
      if (!closed) {
        row.availability = 'unavailable';
        row.activity = 'disconnected';
        row.reason = errorText(error);
      }
    }
  };
  const scan = async () => {
    const adapters = options.agents.filter((agent) => agent.discoverOpen);
    health = { state: 'healthy' };
    for (const adapter of adapters) {
      if (!adapter.discoverOpen) continue;
      try {
        const result = await adapter.discoverOpen(controller.signal);
        if (closed) return;
        if (!result.complete)
          health = { state: 'stale', error: result.error ?? 'Discovery is incomplete' };
        const found = new Map(
          result.candidates
            .filter((candidate) => candidate.target.agent === adapter.kind)
            .map((candidate) => [nativeKey(candidate.target), candidate]),
        );
        // A newly seen native session may be the one a waiting launch started; it retries once per discovery event, not per scan.
        const appeared = [...found.keys()].some((key) => !candidates.has(key));
        if (result.complete) {
          // Saved rows are re-checked on every complete discovery; one synchronous list read serves them all.
          let records: readonly SessionRecord[] | undefined;
          for (const [key, row] of rows)
            if (row.target.agent === adapter.kind && !found.has(key)) {
              row.open = false;
              row.activity = 'disconnected';
              candidates.delete(key);
              const saved = (records ??= sessions.list()).find(
                (record) => nativeKey(record.target) === key,
              );
              if (saved) row.sessionId = saved.id;
              else rows.delete(key);
            }
        }
        for (const [key, candidate] of found) {
          candidates.set(key, candidate);
          const row = rows.get(key) ?? {
            key,
            target: candidate.target,
            projectKey: resolve(candidate.target.projectId),
            projectName: candidate.target.projectId.split('/').pop() ?? candidate.target.projectId,
            open: true,
            activity: 'unknown',
            availability: 'unavailable',
          };
          row.open = true;
          if (candidate.sessionTitle) row.sessionTitle = candidate.sessionTitle;
          if (candidate.support === 'unsupported') {
            delete row.sessionId;
            row.activity = candidate.activity ?? 'unknown';
            row.availability = 'unavailable';
            row.reason = candidate.reason ?? 'Unsupported session';
          }
          rows.set(key, row);
        }
        if (appeared) {
          try {
            options.launcher?.noticeDiscovery?.(adapter.kind);
          } catch {
            /* Launch retries never break discovery. */
          }
        }
      } catch (error) {
        if (closed) return;
        health = { state: 'stale', error: errorText(error) };
      }
    }
    publish();
    const queue = [...rows.values()];
    const records = sessions.list();
    try {
      await Promise.all(
        Array.from({ length: Math.min(4, queue.length) }, async () => {
          while (!closed && queue.length) await processRow(queue.shift()!, records);
        }),
      );
    } finally {
      publish();
    }
  };
  const tick = () => {
    if (closed || pending) return;
    pending = scan()
      .catch((error) => {
        health = { state: 'stale', error: errorText(error) };
        publish();
      })
      .finally(() => {
        pending = undefined;
      });
  };
  return {
    start() {
      if (started || closed) return;
      started = true;
      unregister = sessions.subscribeRegistrations(addRecord);
      if (options.launcher) sourceSubscriptions.push(options.launcher.subscribe(() => publish()));
      if (options.attention) sourceSubscriptions.push(options.attention.subscribe(() => publish()));
      for (const record of sessions.list()) addRecord(record);
      tick();
      timer = clock.setInterval(tick, 2000);
      timer.unref?.();
    },
    snapshot: () => structuredClone(current),
    refresh() {
      codes.clear();
      publish();
    },
    forget(sessionId) {
      subscriptions.get(sessionId)?.();
      subscriptions.delete(sessionId);
      codes.delete(sessionId);
      seenCache.delete(sessionId);
      for (const [key, row] of rows)
        if (row.sessionId === sessionId) {
          rows.delete(key);
          candidates.delete(key);
        }
      publish();
    },
    entryFor(sessionId) {
      return current.entries.find((entry) => entry.sessionId === sessionId);
    },
    markSeen(sessionId, sequence) {
      if (!options.seen || !current.entries.some((entry) => entry.sessionId === sessionId))
        return 'unknown';
      const before = seenOf(sessionId);
      // A buggy client must not be able to suppress future badges by reporting a sequence beyond anything received.
      const entry = current.entries.find((e) => e.sessionId === sessionId);
      writeSeen(sessionId, Math.min(sequence, entry?.latestResponseSequence ?? 0));
      if (seenOf(sessionId) === before) return 'unchanged';
      publish();
      return 'updated';
    },
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      closed = true;
      controller.abort();
      if (timer) clock.clearInterval(timer);
      unregister?.();
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
      for (const unsubscribe of sourceSubscriptions.splice(0)) unsubscribe();
      listeners.clear();
      await pending;
    },
  };
}
