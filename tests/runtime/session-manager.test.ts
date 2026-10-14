import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionManager } from '../../src/runtime/session-manager.js';
import { createWorkflow } from '../../src/core/workflow.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';
import type { SessionRecord } from '../../src/core/session-contracts.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function setup(failA = false) {
  const store = new SqliteStore(':memory:');
  const agents = { A: new FakeAgent(), B: new FakeAgent('claude') };
  const languages = { A: new FakeLanguageSession(), B: new FakeLanguageSession() };
  languages.A.translationReply = 'Change A';
  languages.B.translationReply = 'Change B';
  for (const id of ['A', 'B'] as const) store.registerSession({ id, target: { agent: agents[id].kind, sessionRef: id, projectId: process.cwd() }, canonicalRoot: process.cwd(), projectName: id, enabled: true });
  const factory = vi.fn(async (record: SessionRecord) => {
    if (record.id === 'A' && failA) throw new Error('Initialization failed');
    const id = record.id as 'A' | 'B';
    const workflow = createWorkflow({ conversationId: id, language: 'he', languageModel: 'test', projectContext: () => '', languageSession: languages[id], agents: [agents[id]], store });
    await workflow.connect(record.target);
    return workflow;
  });
  const manager = createSessionManager({ store, agents: Object.values(agents), createWorkflowForSession: factory });
  cleanup.push(async () => { await manager.close(); store.close(); });
  return { store, agents, languages, factory, manager };
}
describe('independent session workflows', () => {
  it('deduplicates concurrent initialization', async () => {
    const { manager, factory } = setup();
    const [a, b] = await Promise.all([manager.ensure('A'), manager.ensure('A')]);
    expect(a).toBe(b); expect(factory).toHaveBeenCalledTimes(1);
  });
  it('isolates actions, agents and monotonic event sequences', async () => {
    const { manager, languages, agents } = setup();
    await Promise.all([manager.ensure('A'), manager.ensure('B')]);
    const seen: number[] = []; manager.subscribe('A', event => seen.push(event.sequence));
    const beforeB = manager.snapshot('B');
    await manager.action('A', { type: 'discuss', text: 'Only A' });
    await manager.action('A', { type: 'send-composer', requestId: 'send-A', text: 'Change A' });
    expect(languages.A.inputs.length).toBeGreaterThan(0); expect(languages.B.inputs).toEqual([]);
    expect(agents.A.sent).toHaveLength(1); expect(agents.B.sent).toEqual([]);
    expect(manager.snapshot('B')).toEqual(beforeB);
    expect(seen.length).toBeGreaterThan(1); expect(seen.every((n, i) => i === 0 || n > seen[i - 1]!)).toBe(true);
  });
  it('restores B despite rejected A and permits a later initialization retry', async () => {
    const { manager, factory } = setup(true);
    await manager.restore();
    expect(factory.mock.calls.filter(([r]) => r.id === 'B')).toHaveLength(1);
    expect(manager.snapshot('B').snapshot.languageSessionId).toBe('language-session-1');
    expect(manager.snapshot('B').snapshot.codingState).toBe('idle');
    await expect(manager.ensure('A')).rejects.toThrow('Initialization failed');
    expect(factory.mock.calls.filter(([r]) => r.id === 'A')).toHaveLength(2);
  });
  it('keeps a delayed A response scoped while B is selected', async () => {
    const { manager, languages, store } = setup();
    await Promise.all([manager.ensure('A'), manager.ensure('B')]);
    let release!: () => void; languages.A.discussGate = new Promise<void>(resolve => { release = resolve; });
    let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    const discuss = languages.A.discuss.bind(languages.A);
    vi.spyOn(languages.A, 'discuss').mockImplementation(async function* (input, signal) {
      enter(); yield* discuss(input, signal);
    });
    const operation = manager.action('A', { type: 'discuss', text: 'Delayed A' });
    await entered;
    const b = manager.snapshot('B'); const workspace = store.readWorkspace('B');
    release(); const result = await operation;
    expect(result.sessionId).toBe('A'); expect(result.snapshot.discussion.length).toBeGreaterThan(0);
    expect(manager.snapshot('B')).toEqual(b); expect(store.readWorkspace('B')).toEqual(workspace);
  });
  it('ingests hidden A and rejects unknown identities', async () => {
    const { manager } = setup(); await manager.ensure('B');
    const event = await manager.ingest('codex', { sourceSessionId: 'A', sourceId: 'm', sequence: 1, role: 'user', text: 'Source A' });
    expect(event.sessionId).toBe('A'); expect(event.snapshot.codingMessages.map(m => m.text)).toContain('Source A');
    expect(manager.snapshot('B').snapshot.codingMessages).toEqual([]);
    await expect(manager.ingest('claude', { sourceSessionId: 'A', sourceId: 'm', sequence: 1, role: 'user', text: 'Wrong' })).rejects.toThrow();
  });
  it('reconnects a cached disconnected workflow without double-connecting initialization', async () => {
    const { manager, agents, factory } = setup();
    const originalAttach = agents.A.attach.bind(agents.A);
    let disconnect!: () => void; const disconnected = new Promise<void>(resolve => { disconnect = resolve; });
    const attach = vi.spyOn(agents.A, 'attach').mockImplementationOnce(async target => {
      const connection = await originalAttach(target);
      connection.events = async function* () { yield { type: 'status', state: 'idle' }; await disconnected; };
      return connection;
    });
    const target = manager.list().find(r => r.id === 'A')!.target;
    await Promise.all([manager.action('A', { type: 'connect', target }), manager.action('A', { type: 'connect', target })]);
    expect(attach).toHaveBeenCalledTimes(1);
    disconnect();
    await vi.waitFor(() => expect(manager.snapshot('A').snapshot.codingState).toBe('disconnected'));
    await Promise.all([manager.action('A', { type: 'connect', target }), manager.action('A', { type: 'connect', target })]);
    expect(attach).toHaveBeenCalledTimes(2); expect(factory).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(manager.snapshot('A').snapshot.codingState).toBe('idle'));
    await manager.action('A', { type: 'send-composer', requestId: 'after-reconnect', text: 'Change A' });
    expect(agents.A.sent).toHaveLength(1);
  });
  it('rejects a different project for an existing native identity without mutating it', async () => {
    const { manager } = setup(); const original = manager.list().find(r => r.id === 'A')!;
    const folder = await mkdtemp(join(tmpdir(), 'conflicting-project-'));
    try {
      await expect(manager.register({ ...original.target, projectId: folder })).rejects.toThrow('different project');
      expect(manager.list().find(r => r.id === 'A')).toEqual(original);
      const alias = join(folder, 'alias'); await symlink(process.cwd(), alias);
      expect(await manager.register({ ...original.target, projectId: alias })).toEqual(original);
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  it('rejects a conflicting project when another registration wins concurrently', async () => {
    const { manager } = setup();
    const root = await mkdtemp(join(tmpdir(), 'registration-race-'));
    try {
      const folders = [join(root, 'first'), join(root, 'second')];
      await Promise.all(folders.map(folder => mkdir(folder)));
      const results = await Promise.allSettled(folders.map(projectId => manager.register({ agent: 'codex', sessionRef: 'C', projectId })));
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
      const winner = results.find(result => result.status === 'fulfilled');
      expect(manager.list().filter(record => record.target.sessionRef === 'C')).toEqual([winner!.value]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('rejects retargeting an initialized workflow', async () => {
    const { manager } = setup(); await manager.ensure('A');
    await expect(manager.action('A', { type: 'connect', target: { agent: 'claude', sessionRef: 'B', projectId: process.cwd() } })).rejects.toThrow();
    expect(manager.snapshot('A').snapshot.target?.sessionRef).toBe('A');
  });
});

import { createApplication } from '../../src/runtime/application.js';
import { readProjectMetadata } from '../../src/runtime/project-metadata.js';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectProcess, runProcess } from '../../src/runtime/process-runner.js';

describe('application session restoration', () => {
  it('keeps a targetless launch disconnected without opening any backend', async () => {
    const store = new SqliteStore(':memory:'); const open = vi.fn();
    const app = createApplication({ store, agents: [], languageBackends: { codex: { open, models: async () => [] } } });
    await app.restore!();
    expect(app.snapshot().snapshot.target).toBeUndefined(); expect(app.sessions!.list()).toEqual([]);
    await expect(app.action({ type: 'discuss', text: 'Draft' })).rejects.toMatchObject({ code: 'session-required' });
    expect(open).not.toHaveBeenCalled(); await app.close();
  });
  it('imports saved IDs and opens each own backend, resume ID and model', async () => {
    const store = new SqliteStore(':memory:');
    for (const id of ['A', 'B']) store.save({ id, target: { agent: id === 'A' ? 'codex' : 'claude', sessionRef: id, projectId: process.cwd() }, codingState: 'idle', codingMessages: [], discussion: [{ role: 'user', text: `Saved ${id}` }], deliveries: [], language: 'he', languageSessionId: `resume-${id}`, languageModel: `model-${id}`, sourceRevision: 0 });
    const codex = vi.fn(async () => new FakeLanguageSession()); const claude = vi.fn(async () => new FakeLanguageSession());
    const app = createApplication({ store, agents: [new FakeAgent(), new FakeAgent('claude')], conversationId: 'A', model: 'override-A', languageBackends: { codex: { open: codex, models: async () => [] }, claude: { open: claude, models: async () => [] } } });
    await app.restore!();
    expect(app.sessions!.list().map(r => r.id).sort()).toEqual(['A', 'B']);
    expect(codex).toHaveBeenCalledWith('override-A', 'resume-A', { scope: 'A' }); expect(claude).toHaveBeenCalledWith('model-B', 'resume-B', { scope: 'B' });
    expect(app.snapshot().snapshot.discussion).toEqual([{ id:'A:legacy:0',complete:true,role: 'user', text: 'Saved A' }]);
    expect(app.sessions!.snapshot('B').snapshot.discussion).toEqual([{ id:'B:legacy:0',complete:true,role: 'user', text: 'Saved B' }]);
    await app.close();
  });
  it('leaves missing folders disconnected and retryable without opening a backend', async () => {
    const store = new SqliteStore(':memory:'); const open = vi.fn();
    const app = createApplication({ store, agents: [new FakeAgent()], languageBackends: { codex: { open, models: async () => [] } } });
    const record = await app.sessions!.register({ agent: 'codex', sessionRef: 'missing', projectId: '/nonexistent-language-panel-test-directory' });
    await app.restore!(); expect(record.canonicalRoot).toBe('');
    expect(app.sessions!.snapshot(record.id).snapshot.codingState).toBe('disconnected');
    await expect(app.sessions!.ensure(record.id)).rejects.toMatchObject({ code: 'project-unavailable' });
    expect(open).not.toHaveBeenCalled(); await app.close();
  });
});

describe('project metadata', () => {
  it('canonicalizes non-Git folders and identifies Git worktrees through shell-free commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-project-'));
    try {
      const folder = join(root, 'folder;literal'); await mkdir(folder);
      const link = join(root, 'alias'); await symlink(folder, link);
      const metadata = await readProjectMetadata(link);
      expect(metadata.projectName).toBe('folder;literal'); expect(metadata.canonicalRoot).toMatch(/folder;literal$/); expect(metadata.available).toBe(true);
      const git = async (...args: string[]) => { const result = await collectProcess(runProcess('git', args, '', new AbortController().signal, { cwd: folder })); expect(result.outcome.code).toBe(0); };
      await git('init', '-b', 'main'); await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'Initial');
      const worktree = join(root, 'worktree'); await git('worktree', 'add', '-b', 'feature', worktree);
      const worktreeMetadata = await readProjectMetadata(worktree);
      expect(worktreeMetadata.projectName).toBe('folder;literal'); expect(worktreeMetadata.branch).toBe('feature'); expect(worktreeMetadata.worktreePath).toMatch(/worktree$/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('session manager lifecycle', () => {
  it('closes a workflow that finishes opening after shutdown without closing the shared store', async () => {
    const store = new SqliteStore(':memory:');
    const record = store.registerSession({ id: 'A', target: { agent: 'codex', sessionRef: 'A', projectId: process.cwd() }, canonicalRoot: process.cwd(), projectName: 'A', enabled: true });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const language = new FakeLanguageSession(); const close = vi.spyOn(language, 'close');
    const manager = createSessionManager({ store, agents: [], createWorkflowForSession: async () => {
      await gate;
      return createWorkflow({ conversationId: record.id, language: 'he', languageModel: 'test', projectContext: () => '', languageSession: language, agents: [], store });
    } });
    const pending = manager.ensure('A');
    const failed = expect(pending).rejects.toMatchObject({ code: 'closed' });
    const closing = manager.close(); release(); await failed; await closing;
    expect(close).toHaveBeenCalledTimes(1); expect(store.listSessions()).toHaveLength(1); store.close();
  });
});

it('marks all snapshots and action events with a stable runtime epoch that changes after restart', async () => {
 const first=setup();const epoch=first.manager.snapshot('A').epoch;
 expect(epoch).toEqual(expect.any(String));
 expect(first.manager.snapshot('B').epoch).toBe(epoch);
 expect((await first.manager.action('A',{type:'discuss',text:'First process'})).epoch).toBe(epoch);
 const restarted=setup();expect(restarted.manager.snapshot('A').epoch).not.toBe(epoch);
 expect(restarted.manager.snapshot('A').sequence).toBe(0);
});

it('does not persist a registration canceled during asynchronous project resolution', async () => {
  const { manager } = setup(); const controller = new AbortController();
  const pending = manager.register({ agent: 'codex', sessionRef: 'canceled', projectId: process.cwd() }, undefined, controller.signal);
  controller.abort(); await expect(pending).rejects.toThrow();
  expect(manager.list().some(record => record.target.sessionRef === 'canceled')).toBe(false);
});
