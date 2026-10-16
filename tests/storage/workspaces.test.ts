import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationSnapshot } from '../../src/core/contracts.js';
import {
  defaultWorkspace,
  WorkspaceConflict,
  type SessionRecord,
} from '../../src/core/session-contracts.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { DatabaseSync } from 'node:sqlite';

const directories: string[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'session-workspaces-'));
  directories.push(directory);
  const project = join(directory, 'project');
  mkdirSync(project);
  return { path: join(directory, 'assistant.sqlite'), project: realpathSync(project) };
}

function session(id: string, root: string, native = id): SessionRecord {
  return {
    id,
    target: { agent: 'codex', sessionRef: native, projectId: root },
    canonicalRoot: root,
    projectName: 'Fixture',
    enabled: true,
  };
}

function snapshot(id: string, root: string): ConversationSnapshot {
  const target = { agent: 'codex' as const, sessionRef: id, projectId: root };
  return {
    id,
    target,
    codingState: 'idle',
    codingMessages: [],
    discussion: [],
    deliveries: [],
    language: 'he',
    languageSessionId: 'language-1',
    languageModel: 'model-1',
    sourceRevision: 0,
    currentDraft: {
      id: 'draft-1',
      revision: 4,
      target,
      sourceRevision: 0,
      language: 'he',
      localizedText: 'review',
      englishText: 'review',
    },
  };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('session workspaces', () => {
  it('rolls back the draft clear if the workspace update fails', () => {
    const { path, project } = fixture();
    const store = new SqliteStore(path);
    store.registerSession(session('session-a', project));
    const saved = snapshot('session-a', project);
    saved.composerDraft = { ...saved.currentDraft!, id: 'composer-old' };
    store.save(saved);
    store.writeWorkspace('session-a', 0, {
      ...defaultWorkspace(),
      composerAttempt: { requestId: 'old', text: 'Keep', attachmentIds: [] },
    });
    const raw = new DatabaseSync(path);
    raw.exec(
      "CREATE TRIGGER reject_release BEFORE UPDATE ON session_workspaces BEGIN SELECT RAISE(ABORT, 'forced failure'); END",
    );
    raw.close();
    try {
      expect(() => store.releaseComposerAttempt('session-a', 'old')).toThrow('forced failure');
      expect(store.load('session-a')?.composerDraft).toEqual(saved.composerDraft);
      expect(store.readWorkspace('session-a')).toMatchObject({
        revision: 1,
        data: { composerAttempt: { requestId: 'old' } },
      });
    } finally {
      store.close();
    }
  });
  it('atomically releases only the matching attempt across reopen and preserves receipts and newer edits', () => {
    const { path, project } = fixture();
    const store = new SqliteStore(path);
    store.registerSession(session('session-a', project));
    const saved = snapshot('session-a', project);
    saved.composerDraft = { ...saved.currentDraft!, id: 'composer-old' };
    saved.deliveries = [
      {
        id: 'delivery-old',
        draftId: 'composer-old',
        revision: 4,
        target: saved.target!,
        englishText: 'retained',
        state: 'unconfirmed',
        transport: 'channel',
        channelGeneration: 'generation-old',
      },
    ];
    store.save(saved);
    const workspace = {
      ...defaultWorkspace(),
      composer: 'newer text',
      selectedDiscussion: [1],
      composerAttempt: { requestId: 'old', text: 'retained', attachmentIds: [] },
    };
    store.writeWorkspace('session-a', 0, workspace);
    store.releaseComposerAttempt('session-a', 'wrong');
    expect(store.readWorkspace('session-a').revision).toBe(1);
    store.releaseComposerAttempt('session-a', 'old');
    store.close();
    const reopened = new SqliteStore(path);
    try {
      expect(reopened.load('session-a')?.composerDraft).toBeUndefined();
      expect(reopened.load('session-a')?.deliveries).toEqual(saved.deliveries);
      expect(reopened.readWorkspace('session-a')).toEqual({
        sessionId: 'session-a',
        revision: 2,
        data: { ...workspace, composerAttempt: null },
      });
      reopened.releaseComposerAttempt('session-a', 'old');
      expect(reopened.readWorkspace('session-a').revision).toBe(2);
      expect(() => reopened.writeWorkspace('session-a', 1, workspace)).toThrow(WorkspaceConflict);
      const next = { ...saved, composerDraft: { ...saved.composerDraft!, id: 'composer-new' } };
      reopened.save(next);
      reopened.writeWorkspace('session-a', 2, {
        ...workspace,
        composerAttempt: { requestId: 'new', text: 'new', attachmentIds: [] },
      });
      reopened.releaseComposerAttempt('session-a', 'old');
      expect(reopened.load('session-a')?.composerDraft?.id).toBe('composer-new');
      expect(reopened.readWorkspace('session-a').revision).toBe(3);
      expect(reopened.readWorkspace('session-a').data.composerAttempt?.requestId).toBe('new');
    } finally {
      reopened.close();
    }
  });
  it('isolates workspace state and rejects stale compare-and-swap writes', () => {
    const { path, project } = fixture();
    const store = new SqliteStore(path);
    store.registerSession(session('session-a', project));
    store.registerSession(session('session-b', project));

    store.registerFileReference({
      id: 'attachment-a',
      sessionId: 'session-a',
      kind: 'image',
      name: 'a.png',
      path: '/fixture/a.png',
      worktreePath: project,
      source: 'upload',
      mime: 'image/png',
      size: 1,
    });
    const first = store.readWorkspace('session-a');
    const update = {
      ...first.data,
      composer: 'A',
      attachmentIds: ['attachment-a'],
      layout: { ...first.data.layout, mode: 'columns', liveSize: 25, discussionSize: 75 },
      deliveryState: 'sent',
    } as typeof first.data;
    const written = store.writeWorkspace('session-a', first.revision, update);

    expect(written.revision).toBe(1);
    expect(written.data).not.toHaveProperty('deliveryState');
    expect(() =>
      store.writeWorkspace('session-a', first.revision, {
        ...first.data,
        composer: 'stale',
      }),
    ).toThrow('Workspace changed');
    expect(store.readWorkspace('session-a').data).toMatchObject({
      composer: 'A',
      attachmentIds: ['attachment-a'],
      layout: { mode: 'columns', liveSize: 25, discussionSize: 75 },
    });
    expect(store.readWorkspace('session-b').data).toEqual(defaultWorkspace());
    store.close();
  });

  it('persists registration and workspace data across reopen', () => {
    const { path, project } = fixture();
    const first = new SqliteStore(path);
    first.save(snapshot('session-a', project));
    first.registerSession({
      ...session('session-a', project),
      branch: 'feature',
      worktreePath: project,
    });
    for (const id of ['one', 'two'])
      first.registerFileReference({
        id,
        sessionId: 'session-a',
        kind: 'image',
        name: id + '.png',
        path: '/fixture/' + id,
        worktreePath: project,
        source: 'upload',
        mime: 'image/png',
        size: 1,
      });
    const initial = first.readWorkspace('session-a');
    first.writeWorkspace('session-a', initial.revision, {
      ...initial.data,
      selectedDiscussion: [1, 3],
      attachmentIds: ['one', 'two'],
      review: { draftId: 'draft-1', revision: 4, localizedText: 'review' },
      composerAttempt: { requestId: 'request-1', text: 'send', attachmentIds: ['two'] },
      layout: {
        mode: 'rows',
        order: ['composer', 'live', 'assistant'],
        liveSize: 30,
        discussionSize: 60,
      },
    });
    first.close();

    const reopened = new SqliteStore(path);
    expect(reopened.listSessions()).toEqual([
      { ...session('session-a', project), branch: 'feature', worktreePath: project },
    ]);
    expect(reopened.readWorkspace('session-a')).toEqual({
      sessionId: 'session-a',
      revision: 1,
      data: {
        ...defaultWorkspace(),
        selectedDiscussion: [1, 3],
        attachmentIds: ['one', 'two'],
        review: { draftId: 'draft-1', revision: 4, localizedText: 'review' },
        composerAttempt: { requestId: 'request-1', text: 'send', attachmentIds: ['two'] },
        layout: {
          mode: 'rows',
          order: ['composer', 'live', 'assistant'],
          liveSize: 30,
          discussionSize: 60,
        },
      },
    });
    reopened.close();
  });

  it('deduplicates native targets and rejects remapping an existing session ID', () => {
    const { path, project } = fixture();
    const store = new SqliteStore(path);
    const original = store.registerSession(session('session-a', project, 'native-1'));
    expect(store.registerSession(session('different-id', project, 'native-1'))).toEqual(original);
    expect(() => store.registerSession(session('session-a', project, 'native-2'))).toThrow(
      'Session ID is already registered to a different target',
    );
    expect(store.listSessions()).toEqual([original]);
    store.close();
  });

  it('validates layout order and clamps finite divider sizes', () => {
    const { path, project } = fixture();
    const store = new SqliteStore(path);
    store.registerSession(session('session-a', project));
    const first = store.readWorkspace('session-a');
    const written = store.writeWorkspace('session-a', 0, {
      ...first.data,
      layout: { ...first.data.layout, liveSize: -5, discussionSize: 120 },
    });
    expect(written.data.layout).toMatchObject({ liveSize: 10, discussionSize: 90 });
    expect(() =>
      store.writeWorkspace('session-a', written.revision, {
        ...written.data,
        layout: { ...written.data.layout, order: ['live', 'live', 'composer'] },
      }),
    ).toThrow('Invalid workspace layout order');
    expect(() =>
      store.writeWorkspace('session-a', written.revision, {
        ...written.data,
        layout: { ...written.data.layout, liveSize: Number.NaN },
      }),
    ).toThrow('Invalid workspace divider size');
    store.close();
  });

  it('exposes the current record on workspace conflicts', () => {
    const { path, project } = fixture();
    const store = new SqliteStore(path);
    store.registerSession(session('session-a', project));
    store.writeWorkspace('session-a', 0, { ...defaultWorkspace(), composer: 'current' });
    try {
      store.writeWorkspace('session-a', 0, {
        ...defaultWorkspace(),
        composer: 'stale',
        review: { draftId: 'removed-draft', revision: 1, localizedText: 'stale edit' },
      });
      throw new Error('Expected conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceConflict);
      expect(error).toMatchObject({ code: 'workspace-conflict', current: { revision: 1 } });
    }
    store.close();
  });
});
