import { afterEach, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { createSessionCatalog } from '../../src/runtime/session-catalog.js';
import { createSessionManager } from '../../src/runtime/session-manager.js';
import { createWorkflow } from '../../src/core/workflow.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';
import type { OpenSessionScan } from '../../src/core/session-catalog.js';
import type { LaunchRecord } from '../../src/runtime/session-launcher.js';
import type { Attention } from '../../src/runtime/attention-monitor.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });
const candidate = (id: string) => ({ target: { agent: 'codex' as const, sessionRef: id, projectId: process.cwd() }, support: 'supported' as const });
const claudeCandidate = (id: string) => ({ target: { agent: 'claude' as const, sessionRef: id, projectId: process.cwd() }, support: 'supported' as const });
async function settle(check: () => boolean) { for (let i = 0; i < 2500 && !check(); i++) await delay(2); expect(check()).toBe(true); }
function setup(kind: 'codex' | 'claude' = 'codex', extra: Partial<Parameters<typeof createSessionCatalog>[0]> = {}) {
  // Advance catalog cadence without replaying the fake agent's zero-delay event polling.
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  const store = new SqliteStore(':memory:');
  let languageSettings = { write: 'he', send: 'en', reply: 'he', assist: 'he' };
  const agent = new FakeAgent(kind);
  let scan: OpenSessionScan = { candidates: [], complete: true };
  const discoverOpen = vi.fn(async (_signal: AbortSignal) => scan);
  const factory = vi.fn(async (record: ReturnType<typeof store.listSessions>[number]) => {
    const workflow = createWorkflow({ conversationId: record.id, language: 'he', languageModel: 'test', projectContext: () => '', languageSession: new FakeLanguageSession(), languageSettings: () => languageSettings, agents: [agent], store });
    await workflow.connect(record.target); return workflow;
  });
  const manager = createSessionManager({ store, agents: [agent], languageSettings: () => languageSettings, createWorkflowForSession: factory });
  const metadata = vi.fn(async () => ({ canonicalRoot: process.cwd(), projectName: 'Project', projectKey: '/common', branch: 'main', available: true }));
  const catalog = createSessionCatalog({ sessions: manager, agents: [Object.assign(agent, { discoverOpen })], readProjectMetadata: metadata, seen: store, ...extra });
  cleanups.push(async () => { await catalog.close(); await manager.close(); store.close(); });
  return { store, agent, manager, catalog, factory, discoverOpen, metadata, setScan(value: OpenSessionScan) { scan = value; }, setLanguage(value: typeof languageSettings) { languageSettings = value; } };
}
it('scans immediately and every two seconds, deduplicating workflows and unchanged events', async () => {
  const f = setup(); f.setScan({ candidates: [candidate('A'), candidate('A')], complete: true });
  f.catalog.start(); await settle(() => f.catalog.snapshot().entries[0]?.activity === 'idle');
  expect(f.store.listSessions()).toHaveLength(1); expect(f.factory).toHaveBeenCalledTimes(1);
  const initial = f.catalog.snapshot(); const events: unknown[] = []; f.catalog.subscribe(event => events.push(event));
  await vi.advanceTimersByTimeAsync(1999); expect(f.discoverOpen).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); await settle(() => f.discoverOpen.mock.calls.length === 2);
  expect(f.catalog.snapshot()).toEqual(initial); expect(events).toEqual([]);
});
it('retains discovered titles after metadata omission and native closure', async () => {
  const f = setup(); f.setScan({complete:true,candidates:[{...candidate('A'),sessionTitle:'Named'}]}); f.catalog.start();
  await settle(()=>f.catalog.snapshot().entries[0]?.activity === 'idle');
  expect(f.catalog.snapshot().entries[0]?.sessionTitle).toBe('Named');
  expect(f.store.listSessions()[0]?.sessionTitle).toBe('Named');
  f.setScan({complete:true,candidates:[candidate('A')]}); await vi.advanceTimersByTimeAsync(2000);
  expect(f.catalog.snapshot().entries[0]?.sessionTitle).toBe('Named');
  f.setScan({complete:true,candidates:[]}); await vi.advanceTimersByTimeAsync(2000);
  expect(f.catalog.snapshot().entries[0]).toMatchObject({open:false,sessionTitle:'Named'});
});
it('does not overlap slow scans and ignores late discovery after close', async () => {
  const f = setup(); let release!: (scan: OpenSessionScan) => void;
  f.discoverOpen.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  f.catalog.start(); await vi.advanceTimersByTimeAsync(6000);
  expect(f.discoverOpen).toHaveBeenCalledTimes(1);
  const closing = f.catalog.close(); release({ candidates: [candidate('late')], complete: true }); await closing;
  expect(f.store.listSessions()).toEqual([]); expect(f.discoverOpen.mock.calls[0]![0].aborted).toBe(true);
});
it('retains open membership on incomplete scans and moves verified absences to saved', async () => {
  const f = setup(); f.setScan({ candidates: [candidate('A')], complete: true }); f.catalog.start();
  await settle(() => f.catalog.snapshot().entries[0]?.activity === 'idle');
  const id = f.catalog.snapshot().entries[0]!.sessionId;
  f.setScan({ candidates: [], complete: false, error: 'Ownership unavailable' }); await vi.advanceTimersByTimeAsync(2000);
  expect(f.catalog.snapshot()).toMatchObject({ discovery: { state: 'stale', error: 'Ownership unavailable' }, entries: [{ open: true, sessionId: id }] });
  f.setScan({ candidates: [], complete: true }); await vi.advanceTimersByTimeAsync(2000);
  expect(f.catalog.snapshot()).toMatchObject({ discovery: { state: 'healthy' }, entries: [{ open: false, activity: 'disconnected', sessionId: id }] });
});
it('isolates failed connections and keeps unsupported candidates non-sendable', async () => {
  const f = setup(); f.factory.mockRejectedValueOnce(new Error('Native session exited'));
  f.setScan({ candidates: [candidate('A'), candidate('B'), { ...candidate('C'), support: 'unsupported', reason: 'Protocol unsupported' }], complete: true }); f.catalog.start();
  await settle(() => f.catalog.snapshot().entries.some(e => e.activity === 'idle'));
  await settle(() => f.catalog.snapshot().entries.some(e => e.reason === 'Native session exited'));
  expect(f.catalog.snapshot().entries.find(e => e.key === 'codex:C')).toMatchObject({ availability: 'unavailable', reason: 'Protocol unsupported' });
  expect(f.catalog.snapshot().entries.find(e => e.key === 'codex:C')?.sessionId).toBeUndefined();
  expect(f.store.listSessions()).toHaveLength(2);
});
it('reflects manual saved Claude registration and hidden session activity without changing workspaces', async () => {
  const f = setup(); f.catalog.start();
  const claude = await f.manager.register({ agent: 'claude', sessionRef: 'saved', projectId: process.cwd() });
  await settle(() => f.catalog.snapshot().entries.some(e => e.sessionId === claude.id));
  expect(f.catalog.snapshot().entries.find(e => e.sessionId === claude.id)).toMatchObject({ open: false, activity: 'disconnected' });
  const workspace = f.store.readWorkspace(claude.id);
  f.setScan({ candidates: [candidate('A')], complete: true }); await vi.advanceTimersByTimeAsync(2000);
  await settle(() => f.catalog.snapshot().entries.some(e => e.activity === 'idle'));
  const a = f.store.listSessions().find(r => r.target.sessionRef === 'A')!;
  f.agent.emit({ type: 'status', state: 'working' });
  await settle(() => f.catalog.snapshot().entries.find(e => e.sessionId === a.id)?.activity === 'working');
  expect(f.store.readWorkspace(claude.id)).toEqual(workspace);
  expect(f.catalog.snapshot().entries.map(e => e.key)).toEqual(['codex:A', 'claude:saved']);
  expect(f.catalog.snapshot().entries.find(e => e.sessionId === a.id)?.activity).toBe(f.manager.snapshot(a.id).snapshot.codingState);
});
it('auto-discovers and attaches an open Claude session through its adapter', async () => {
  const f = setup('claude'); f.setScan({ candidates: [claudeCandidate('native-claude')], complete: true }); f.catalog.start();
  await settle(() => f.catalog.snapshot().entries.some(e => e.key === 'claude:native-claude' && e.activity === 'idle'));
  expect(f.catalog.snapshot().entries.find(e => e.key === 'claude:native-claude')).toMatchObject({ open: true, availability: 'available', sessionId: expect.any(String) });
  expect(f.store.listSessions().map(s => s.target)).toEqual([{ agent: 'claude', sessionRef: 'native-claude', projectId: process.cwd() }]);
});
it('refreshes branch metadata after thirty seconds and retains grouping when folders disappear', async () => {
  const f = setup(); f.setScan({ candidates: [candidate('A')], complete: true }); f.catalog.start();
  await settle(() => f.catalog.snapshot().entries[0]?.activity === 'idle');
  f.metadata.mockResolvedValue({ canonicalRoot: process.cwd(), projectName: 'Project', projectKey: '/common', branch: 'feature', available: true });
  await vi.advanceTimersByTimeAsync(30000); await settle(() => f.catalog.snapshot().entries[0]?.branch === 'feature');
  f.metadata.mockResolvedValue({ canonicalRoot: '', projectName: 'Missing', projectKey: '/fallback', branch: '', available: false });
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.catalog.snapshot().entries[0]).toMatchObject({ projectKey: '/common', projectName: 'Project', branch: 'feature', availability: 'unavailable' });
  f.agent.emit({ type: 'status', state: 'working' });
  await settle(() => f.manager.snapshot(f.store.listSessions()[0]!.id).snapshot.codingState === 'working');
  expect(f.catalog.snapshot().entries[0]?.activity).toBe('disconnected');
});
it('flags rows whose folder is missing and clears the flag when it returns', async () => {
  const f = setup(); f.setScan({ candidates: [candidate('A')], complete: true }); f.catalog.start();
  await settle(() => f.catalog.snapshot().entries[0]?.activity === 'idle');
  expect(f.catalog.snapshot().entries[0]?.folderMissing).toBeUndefined();
  f.metadata.mockResolvedValue({ canonicalRoot: '', projectName: 'Missing', projectKey: '/fallback', branch: '', available: false });
  await vi.advanceTimersByTimeAsync(30000); await settle(() => f.catalog.snapshot().entries[0]?.folderMissing === true);
  const reads = f.metadata.mock.calls.length; await vi.advanceTimersByTimeAsync(10000);
  expect(f.metadata.mock.calls.length - reads).toBeLessThanOrEqual(1);
  f.metadata.mockResolvedValue({ canonicalRoot: process.cwd(), projectName: 'Project', projectKey: '/common', branch: 'main', available: true });
  await vi.advanceTimersByTimeAsync(30000); await settle(() => f.catalog.snapshot().entries[0]?.folderMissing === undefined);
});
it('limits simultaneous connections to four and eventually connects queued sessions', async () => {
  const f = setup(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  for (const id of ['A', 'B', 'C', 'D', 'E']) f.agent.attachGates.set(id, gate);
  f.setScan({ candidates: ['A', 'B', 'C', 'D', 'E'].map(candidate), complete: true }); f.catalog.start();
  await settle(() => f.factory.mock.calls.length === 4);
  await vi.advanceTimersByTimeAsync(4000); expect(f.factory).toHaveBeenCalledTimes(4);
  const metadataReads = f.metadata.mock.calls.length;
  release(); await settle(() => f.factory.mock.calls.length === 5);
  expect(metadataReads).toBe(1);
  await settle(() => f.catalog.snapshot().entries.every(e => e.sessionId !== undefined && e.activity !== 'connecting'));
  expect(f.store.listSessions()).toHaveLength(5);
});
it('does not register when shutdown interrupts metadata work', async () => {
  const f = setup(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const read = f.metadata.getMockImplementation()!;
  f.metadata.mockImplementation(async () => { await gate; return read(); });
  f.setScan({ candidates: [candidate('A')], complete: true }); f.catalog.start();
  await settle(() => f.metadata.mock.calls.length > 0);
  const closing = f.catalog.close(); release(); await closing;
  expect(f.store.listSessions()).toEqual([]);
});
it('preserves saved identity when a formerly supported session becomes unsupported and closes', async () => {
  const f = setup(); f.setScan({ candidates: [candidate('A')], complete: true }); f.catalog.start();
  await settle(() => f.catalog.snapshot().entries[0]?.activity === 'idle');
  const id = f.catalog.snapshot().entries[0]!.sessionId;
  f.setScan({ candidates: [{ ...candidate('A'), support: 'unsupported', reason: 'Protocol changed' }], complete: true });
  await vi.advanceTimersByTimeAsync(2000); expect(f.catalog.snapshot().entries[0]?.sessionId).toBeUndefined();
  f.setScan({ candidates: [], complete: true }); await vi.advanceTimersByTimeAsync(2000);
  expect(f.catalog.snapshot().entries[0]).toMatchObject({ sessionId: id, open: false, activity: 'disconnected', availability: 'available' });
  expect(f.catalog.snapshot().entries[0]?.reason).toBeUndefined();
});
it('keeps errors honest when discovery throws and uses a fresh epoch on restart', async () => {
  const f = setup(); f.setScan({ candidates: [candidate('A')], complete: true }); f.catalog.start();
  await settle(() => f.catalog.snapshot().entries[0]?.activity === 'idle');
  const epoch = f.catalog.snapshot().epoch;
  f.discoverOpen.mockRejectedValueOnce(new Error('Enumeration failed')); await vi.advanceTimersByTimeAsync(2000);
  expect(f.catalog.snapshot()).toMatchObject({ epoch, discovery: { state: 'stale', error: 'Enumeration failed' }, entries: [{ open: true }] });
  const restarted = createSessionCatalog({ sessions: f.manager, agents: [] });
  expect(restarted.snapshot().epoch).not.toBe(epoch); await restarted.close();
});
it('reconnects a reopened native identity without creating another workflow', async () => {
  const f = setup(); f.setScan({ candidates: [candidate('A')], complete: true }); f.catalog.start();
  await settle(() => f.catalog.snapshot().entries[0]?.activity === 'idle');
  const original = f.catalog.snapshot().entries[0]!;
  f.agent.emit({ type: 'status', state: 'disconnected' }); await settle(() => f.catalog.snapshot().entries[0]?.activity === 'disconnected');
  f.setScan({ candidates: [], complete: true }); await vi.advanceTimersByTimeAsync(2000);
  f.setScan({ candidates: [candidate('A')], complete: true }); await vi.advanceTimersByTimeAsync(2000);
  await settle(() => f.catalog.snapshot().entries[0]?.activity === 'idle');
  expect(f.catalog.snapshot().entries[0]).toMatchObject({ sessionId: original.sessionId, open: true, availability: 'available' });
  expect(f.factory).toHaveBeenCalledTimes(1);
});
it('removes the delivery destination immediately when discovery reports unsupported', async () => {
  const f = setup(); f.setScan({ candidates: [candidate('A')], complete: true }); f.catalog.start();
  await settle(() => f.catalog.snapshot().entries[0]?.activity === 'idle');
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const read = f.metadata.getMockImplementation()!;
  f.metadata.mockImplementation(async () => { await gate; return read(); });
  await vi.advanceTimersByTimeAsync(28000);
  f.setScan({ candidates: [{ ...candidate('A'), support: 'unsupported', reason: 'Unsupported' }], complete: true });
  await vi.advanceTimersByTimeAsync(2000);
  const row = f.catalog.snapshot().entries[0]; release();
  expect(row).toMatchObject({ activity: 'unknown', availability: 'unavailable' });
  expect(row?.sessionId).toBeUndefined();
});
it('starts application discovery only after restore and aborts it on application close', async () => {
  const { createApplication } = await import('../../src/runtime/application.js');
  const store = new SqliteStore(':memory:'); let signal: AbortSignal | undefined;
  const agent = Object.assign(new FakeAgent(), { discoverOpen: async (value: AbortSignal) => {
    signal = value;
    return new Promise<OpenSessionScan>(resolve => value.addEventListener('abort', () => resolve({ candidates: [candidate('late')], complete: true }), { once: true }));
  } });
  const open = vi.fn();
  const app = createApplication({ store, agents: [agent], languageBackends: { codex: { open, models: async () => [] } } });
  expect(signal).toBeUndefined(); await app.restore!(); expect(signal?.aborted).toBe(false);
  await app.close(); expect(signal?.aborted).toBe(true); expect(open).not.toHaveBeenCalled();
  expect(app.catalog!.snapshot().entries).toEqual([]);
});
it.each([
  { agent: 'claude' as const, failure: 'missing-directory' },
  { agent: 'codex' as const, failure: 'missing-directory' },
  { agent: 'claude' as const, failure: 'metadata-error' },
  { agent: 'codex' as const, failure: 'metadata-error' },
])('recovers saved $agent availability after $failure without workflow events', async ({ agent, failure }) => {
  const f = setup();
  const saved = await f.manager.register({ agent, sessionRef: 'saved', projectId: process.cwd() });
  if (failure === 'missing-directory') {
    f.metadata.mockResolvedValue({ canonicalRoot: '', projectName: 'Missing', projectKey: '/fallback', branch: '', available: false });
  } else f.metadata.mockRejectedValue(new Error('Metadata read failed'));
  f.catalog.start();
  await settle(() => f.catalog.snapshot().entries[0]?.availability === 'unavailable');
  expect(f.catalog.snapshot().entries[0]).toMatchObject({ sessionId: saved.id, open: false, activity: 'disconnected', reason: failure === 'missing-directory' ? 'Project directory is unavailable' : 'Metadata read failed' });
  f.metadata.mockResolvedValue({ canonicalRoot: process.cwd(), projectName: 'Recovered', projectKey: '/common', branch: 'recovered', available: true });
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.catalog.snapshot().entries[0]).toMatchObject({ sessionId: saved.id, open: false, activity: 'disconnected', availability: 'available', projectName: 'Recovered', branch: 'recovered' });
  expect(f.catalog.snapshot().entries[0]?.reason).toBeUndefined();
  expect(f.factory).not.toHaveBeenCalled();
});

it.each([false, true])('refreshes connected Claude metadata without reconnecting when disconnected during outage is %s', async disconnectDuringOutage => {
  const f = setup('claude');
  const record = await f.manager.register({ agent: 'claude', sessionRef: 'manual', projectId: process.cwd() });
  const attach = vi.spyOn(f.agent, 'attach');
  f.catalog.start();
  await f.manager.action(record.id, { type: 'connect', target: record.target });
  await settle(() => f.catalog.snapshot().entries[0]?.activity === 'idle');
  expect(f.catalog.snapshot().entries[0]).toMatchObject({ open: true, availability: 'available' });
  f.metadata.mockResolvedValue({ canonicalRoot: '', projectName: 'Missing', projectKey: '/fallback', branch: '', available: false });
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.catalog.snapshot().entries[0]).toMatchObject({ open: true, activity: 'disconnected', availability: 'unavailable' });
  if (disconnectDuringOutage) {
    f.agent.emit({ type: 'status', state: 'disconnected' });
    await settle(() => f.manager.snapshot(record.id).snapshot.codingState === 'disconnected');
    expect(f.catalog.snapshot().entries[0]).toMatchObject({ open: false, activity: 'disconnected', availability: 'unavailable' });
  }
  const workflowEvents = vi.fn(); const unsubscribe = f.manager.subscribe(record.id, workflowEvents);
  f.metadata.mockResolvedValue({ canonicalRoot: process.cwd(), projectName: 'Recovered', projectKey: '/common', branch: 'recovered', available: true });
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.catalog.snapshot().entries[0]).toMatchObject({
    sessionId: record.id, open: !disconnectDuringOutage,
    activity: disconnectDuringOutage ? 'disconnected' : 'idle', availability: 'available', projectName: 'Recovered', branch: 'recovered',
  });
  expect(f.catalog.snapshot().entries[0]?.reason).toBeUndefined();
  expect(workflowEvents).not.toHaveBeenCalled(); unsubscribe();
  expect(attach).toHaveBeenCalledTimes(1);
  expect(f.factory).toHaveBeenCalledTimes(1);
  expect(f.discoverOpen).toHaveBeenCalled();
  expect(f.agent.sent).toEqual([]);
});
it('connects a saved Claude session when discovery finds it running', async () => {
  const f = setup('claude');
  const saved = await f.manager.register({ agent: 'claude', sessionRef: 'saved-claude', projectId: process.cwd() });
  f.setScan({ candidates: [claudeCandidate('saved-claude')], complete: true }); f.catalog.start();
  await settle(() => f.catalog.snapshot().entries.some(e => e.key === 'claude:saved-claude' && e.activity === 'idle'));
  expect(f.catalog.snapshot().entries.find(e => e.key === 'claude:saved-claude')).toMatchObject({ sessionId: saved.id, open: true, availability: 'available' });
  expect(f.agent.sent).toEqual([]);
});
it('shows live activity for a running Claude session that cannot be a destination', async () => {
  const f = setup('claude');
  f.setScan({ candidates: [{ ...claudeCandidate('older-claude'), support: 'unsupported', reason: 'Claude 2.1.226 is not a verified version for sending', activity: 'working' }], complete: true });
  f.catalog.start();
  await settle(() => f.catalog.snapshot().entries.some(e => e.key === 'claude:older-claude' && e.activity === 'working'));
  expect(f.catalog.snapshot().entries.find(e => e.key === 'claude:older-claude')).toMatchObject({ open: true, availability: 'unavailable', reason: 'Claude 2.1.226 is not a verified version for sending' });
  expect(f.store.listSessions()).toEqual([]);
  f.setScan({ candidates: [{ ...claudeCandidate('older-claude'), support: 'unsupported', reason: 'Claude 2.1.226 is not a verified version for sending', activity: 'idle' }], complete: true });
  await vi.advanceTimersByTimeAsync(2000);
  await settle(() => f.catalog.snapshot().entries.find(e => e.key === 'claude:older-claude')?.activity === 'idle');
});
it('publishes each row\'s language code and updates it after a settings change and refresh', async () => {
  const f = setup(); f.setScan({ candidates: [candidate('A')], complete: true }); f.catalog.start();
  await settle(() => f.catalog.snapshot().entries[0]?.activity === 'idle');
  expect(f.catalog.snapshot().entries[0]?.languageCode).toBe('HE→EN→HE');
  f.setLanguage({ write: 'en', send: 'en', reply: 'en', assist: 'en' }); f.manager.refreshLanguageSettings(); f.catalog.refresh();
  expect(f.catalog.snapshot().entries[0]?.languageCode).toBe('EN→EN→EN');
});
it('marks launched rows that need the user and shows starting launches as placeholder rows', async () => {
  let launches: LaunchRecord[] = []; let attention = new Map<string, Attention>();
  const launchListeners = new Set<(r: LaunchRecord[]) => void>(); const attentionListeners = new Set<(m: Map<string, Attention>) => void>();
  const launcher = { list: () => launches, subscribe: (l: (r: LaunchRecord[]) => void) => { launchListeners.add(l); return () => { launchListeners.delete(l); }; } };
  const monitor = { current: () => new Map(attention), subscribe: (l: (m: Map<string, Attention>) => void) => { attentionListeners.add(l); return () => { attentionListeners.delete(l); }; } };
  const f = setup('codex', { launcher, attention: monitor }); f.setScan({ candidates: [candidate('A')], complete: true }); f.catalog.start();
  await settle(() => f.catalog.snapshot().entries[0]?.activity === 'idle');
  const sessionId = f.catalog.snapshot().entries[0]!.sessionId!;
  launches = [{ id: 'L1', agent: 'codex', folder: process.cwd(), panePid: 2, panelSessionId: sessionId, sessionRef: 'A', state: 'running', createdAt: 0 },
    { id: 'L2', agent: 'codex', folder: process.cwd(), panePid: 3, state: 'starting', createdAt: 0 }];
  for (const l of launchListeners) l(launches);
  attention = new Map([['L1', { launchId: 'L1', state: 'needs-user' }]]); for (const l of attentionListeners) l(attention);
  await settle(() => f.catalog.snapshot().entries.find(e => e.sessionId === sessionId)?.activity === 'approval-required');
  expect(f.catalog.snapshot().entries.find(e => e.sessionId === sessionId)).toMatchObject({ launchId: 'L1', launchState: 'running' });
  expect(f.catalog.snapshot().entries.find(e => e.key === 'launch:L2')).toEqual({ key: 'launch:L2', target: { agent: 'codex', sessionRef: 'launch:L2', projectId: process.cwd() },
    projectKey: '/common', projectName: 'Project', worktreePath: process.cwd(), open: true, activity: 'connecting', availability: 'unavailable', launchId: 'L2', launchState: 'starting', reason: 'Starting…' });
  attention = new Map([['L1', { launchId: 'L1', state: 'unknown-version', reason: 'x' }]]); for (const l of attentionListeners) l(attention);
  await settle(() => f.catalog.snapshot().entries.find(e => e.sessionId === sessionId)?.activity === 'idle');
  expect(f.catalog.snapshot().entries.find(e => e.sessionId === sessionId)?.attentionNotice).toBe('Approval detection unavailable for this Codex version');
  launches = [launches[0]!, { ...launches[1]!, state: 'ended' }]; for (const l of launchListeners) l(launches);
  await settle(() => !f.catalog.snapshot().entries.some(e => e.key === 'launch:L2'));
});
for (const support of ['supported', 'unsupported'] as const) it(`merges a discovered ${support} candidate with its starting launch into one row`, async () => {
  const launches: LaunchRecord[] = [{ id: 'L1', agent: 'claude', folder: process.cwd(), panePid: 2, sessionRef: 'native', state: 'starting', createdAt: 0 }];
  const launcher = { list: () => launches, subscribe: () => () => {} };
  const monitor = { current: () => new Map<string, Attention>([['L1', { launchId: 'L1', state: 'needs-user' }]]), subscribe: () => () => {} };
  const f = setup('claude', { launcher, attention: monitor });
  f.setScan({ candidates: [{ ...claudeCandidate('native'), support, ...(support === 'unsupported' ? { reason: 'Waiting for consent' } : {}) }], complete: true }); f.catalog.start();
  await settle(() => f.catalog.snapshot().entries.some(e => e.key === 'claude:native' && (support === 'unsupported' || !!e.sessionId)));
  const entries = f.catalog.snapshot().entries;
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ key: 'claude:native', launchId: 'L1', launchState: 'starting', activity: 'approval-required' });
});
it('forgets a removed closed session without re-listing it, and rediscovers it only once native shows it open again', async () => {
  const f = setup(); f.setScan({ candidates: [candidate('A')], complete: true }); f.catalog.start();
  await settle(() => f.catalog.snapshot().entries[0]?.activity === 'idle');
  f.setScan({ candidates: [], complete: true }); await vi.advanceTimersByTimeAsync(2000);
  await settle(() => f.catalog.snapshot().entries[0]?.open === false);
  const id = f.catalog.snapshot().entries[0]!.sessionId!;
  expect(f.catalog.entryFor(id)?.open).toBe(false);
  await f.manager.remove(id, { catalogClosed: true }); f.catalog.forget(id);
  expect(f.catalog.snapshot().entries).toEqual([]);
  await vi.advanceTimersByTimeAsync(2000); expect(f.catalog.snapshot().entries).toEqual([]);
  f.setScan({ candidates: [candidate('A')], complete: true }); await vi.advanceTimersByTimeAsync(2000);
  await settle(() => f.catalog.snapshot().entries[0]?.open === true);
});
it('merges a Codex launch placeholder with its discovered row once the launch is identified', async () => {
  let launches: LaunchRecord[] = [{ id: 'L1', agent: 'codex', folder: process.cwd(), panePid: 2, state: 'unidentified', reason: 'Started, not connected', createdAt: 0 }];
  const listeners = new Set<(r: LaunchRecord[]) => void>(); const noticeDiscovery = vi.fn();
  const launcher = { list: () => launches, noticeDiscovery, subscribe: (l: (r: LaunchRecord[]) => void) => { listeners.add(l); return () => { listeners.delete(l); }; } };
  const f = setup('codex', { launcher }); f.setScan({ candidates: [candidate('A')], complete: true }); f.catalog.start();
  await settle(() => !!f.catalog.snapshot().entries.find(e => e.key === 'codex:A')?.sessionId);
  // Before identification: the placeholder and the discovered conversation are separate tabs.
  expect(f.catalog.snapshot().entries.map(e => e.key).sort()).toEqual(['codex:A', 'launch:L1']);
  // A newly seen session asks waiting launches to retry once; an unchanged scan does not.
  expect(noticeDiscovery).toHaveBeenCalledTimes(1); expect(noticeDiscovery).toHaveBeenCalledWith('codex');
  vi.advanceTimersByTime(2000); await settle(() => f.discoverOpen.mock.calls.length >= 2); await delay(5);
  expect(noticeDiscovery).toHaveBeenCalledTimes(1);
  const sessionId = f.catalog.snapshot().entries.find(e => e.key === 'codex:A')!.sessionId!;
  launches = [{ ...launches[0]!, state: 'running', sessionRef: 'A', panelSessionId: sessionId }]; delete launches[0]!.reason;
  for (const l of listeners) l(launches);
  await settle(() => f.catalog.snapshot().entries.length === 1);
  expect(f.catalog.snapshot().entries[0]).toMatchObject({ key: 'codex:A', sessionId, launchId: 'L1', launchState: 'running' });
});
// Updates to one message carry a higher revision (the workflow ignores equal or lower revisions).
const reply = (sourceId: string, revision: number, complete = true) => ({ type: 'message' as const, message: { sourceId, revision, role: 'assistant' as const, text: 'Done ' + revision, complete } });
it('baselines a never-seen session at connect, flags newer completed responses, and markSeen clears them', async () => {
  const f = setup(); f.agent.historyMessages.set('A', [{ sourceId: 'h1', revision: 1, role: 'assistant', text: 'old', complete: true }]);
  f.setScan({ candidates: [candidate('A')], complete: true }); f.catalog.start();
  await settle(() => f.catalog.snapshot().entries[0]?.activity === 'idle');
  const id = f.catalog.snapshot().entries[0]!.sessionId!;
  // History present at connect is baselined, never flagged.
  expect(f.catalog.snapshot().entries[0]).toMatchObject({ latestResponseSequence: 1 }); expect(f.catalog.snapshot().entries[0]!.attention).toBeUndefined();
  expect(f.store.seenSequence(id)).toBe(1);
  f.agent.emit(reply('m2', 2, false)); await settle(() => f.catalog.snapshot().entries[0]?.latestResponseSequence === 1 && f.catalog.snapshot().entries[0]?.attention === undefined);
  f.agent.emit(reply('m2', 3, true)); await settle(() => f.catalog.snapshot().entries[0]?.attention === 'response');
  expect(f.catalog.snapshot().entries[0]!.latestResponseSequence).toBe(3);
  const before = f.catalog.snapshot().sequence;
  expect(f.catalog.markSeen(id, 1)).toBe('unchanged');
  expect(f.catalog.snapshot().sequence).toBe(before);
  expect(f.catalog.markSeen(id, 3)).toBe('updated');
  expect(f.catalog.snapshot().entries[0]!.attention).toBeUndefined();
  expect(f.catalog.markSeen('nope', 3)).toBe('unknown');
});
it('approval wins over an unseen response and an unavailable folder shows no response badge', async () => {
  const attention = new Map<string, Attention>();
  const subscribers = new Set<(current: Map<string, Attention>) => void>();
  const f = setup('codex', { launcher: { list: () => [{ id: 'L1', agent: 'codex', folder: process.cwd(), panePid: 1, state: 'running', createdAt: 0, sessionRef: 'A' } as LaunchRecord], subscribe: () => () => {} }, attention: { current: () => attention, subscribe: l => { subscribers.add(l); return () => { subscribers.delete(l); }; } } });
  f.setScan({ candidates: [candidate('A')], complete: true }); f.catalog.start();
  await settle(() => f.catalog.snapshot().entries[0]?.activity === 'idle');
  f.agent.emit(reply('m2', 2)); await settle(() => f.catalog.snapshot().entries[0]?.attention === 'response');
  attention.set('L1', { launchId: 'L1', state: 'needs-user' }); for (const l of subscribers) l(attention);
  expect(f.catalog.snapshot().entries[0]).toMatchObject({ activity: 'approval-required', attention: 'approval' });
  attention.set('L1', { launchId: 'L1', state: 'clear' }); for (const l of subscribers) l(attention);
  expect(f.catalog.snapshot().entries[0]!.attention).toBe('response');
  f.metadata.mockResolvedValue({ canonicalRoot: process.cwd(), projectName: 'Project', projectKey: '/common', branch: 'main', available: false });
  await vi.advanceTimersByTimeAsync(30000); await settle(() => f.catalog.snapshot().entries[0]?.availability === 'unavailable');
  expect(f.catalog.snapshot().entries[0]!.attention).toBeUndefined();
});
