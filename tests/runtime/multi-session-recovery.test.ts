import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApplication, type Application } from '../../src/runtime/application.js';
import { startServer } from '../../src/runtime/http-server.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { defaultWorkspace } from '../../src/core/session-contracts.js';
import { WorkspaceController } from '../../src/ui/use-workspace.js';
import { saveImage } from '../../src/runtime/attachments.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'multi-session-recovery-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const roots = { A: join(root, 'A'), B: join(root, 'B') };
  for (const folder of Object.values(roots)) {
    await mkdir(folder);
    await writeFile(join(folder, 'note.txt'), 'Local reference');
  }
  const db = join(root, 'state.db');
  const uploads = join(root, 'uploads');
  return { roots, db, uploads };
}
function launch(db: string, uploads: string, accepted = false) {
  const store = new SqliteStore(db);
  const agents = { A: new FakeAgent(), B: new FakeAgent('claude') };
  agents.A.capabilities.fileReferences = true;
  agents.A.result = { state: 'queued' };
  Object.assign(agents.A.result, { nativeMessageId: 'native-pending' });
  const reconcile = vi.fn(async () => accepted);
  const attach = agents.A.attach.bind(agents.A);
  vi.spyOn(agents.A, 'attach').mockImplementation(async (target) => ({
    ...(await attach(target)),
    reconcileDelivery: reconcile,
  }));
  const language = () => {
    const result = new FakeLanguageSession();
    result.translationReply = 'Translated source';
    return result;
  };
  const app = createApplication({
    store,
    attachmentRoot: uploads,
    agents: Object.values(agents),
    conversationId: 'A',
    capability: 'recovery-test',
    languageBackends: {
      codex: { open: async () => language(), models: async () => [] },
      claude: { open: async () => language(), models: async () => [] },
    },
  });
  cleanups.push(() => app.close());
  return { app, store, agents, reconcile };
}
async function replay(app: Application) {
  for (const id of ['A', 'B'] as const)
    for (const sequence of [1, 2])
      await app.ingestSourceMessage!({
        agent: id === 'A' ? 'codex' : 'claude',
        sourceSessionId: id,
        sourceId: `${id}-${sequence}`,
        sequence,
        role: sequence === 1 ? 'user' : 'assistant',
        text: `${id} source ${sequence}`,
        cursor: `${id}-cursor-${sequence}`,
      });
}

it('releases recovered channel attempts atomically before reopen, keeps newer drafts on late receipts and never replays history', async () => {
  const f = await fixture();
  const first = launch(f.db, f.uploads);
  await first.app.sessions!.register(
    { agent: 'claude', sessionRef: 'B', projectId: f.roots.B },
    'B',
  );
  first.agents.B.result = { state: 'unconfirmed' };
  Object.assign(first.agents.B.result, { channelGeneration: 'old-generation' });
  const file = await first.app.files!.reference('B', 'note.txt');
  await first.app.writeWorkspace!('B', 0, {
    ...defaultWorkspace(),
    composer: 'Keep text',
    attachmentIds: [file.id],
    composerAttempt: { requestId: 'old', text: 'Old', attachmentIds: [file.id] },
  });
  first.agents.B.capabilities.fileReferences = true;
  await first.app.sessions!.action('B', {
    type: 'send-composer',
    requestId: 'old',
    text: 'Old',
    attachmentIds: [file.id],
  });
  const old = first.store.load('B')!.deliveries[0]!;
  first.store.updateDelivery({ ...old, state: 'sending' });
  await first.app.close();
  const second = launch(f.db, f.uploads);
  await second.app.restore!();
  expect(second.store.load('B')?.deliveries[0]).toMatchObject({
    state: 'unconfirmed',
    transport: 'channel',
    channelGeneration: 'old-generation',
  });
  await second.app.sessions!.action('B', { type: 'check-composer', requestId: 'old' });
  expect(second.store.readWorkspace('B').revision).toBe(1);
  await second.app.sessions!.action('B', { type: 'release-composer', requestId: 'old' });
  await second.app.close();
  const third = launch(f.db, f.uploads);
  await third.app.restore!();
  expect(third.store.readWorkspace('B')).toMatchObject({
    revision: 2,
    data: { composer: 'Keep text', attachmentIds: [file.id], composerAttempt: null },
  });
  expect(third.store.load('B')?.composerDraft).toBeUndefined();
  await third.app.sessions!.action('B', {
    type: 'send-composer',
    requestId: 'old',
    text: 'Old',
    transport: 'peer',
  });
  expect(third.agents.B.sent).toEqual([]);
  third.agents.B.result = { state: 'unconfirmed' };
  // An explicit transport must be the route the session offers.
  third.agents.B.route = { transport: 'peer' };
  await third.app.sessions!.action('B', {
    type: 'send-composer',
    requestId: 'new',
    text: 'New',
    transport: 'peer',
  });
  third.agents.B.emit({ type: 'delivery', requestId: old.id, state: 'sent' });
  await expect.poll(() => third.store.load('B')?.deliveries[0]?.state).toBe('sent');
  expect(third.store.load('B')?.composerDraft?.id).toBe('composer-new');
  expect(third.agents.B.sent).toHaveLength(1);
});

it('keeps mixed Claude feed chronology in SQLite and across application reload', async () => {
  const f = await fixture();
  const first = launch(f.db, f.uploads);
  await first.app.sessions!.register(
    { agent: 'claude', sessionRef: 'B', projectId: f.roots.B },
    'B',
  );
  for (const [sourceId, sequence, timestamp] of [
    ['native', 9000, '2026-10-07T10:00:00Z'],
    ['channel:g:r', 1, '2026-10-07T10:01:00Z'],
  ] as const) {
    await first.app.ingestSourceMessage!({
      agent: 'claude',
      sourceSessionId: 'B',
      sourceId,
      sequence,
      timestamp,
      role: 'assistant',
      text: sourceId,
      complete: true,
    });
  }
  expect(first.store.load('B')?.codingMessages.map((m) => m.sourceId)).toEqual([
    'native',
    'channel:g:r',
  ]);
  await first.app.close();
  const second = launch(f.db, f.uploads);
  await second.app.restore!();
  expect(second.app.sessions!.snapshot('B').snapshot.codingMessages.map((m) => m.sourceId)).toEqual(
    ['native', 'channel:g:r'],
  );
  expect(second.agents.B.sent).toEqual([]);
});

it('reopens two sessions, replays sources twice and reconciles without resending or changing other workspaces', async () => {
  const f = await fixture();
  const first = launch(f.db, f.uploads);
  for (const id of ['A', 'B'] as const)
    await first.app.sessions!.register(
      { agent: first.agents[id].kind, sessionRef: id, projectId: f.roots[id] },
      id,
    );
  await first.app.restore!();
  const a = await first.app.files!.reference('A', 'note.txt');
  const removed = await first.app.files!.upload('A', { name: 'removed.txt', data: 'YQ==' });
  const b = await first.app.files!.reference('B', 'note.txt');
  expect([a.index, removed.index, b.index]).toEqual([1, 2, 1]);
  await first.app.writeWorkspace!('A', 0, {
    ...defaultWorkspace(),
    composer: 'Send A',
    attachmentIds: [a.id],
    composerAttempt: { requestId: 'pending-A', text: 'Send A', attachmentIds: [a.id] },
  });
  await first.app.writeWorkspace!('B', 0, {
    ...defaultWorkspace(),
    composer: 'Keep B',
    attachmentIds: [b.id],
    layout: { ...defaultWorkspace().layout, mode: 'rows' },
  });
  await first.app.writeWorkspace!('B', 1, {
    ...first.store.readWorkspace('B').data,
    composer: 'Keep B revision two',
  });
  await first.app.sessions!.action('A', {
    type: 'send-composer',
    requestId: 'pending-A',
    text: 'Send A',
    attachmentIds: [a.id],
  });
  expect(first.app.snapshot().snapshot.deliveries).toEqual([
    expect.objectContaining({
      state: 'queued',
      nativeMessageId: 'native-pending',
      referenceFormat: 'manifest-v1',
    }),
  ]);
  await replay(first.app);
  const workspaces = ['A', 'B'].map((id) => first.store.readWorkspace(id));
  expect(first.agents.A.sent).toHaveLength(1);
  await first.app.close();

  const second = launch(f.db, f.uploads, true);
  await second.app.restore!();
  await replay(second.app);
  await replay(second.app);
  for (const id of ['A', 'B']) {
    await vi.waitFor(() =>
      expect(
        second.app
          .sessions!.snapshot(id)
          .snapshot.codingMessages.map((m) => [m.role, m.translationStatus]),
      ).toEqual([
        ['user', undefined],
        ['assistant', 'complete'],
      ]),
    );
    const snapshot = second.app.sessions!.snapshot(id).snapshot;
    expect(snapshot.codingMessages.map((m) => m.sourceId)).toEqual([`${id}-1`, `${id}-2`]);
    expect(snapshot.codingMessages.map((m) => m.text)).toEqual([
      `${id} source 1`,
      `${id} source 2`,
    ]);
    expect(snapshot.sourceSequence).toBe(2);
  }
  expect(['A', 'B'].map((id) => second.store.readWorkspace(id))).toEqual(workspaces);
  expect(second.app.snapshot().snapshot.composerDraft).toBeUndefined();
  expect(second.app.snapshot().snapshot.deliveries).toEqual([
    expect.objectContaining({
      state: 'sent',
      nativeMessageId: 'native-pending',
      referenceFormat: 'manifest-v1',
    }),
  ]);
  await second.app.sessions!.action('A', { type: 'check-composer', requestId: 'pending-A' });
  await second.app.sessions!.action('A', {
    type: 'send-composer',
    requestId: 'pending-A',
    text: 'Send A',
    attachmentIds: [a.id],
  });
  expect(second.agents.A.sent).toEqual([]);
  expect(second.agents.B.sent).toEqual([]);
  expect(second.reconcile).toHaveBeenCalledWith(
    expect.objectContaining({ nativeMessageId: 'native-pending' }),
    [],
  );
  expect((await second.app.files!.upload('A', { name: 'next.txt', data: 'YQ==' })).index).toBe(3);
  expect((await second.app.files!.upload('B', { name: 'next.txt', data: 'YQ==' })).index).toBe(2);
  expect(await second.app.files!.resolve('A', [a.id])).toEqual([a]);
  await expect(second.app.files!.resolve('B', [a.id])).rejects.toThrow('belong');
});

it('migrates schema 13 prepared images and old receipts, importing legacy layout only into the launch session', async () => {
  const f = await fixture();
  const old = new SqliteStore(f.db);
  const target = { agent: 'codex' as const, sessionRef: 'original-native', projectId: f.roots.A };
  const image = {
    ...(await saveImage(
      {
        name: 'legacy.png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      },
      f.uploads,
    )),
    index: 7,
  };
  const draft = {
    id: 'original-draft',
    revision: 3,
    target,
    sourceRevision: 1,
    language: 'he',
    localizedText: 'Prepared Image 7',
    englishText: 'Inspect Image 7',
    attachments: [image],
    selectedDiscussion: [0],
  };
  const delivery = {
    id: 'legacy-receipt',
    draftId: draft.id,
    revision: 3,
    target,
    state: 'queued' as const,
    englishText: draft.englishText,
    attachments: [image],
    nativeMessageId: 'old-native-receipt',
  };
  old.save({
    id: 'A',
    target,
    codingState: 'idle',
    codingMessages: [
      {
        sourceId: 'original-message',
        revision: 1,
        role: 'user',
        text: 'Original content',
        complete: true,
      },
    ],
    discussion: [{ role: 'user', text: 'Original Image 7', attachments: [image] }],
    deliveries: [delivery],
    currentDraft: draft,
    language: 'he',
    languageSessionId: 'original-language',
    languageModel: 'test',
    sourceRevision: 1,
  });
  old.close();
  // Remove only post-13 schema additions from this disposable populated fixture.
  const raw = new DatabaseSync(f.db);
  raw.exec(
    'DROP TABLE response_summaries; ALTER TABLE discussion_turns DROP COLUMN turn_id; ALTER TABLE discussion_turns DROP COLUMN complete;',
  );
  raw.exec(
    'ALTER TABLE deliveries DROP COLUMN transport; ALTER TABLE deliveries DROP COLUMN channel_generation;',
  );
  raw.exec(
    'DROP TABLE session_launches; DROP TABLE session_file_counters; DROP TABLE session_files; DROP TABLE session_workspaces; DROP TABLE panel_sessions; DROP TABLE app_settings; DROP TABLE connected_folders; DROP TABLE session_seen; DROP TABLE language_spend; DROP TABLE file_reviews; ALTER TABLE deliveries DROP COLUMN reference_format; DELETE FROM schema_migrations WHERE version > 13',
  );
  expect(raw.prepare('SELECT max(version) AS version FROM schema_migrations').get()).toMatchObject({
    version: 13,
  });
  raw.close();
  const migrated = launch(f.db, f.uploads);
  await migrated.app.restore!();
  await migrated.app.sessions!.register(
    { agent: 'claude', sessionRef: 'B', projectId: f.roots.B },
    'B',
  );
  const restored = migrated.store.load('A')!;
  expect(restored.target).toEqual(target);
  expect(restored.codingMessages).toEqual([
    expect.objectContaining({ sourceId: 'original-message', text: 'Original content' }),
  ]);
  expect(restored.currentDraft).toMatchObject(draft);
  expect(restored.deliveries).toEqual([delivery]);
  expect(restored.deliveries[0]).not.toHaveProperty('referenceFormat');
  expect(await migrated.app.files!.resolve('A', [image.id])).toEqual([
    expect.objectContaining({ id: image.id, kind: 'image', index: 7 }),
  ]);
  const values = new Map([
    ['panel-layout', 'rows'],
    ['composer:A', JSON.stringify('Legacy composer')],
    ['composer-images:A', JSON.stringify([image])],
    ['answer-review:A', JSON.stringify({ draft, localizedText: 'Edited legacy review' })],
  ]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  for (const id of ['A', 'B']) {
    const controller = new WorkspaceController(
      id,
      {
        loadWorkspace: async () => migrated.app.readWorkspace!(id),
        saveWorkspace: async (revision, data) => migrated.app.writeWorkspace!(id, revision, data),
      },
      storage,
      'migration',
    );
    await controller.hydrate(migrated.app.sessions!.snapshot(id).snapshot, 'A');
    await controller.flush();
  }
  expect(migrated.store.readWorkspace('A').data).toMatchObject({
    composer: 'Legacy composer',
    attachmentIds: [image.id],
    layout: { mode: 'rows' },
    review: { draftId: draft.id, revision: 3, localizedText: 'Edited legacy review' },
  });
  expect(migrated.store.readWorkspace('B').data).toEqual(defaultWorkspace());
  expect(
    (
      await migrated.app.files!.upload('A', {
        name: 'new.png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      })
    ).index,
  ).toBe(8);
  const server = await startServer(migrated.app);
  cleanups.push(() => server.close());
  const response = await fetch(new URL('/api/snapshot', server.url), {
    headers: { authorization: 'Bearer recovery-test' },
  });
  expect(response.status).toBe(200);
  expect((await response.json()).snapshot.id).toBe('A');
  const inspection = new DatabaseSync(f.db);
  expect(
    inspection
      .prepare('PRAGMA table_info(panel_sessions)')
      .all()
      .some((row) => row.name === 'session_title'),
  ).toBe(true);
  inspection.close();
});
