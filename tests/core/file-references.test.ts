import { expect, it } from 'vitest';
import { createTestWorkflow } from '../helpers/create-test-workflow.js';
import type { FileReference } from '../../src/core/file-references.js';
import { attachmentManifest } from '../../src/core/file-references.js';
import { codexMessage } from '../../src/agents/codex/index.js';
const file = (id: string, index: number): FileReference => ({
  id,
  index,
  sessionId: 'conversation-1',
  kind: 'file',
  name: `${id}.ts`,
  path: `/p/${id}.ts`,
  worktreePath: '/p',
  source: 'worktree',
  mime: 'text/plain',
  size: 1,
});
it('retains selected first occurrence order and current exchange membership for generic files', async () => {
  const app = await createTestWorkflow();
  await app.workflow.discuss('', [file('b', 8), file('a', 2)]);
  await app.workflow.discuss('Unrelated');
  expect(app.workflow.snapshot().discussion[3]?.attachments).toBeUndefined();
  const review = await app.workflow.prepareReview([1, 0]);
  expect(review.attachments?.map((a) => a.id)).toEqual(['b', 'a']);
  await app.workflow.close();
});
it('accepts ten generic files without the four image limit', async () => {
  const app = await createTestWorkflow();
  await app.workflow.discuss(
    '',
    Array.from({ length: 10 }, (_, i) => file(`f${i}`, i + 1)),
  );
  expect(app.workflow.snapshot().discussion[1]?.attachments).toHaveLength(10);
  await app.workflow.close();
});
it('uses exact shared manifest for normalized coding references', () => {
  const files = [file('a', 2)];
  expect(codexMessage('Implement', files)).toBe(`Implement\n\n${attachmentManifest(files)}`);
});
it('preserves composer and edited review references on unsupported delivery', async () => {
  const app = await createTestWorkflow();
  app.language.translationReply = 'Use file';
  await expect(app.workflow.sendComposer('direct', 'Use this', [file('a', 3)])).rejects.toThrow(
    'preserved',
  );
  expect(app.workflow.snapshot().composerDraft?.attachments).toEqual([file('a', 3)]);
  await app.workflow.discuss('Request', [file('b', 4)]);
  const draft = await app.workflow.prepareDirect([0]);
  await expect(app.workflow.sendReview(draft.id, draft.revision, 'עריכה')).rejects.toThrow(
    'preserved',
  );
  expect(app.workflow.snapshot().currentDraft?.attachments).toEqual([file('b', 4)]);
  expect(app.agent.sent).toHaveLength(0);
  await app.workflow.close();
});
it('legacy prepare captures files and revise keeps only captured membership', async () => {
  const app = await createTestWorkflow();
  await app.workflow.discuss('First', [file('a', 1)]);
  const draft = await app.workflow.prepare();
  expect(draft.attachments).toEqual([file('a', 1)]);
  await app.workflow.discuss('Later', [file('b', 2)]);
  await app.workflow.reviseDraft(draft.id, 'Edit first');
  expect(
    app.language.inputs.at(-1)?.selectedDiscussion?.flatMap((t) => t.attachments ?? []),
  ).toEqual([file('a', 1)]);
  await app.workflow.close();
});

import { mkdtemp, mkdir, writeFile, rm, unlink, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { createApplication } from '../../src/runtime/application.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';
it('resolves real session files at language and send boundaries, preserving captured membership across browser selection and edits', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'workflow-files-')));
  const store = new SqliteStore(':memory:');
  const agent = new FakeAgent();
  agent.capabilities.fileReferences = true;
  agent.result = { state: 'queued' };
  const languages: FakeLanguageSession[] = [];
  const app = createApplication({
    attachmentRoot: join(dir, 'uploads'),
    store,
    agents: [agent],
    conversationId: 'A',
    capability: 'cap',
    languageBackends: {
      codex: {
        models: async () => [],
        open: async () => {
          const l = new FakeLanguageSession();
          l.translationReply = 'Use referenced file';
          languages.push(l);
          return l;
        },
      },
    },
  });
  try {
    for (const id of ['A', 'B']) {
      await mkdir(join(dir, id));
      await writeFile(join(dir, id, 'app.ts'), `${id}: untrusted source`);
      await app.sessions!.register(
        { agent: 'codex', sessionRef: id, projectId: join(dir, id) },
        id,
      );
    }
    const a = await app.files!.reference('A', 'app.ts');
    const b = await app.files!.reference('B', 'app.ts');
    await app.sessions!.action('A', { type: 'discuss', text: '', attachmentIds: [a.id] });
    expect(languages[0]!.inputs[0]!.fileContext).toEqual([
      { id: a.id, index: a.index, text: 'A: untrusted source' },
    ]);
    const prepared = await app.sessions!.action('A', { type: 'prepare', indices: [1, 0] });
    const draft = prepared.snapshot.currentDraft!;
    await app.sessions!.action('B', {
      type: 'discuss',
      text: 'Other browser selection',
      attachmentIds: [b.id],
    });
    await expect(
      app.sessions!.action('B', {
        type: 'send-review',
        draftId: draft.id,
        revision: draft.revision,
        localizedText: 'Changed',
      }),
    ).rejects.toThrow();
    await expect.poll(() => app.sessions!.snapshot('A').snapshot.codingState).toBe('idle');
    await app.sessions!.action('A', {
      type: 'send-review',
      draftId: draft.id,
      revision: draft.revision,
      localizedText: 'Changed',
    });
    expect(agent.sent[0]!.attachments).toEqual([a]);
    expect(languages[0]!.inputs.at(-1)!.selectedDiscussion?.[0]?.attachments).toEqual([a]);
    expect(app.sessions!.snapshot('A').snapshot.deliveries[0]?.target.sessionRef).toBe('A');
    expect(store.load('A')?.deliveries[0]?.referenceFormat).toBe('manifest-v1');
    await app.sessions!.action('A', {
      type: 'send-review',
      draftId: draft.id,
      revision: draft.revision + 1,
      localizedText: 'Changed',
    });
    expect(agent.sent).toHaveLength(1);
    await expect(
      app.sessions!.action('B', { type: 'discuss', text: 'Wrong owner', attachmentIds: [a.id] }),
    ).rejects.toThrow('belong');
    await unlink(b.path);
    await expect(
      app.sessions!.action('B', {
        type: 'send-composer',
        requestId: 'missing',
        text: 'Use file',
        attachmentIds: [b.id],
      }),
    ).rejects.toThrow();
    expect(agent.sent).toHaveLength(1);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
it('rejects retargeted references before dispatch and keeps prepared files intact', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'workflow-retarget-')));
  const store = new SqliteStore(':memory:');
  const agent = new FakeAgent();
  agent.capabilities.fileReferences = true;
  const language = new FakeLanguageSession();
  const app = createApplication({
    attachmentRoot: join(dir, 'uploads'),
    store,
    agents: [agent],
    conversationId: 'A',
    capability: 'cap',
    languageBackends: { codex: { models: async () => [], open: async () => language } },
  });
  try {
    await writeFile(join(dir, 'one.ts'), 'one');
    await writeFile(join(dir, 'two.ts'), 'two');
    await symlink(join(dir, 'one.ts'), join(dir, 'selected.ts'));
    await app.sessions!.register({ agent: 'codex', sessionRef: 'A', projectId: dir }, 'A');
    const reference = await app.files!.reference('A', 'selected.ts');
    await app.sessions!.action('A', {
      type: 'discuss',
      text: 'Use file',
      attachmentIds: [reference.id],
    });
    const draft = (await app.sessions!.action('A', { type: 'prepare', indices: [0] })).snapshot
      .currentDraft!;
    await unlink(join(dir, 'selected.ts'));
    await symlink(join(dir, 'two.ts'), join(dir, 'selected.ts'));
    await expect(
      app.sessions!.action('A', { type: 'send', draftId: draft.id, revision: draft.revision }),
    ).rejects.toThrow();
    expect(agent.sent).toHaveLength(0);
    expect(app.sessions!.snapshot('A').snapshot.currentDraft?.attachments).toEqual([reference]);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
it('does not turn a reference delivery Sent from an event whose native text cannot be reconciled', async () => {
  const app = await createTestWorkflow({
    capabilities: { fileReferences: true },
    deliveryResult: { state: 'queued' },
  });
  const attach = app.agent.attach.bind(app.agent);
  app.agent.attach = async (target) => ({
    ...(await attach(target)),
    reconcileDelivery: async () => false,
  });
  await app.workflow.connect(app.workflow.snapshot().target!);
  await expect.poll(() => app.workflow.snapshot().codingState).toBe('idle');
  await app.workflow.discuss('Use file', [file('a', 1)]);
  const draft = await app.workflow.prepareDirect([0]);
  const receipt = await app.workflow.send(draft.id, draft.revision);
  app.agent.emit({ type: 'delivery', requestId: receipt.id, state: 'sent' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(app.workflow.snapshot().deliveries[0]?.state).toBe('queued');
  expect(app.workflow.snapshot().currentDraft?.attachments).toEqual([file('a', 1)]);
  await app.workflow.close();
});
it('amends the captured instruction while excluding later discussion and file membership', async () => {
  const app = await createTestWorkflow();
  app.language.prepareResult = {
    localizedText: 'ממש את תכונה X',
    englishText: 'Implement feature X',
  };
  await app.workflow.discuss('Implement feature X', [file('feature', 1)]);
  const draft = await app.workflow.prepareDirect([0]);
  await app.workflow.discuss('Unrelated feature Y', [file('unrelated', 2)]);
  await app.workflow.reviseDraft(draft.id, 'Also add tests');
  const input = app.language.inputs.at(-1)!;
  expect(input.selectedDiscussion?.map((turn) => turn.text)).toEqual([
    draft.englishText,
    'Also add tests',
  ]);
  expect(input.selectedDiscussion?.flatMap((turn) => turn.attachments ?? [])).toEqual([
    file('feature', 1),
  ]);
  expect(input.discussion).toEqual([]);
  expect(app.workflow.snapshot().currentDraft?.attachments).toEqual([file('feature', 1)]);
  await app.workflow.close();
});
