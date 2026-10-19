import { selectSession, expectSelected, preferFullAssistant } from './session-fixture.js';
import { test, expect, type BrowserContext } from '@playwright/test';
import { defaultWorkspace } from '../../src/core/session-contracts.js';

async function fixture(context: BrowserContext) {
  const records = ['A', 'B'].map((id) => ({
    id,
    target: { agent: 'codex', sessionRef: id, projectId: `/project/${id}` },
    canonicalRoot: `/project/${id}`,
    projectName: `Project ${id}`,
    branch: `branch-${id}`,
    worktreePath: `/project/${id}`,
    enabled: true,
  }));
  const snapshots: Record<string, any> = Object.fromEntries(
    records.map((record) => [
      record.id,
      {
        id: record.id,
        target: record.target,
        codingState: 'idle',
        capabilities: { fileReferences: true },
        codingMessages: [],
        discussion: [],
        deliveries: [],
        language: 'he',
        languageSessionId: '',
        languageModel: 'default',
        sourceRevision: 0,
      },
    ]),
  );
  const workspaces = Object.fromEntries(
    records.map((record) => [
      record.id,
      { sessionId: record.id, revision: 0, data: defaultWorkspace() },
    ]),
  );
  const files = new Map<string, any>();
  const counters: Record<string, number> = { A: 0, B: 0 };
  const actions: any[] = [];
  let release: (() => void) | undefined;
  const register = (id: string, name: string, source = 'upload') => {
    const index = ++counters[id]!;
    const file = {
      id: `${id}-${index}`,
      sessionId: id,
      kind: 'file',
      index,
      name,
      path: `/project/${id}/${name}`,
      worktreePath: `/project/${id}`,
      source,
      mime: 'text/plain',
      size: 4,
      ...(source === 'worktree' ? { originalPath: name } : {}),
    };
    files.set(file.id, file);
    return file;
  };
  await preferFullAssistant(
    context,
    records.map((r) => r.id),
  );
  await context.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const id = path.split('/')[3]!;
    if (path === '/api/sessions') return route.fulfill({ json: records });
    if (path === '/api/snapshot')
      return route.fulfill({ json: { sequence: 1, snapshot: snapshots.A } });
    if (path.endsWith('/workspace')) {
      const saved = workspaces[id]!;
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON();
        if (body.expectedRevision !== saved.revision)
          return route.fulfill({
            status: 409,
            json: { code: 'workspace-conflict', current: saved },
          });
        saved.revision++;
        saved.data = body.data;
      }
      return route.fulfill({ json: saved });
    }
    if (path.endsWith('/snapshot'))
      return route.fulfill({ json: { sessionId: id, sequence: 1, snapshot: snapshots[id] } });
    if (path.endsWith('/events'))
      return route.fulfill({ contentType: 'text/event-stream', body: '' });
    if (path.endsWith('/files'))
      return route.fulfill({ json: register(id, route.request().postDataJSON().name) });
    if (path.endsWith('/files/search'))
      return route.fulfill({ json: [{ name: 'note.txt', relativePath: 'src/note.txt' }] });
    if (path.endsWith('/files/preview'))
      return route.fulfill({
        json: {
          name: 'note.txt',
          relativePath: 'src/note.txt',
          state: 'text',
          text: 'Live note',
          size: 9,
        },
      });
    if (path.endsWith('/files/reference'))
      return route.fulfill({
        json: register(id, route.request().postDataJSON().relativePath, 'worktree'),
      });
    if (path.endsWith('/metadata')) return route.fulfill({ json: files.get(path.split('/')[5]!) });
    if (path.endsWith('/actions')) {
      const action = route.request().postDataJSON();
      actions.push({ sessionId: id, ...action });
      if (action.type === 'check-composer') {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        snapshots[id].deliveries[0].state = 'sent';
      }
      return route.fulfill({ json: { sessionId: id, sequence: 2, snapshot: snapshots[id] } });
    }
    return route.fulfill({ status: 404, json: { error: 'Unexpected fixture route' } });
  });
  return {
    snapshots,
    workspaces,
    files,
    register,
    actions,
    get release() {
      return release;
    },
  };
}

test('uploaded A and live-reference B keep independent numbering and layouts through switches and refresh', async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  await page.goto('/#capability=test');
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.evaluate((element) => {
    const data = new DataTransfer();
    data.items.add(new File(['copy'], 'copy.txt', { type: 'text/plain' }));
    element.dispatchEvent(
      new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.locator('.composer .attachment-card')).toContainText('File 1');
  await input.fill('A uploaded copy');
  await page.getByLabel('Panel layout').selectOption('columns');
  await selectSession(page, 'B');
  await input.fill('B @note');
  await expect(page.getByRole('option', { name: /src\/note.txt/ })).toBeVisible();
  await input.press('Enter');
  await expect(input).toHaveValue('B @note');
  expect([...f.files.values()].filter((file) => file.sessionId === 'B')).toHaveLength(0);
  await page.getByRole('button', { name: 'Attach file', exact: true }).click();
  await page.getByRole('button', { name: 'Close file preview', exact: true }).click();
  await expect(input).toHaveValue('B \u200E@File 1 ');
  await page.getByLabel('Panel layout').selectOption('rows');
  for (let round = 0; round < 2; round++)
    for (const id of ['A', 'B']) {
      await selectSession(page, id);
      await page.reload();
      await expectSelected(page, id);
      await expect(input).toHaveValue(id === 'A' ? 'A uploaded copy' : 'B \u200E@File 1 ');
      await expect(page.getByLabel('Panel layout')).toHaveValue(id === 'A' ? 'columns' : 'rows');
      await expect(page.locator('.composer .attachment-card')).toHaveCount(1);
      await expect(page.locator('.composer .attachment-card')).toContainText(
        id === 'A' ? 'copy.txt' : 'src/note.txt',
      );
    }
  expect(f.workspaces.A!.data.attachmentIds).toEqual(['A-1']);
  expect(f.workspaces.B!.data.attachmentIds).toEqual(['B-1']);
  expect(f.files.get('A-1').source).toBe('upload');
  expect(f.files.get('B-1').source).toBe('worktree');
  expect(f.actions).toEqual([]);
});

test('restored pending receipt clears source files only while another session is visible', async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  const sent = f.register('A', 'submitted.txt');
  const newer = f.register('A', 'newer.txt');
  const b = f.register('B', 'keep.txt');
  f.workspaces.A!.revision = 4;
  f.workspaces.A!.data = {
    ...defaultWorkspace(),
    composer: 'Newer A text',
    attachmentIds: [sent.id, newer.id],
    composerAttempt: { requestId: 'pending', text: 'Submitted A text', attachmentIds: [sent.id] },
  };
  f.workspaces.B!.revision = 7;
  f.workspaces.B!.data = {
    ...defaultWorkspace(),
    composer: 'B stays intact',
    attachmentIds: [b.id],
    layout: { ...defaultWorkspace().layout, mode: 'rows' },
  };
  f.snapshots.A.deliveries = [
    {
      id: 'native-receipt',
      draftId: 'composer-pending',
      revision: 1,
      target: f.snapshots.A.target,
      state: 'queued',
      englishText: 'Submitted A text',
      referenceFormat: 'manifest-v1',
      attachments: [sent],
    },
  ];
  const beforeB = structuredClone(f.workspaces.B);
  await page.goto('/#capability=test');
  await expect.poll(() => Boolean(f.release)).toBe(true);
  await selectSession(page, 'B');
  f.release!();
  await expect.poll(() => f.workspaces.A!.data.composerAttempt).toBeNull();
  expect(f.workspaces.A!.data.composer).toBe('Newer A text');
  expect(f.workspaces.A!.data.attachmentIds).toEqual([newer.id]);
  expect(f.workspaces.B).toEqual(beforeB);
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await expect(input).toHaveValue('B stays intact');
  await expect(page.locator('.composer .attachment-card')).toContainText('keep.txt');
  await page.reload();
  await expect(input).toHaveValue('B stays intact');
  await selectSession(page, 'A');
  await expect(input).toHaveValue('Newer A text');
  await expect(page.locator('.composer .attachment-card')).toHaveCount(1);
  await expect(page.locator('.composer .attachment-card')).toContainText('File 2');
  expect(
    f.actions.every((action) => action.type === 'check-composer' && action.sessionId === 'A'),
  ).toBe(true);
});
