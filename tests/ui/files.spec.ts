import { selectSession } from './session-fixture.js';
import { test, expect } from '@playwright/test';
import { defaultWorkspace } from '../../src/core/session-contracts.js';
import { mockSession, basicSnapshot } from './session-fixture.js';
const reference = (id: string, index: number, path: string, source = 'upload') => ({
  id,
  sessionId: 'basic',
  kind: 'file',
  index,
  name: path.split('/').at(-1),
  path: '/project/' + path,
  originalPath: path,
  worktreePath: '/project',
  source,
  mime: 'text/plain',
  size: 12,
});
for (const [width, height] of [
  [1280, 800],
  [390, 700],
  [900, 450],
])
  test(`file drops and keyboard lookup at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width: width!, height: height! });
    const snapshot = basicSnapshot();
    await mockSession(page, () => snapshot);
    const files = new Map<string, any>();
    let count = 0;
    const calls: any[] = [];
    await page.route('**/api/sessions/*/events', (r) =>
      r.fulfill({ contentType: 'text/event-stream', body: '' }),
    );
    await page.route('**/api/sessions/*/files', (r) => {
      const f = reference('file-' + ++count, count, r.request().postDataJSON().name);
      files.set(f.id, f);
      return r.fulfill({ json: f });
    });
    await page.route('**/files/*/metadata', (r) =>
      r.fulfill({ json: files.get(new URL(r.request().url()).pathname.split('/')[5]!) }),
    );
    await page.route('**/files/search?*', (r) =>
      r.fulfill({
        json: [
          { name: 'same.txt', relativePath: 'a/same.txt' },
          { name: 'same.txt', relativePath: 'very-long-directory/'.repeat(8) + 'b/same.txt' },
        ],
      }),
    );
    await page.route('**/files/preview?*', (r) =>
      r.fulfill({
        json: {
          name: 'same.txt',
          relativePath: new URL(r.request().url()).searchParams.get('path'),
          state: 'text',
          text: 'Read only',
          size: 9,
        },
      }),
    );
    await page.route('**/files/reference', (r) => {
      const f = reference(
        'file-' + ++count,
        count,
        r.request().postDataJSON().relativePath,
        'worktree',
      );
      files.set(f.id, f);
      return r.fulfill({ json: f });
    });
    await page.route('**/actions', (r) => {
      calls.push(r.request().postDataJSON());
      return r.fulfill({ json: { sessionId: snapshot.id, sequence: 2, snapshot } });
    });
    await page.goto('/#capability=test');
    const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
    await input.evaluate((e) => {
      const data = new DataTransfer();
      data.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
      e.dispatchEvent(
        new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }),
      );
    });
    await expect(page.locator('.composer .attachment-card')).toHaveCount(1);
    await expect(page.locator('.composer .attachment-card')).toContainText('File 1');
    await input.fill('Use @same');
    await expect(page.locator('.file-picker [role=option]')).toHaveCount(2);
    await input.press('ArrowDown');
    const listboxId = await page
      .getByRole('listbox', { name: 'Worktree files' })
      .getAttribute('id');
    await expect(input).toHaveAttribute('aria-controls', listboxId!);
    await expect(input).toHaveAttribute('aria-activedescendant', listboxId + '-1');
    await input.press('Enter');
    await expect(input).toHaveValue('Use @same');
    await expect(page.locator('.composer .attachment-card')).toHaveCount(1);
    await expect(page.getByRole('dialog', { name: 'File preview' })).toContainText('Read only');
    await page.getByRole('button', { name: 'Attach file', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'File preview' }).getByRole('status')).toHaveText(
      'Attached as File 2',
    );
    // Attach keeps keyboard focus inside the window, so Escape still closes it.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'File preview' })).toHaveCount(0);
    // Opened from the composer's @-mention picker, so closing returns focus there.
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Use \u200E@File 2 ');
    await expect(page.locator('.composer .attachment-card')).toHaveCount(2);
    await expect(page.locator('.composer .attachment-card').last()).toContainText('b/same.txt');
    expect(calls).toHaveLength(0);
    await input.fill('Keep @unresolved');
    await expect(page.locator('.file-picker [role=option]')).toHaveCount(2);
    await input.press('Escape');
    await expect(page.locator('.file-picker [role=option]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Remove File 1', exact: true }).click();
    await expect(page.locator('.composer .attachment-card')).toHaveCount(1);
    await page.reload();
    await expect(page.locator('.composer .attachment-card')).toContainText('File 2');
    await expect(input).toHaveValue('Keep @unresolved');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

test('discussion cleanup preserves new files and review preserves reference identity', async ({
  page,
}) => {
  let snapshot: any = basicSnapshot();
  await mockSession(page, () => snapshot);
  let serial = 0,
    sequence = 1;
  let release: (() => void) | undefined;
  let fail = true;
  const files = new Map<string, any>();
  const calls: any[] = [];
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route('**/files', (r) => {
    const f = reference('file-' + ++serial, serial, r.request().postDataJSON().name);
    files.set(f.id, f);
    return r.fulfill({ json: f });
  });
  await page.route('**/files/*/metadata', (r) =>
    r.fulfill({ json: files.get(new URL(r.request().url()).pathname.split('/')[5]!) }),
  );
  await page.route('**/actions', async (r) => {
    const a = r.request().postDataJSON();
    calls.push(a);
    if (a.type === 'discuss') {
      if (fail) return r.fulfill({ status: 400, json: { error: 'Discussion unavailable' } });
      if (a.attachmentIds?.includes('file-1'))
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      const attachments = a.attachmentIds?.map((id: string) => files.get(id));
      snapshot = {
        ...snapshot,
        discussion: [
          ...snapshot.discussion,
          { role: 'user', text: a.text, ...(attachments ? { attachments } : {}) },
          { role: 'assistant', text: 'Reply', ...(attachments ? { attachments } : {}) },
        ],
      };
    } else if (a.type === 'prepare')
      snapshot.currentDraft = {
        id: 'review',
        revision: 1,
        target: snapshot.target,
        sourceRevision: 1,
        language: 'he',
        localizedText: 'Use File 1',
        englishText: 'Hidden prepared English',
        attachments: [files.get('file-1')],
        selectedDiscussion: a.indices,
      };
    else if (a.type === 'send-composer')
      snapshot.deliveries = [
        {
          id: 'receipt',
          draftId: 'composer-' + a.requestId,
          revision: 1,
          target: snapshot.target,
          englishText: 'Direct English',
          state: 'sent',
        },
      ];
    return r.fulfill({
      json: {
        sessionId: snapshot.id,
        sequence: ++sequence,
        snapshot,
        ...(a.type === 'prepare' ? { review: snapshot.currentDraft } : {}),
      },
    });
  });
  await page.goto('/#capability=test');
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  const attach = page.getByLabel('Attach files', { exact: true });
  await attach.setInputFiles({
    name: 'first.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('first'),
  });
  await expect(page.locator('.composer .attachment-card')).toHaveCount(1);
  await input.fill('Discuss first');
  await page.getByRole('button', { name: 'Discuss first', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Discussion unavailable');
  await expect(input).toHaveValue('Discuss first');
  await expect(page.locator('.composer .attachment-card')).toHaveCount(1);
  fail = false;
  await page.getByRole('button', { name: 'Discuss first', exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await attach.setInputFiles({
    name: 'second.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('second'),
  });
  await expect(page.locator('.composer .attachment-card')).toHaveCount(2);
  release!();
  await expect(input).toHaveValue('');
  await expect(page.locator('.composer .attachment-card')).toHaveCount(1);
  await expect(page.locator('.composer .attachment-card')).toContainText('File 2');
  await page.getByRole('button', { name: 'Add to answer', exact: true }).click();
  await page.getByRole('button', { name: '1 selected', exact: true }).click();
  const selected = page.getByRole('dialog', { name: 'Selected messages', exact: true });
  await expect(selected.locator('.attachment-card')).toHaveCount(1);
  await expect(selected.locator('.attachment-card')).toContainText('File 1');
  await selected.getByRole('button', { name: 'Close Selected messages', exact: true }).click();
  await page.getByRole('button', { name: 'Prepare instruction', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review instruction', exact: true });
  await expect(review.locator('.attachment-card')).toHaveCount(1);
  await expect(review).not.toContainText('Hidden prepared English');
  await page.getByRole('button', { name: 'Edit instruction', exact: true }).click();
  await review.getByRole('textbox').fill('Edited File 1');
  await page.getByRole('button', { name: 'Close review', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Resume review', exact: true }).click();
  await expect(review.locator('.attachment-card')).toHaveCount(1);
  await expect(review).toContainText('Edited File 1');
  await page.getByRole('button', { name: 'Close review', exact: true }).click();
  await page.getByRole('button', { name: 'Remove File 2', exact: true }).click();
  await input.fill('Text only');
  await page.getByRole('button', { name: 'Discuss first', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(page.locator('.discussion .attachment-card')).toHaveCount(0);
  const prepared = calls.filter((a) => a.type === 'prepare').length;
  await input.fill('Direct request');
  await page.getByRole('button', { name: 'Send to Terminal in English', exact: true }).click();
  await expect(input).toHaveValue('');
  expect(calls.filter((a) => a.type === 'prepare')).toHaveLength(prepared);
  expect(calls.some((a) => a.type === 'send-composer')).toBe(true);
});

test('delayed upload belongs to A and stale lookup cannot appear in B', async ({ page }) => {
  const records = ['A', 'B'].map((id) => ({
    id,
    target: { agent: 'codex', sessionRef: id, projectId: '/project/' + id },
    canonicalRoot: '/project/' + id,
    projectName: id,
    enabled: true,
  }));
  const workspaces: any = {};
  const files = new Map<string, any>();
  let uploadRelease: (() => void) | undefined, searchRelease: (() => void) | undefined;
  await page.route('**/api/**', async (r) => {
    const path = new URL(r.request().url()).pathname;
    const id = path.split('/')[3] ?? 'A';
    const snapshot = { ...basicSnapshot(), id, target: records.find((v) => v.id === id)?.target };
    if (path === '/api/sessions') return r.fulfill({ json: records });
    if (path.endsWith('/workspace')) {
      const saved = (workspaces[id] ??= { sessionId: id, revision: 0, data: defaultWorkspace() });
      if (r.request().method() === 'PUT') {
        saved.revision++;
        saved.data = r.request().postDataJSON().data;
      }
      return r.fulfill({ json: saved });
    }
    if (path.endsWith('/snapshot'))
      return r.fulfill({ json: { sessionId: id, sequence: 1, snapshot } });
    if (path.endsWith('/events')) return r.fulfill({ contentType: 'text/event-stream', body: '' });
    if (path.endsWith('/files/search')) {
      if (id === 'A')
        await new Promise<void>((resolve) => {
          searchRelease = resolve;
        });
      return r
        .fulfill({ json: [{ name: 'same.txt', relativePath: id + '/same.txt' }] })
        .catch(() => {});
    }
    if (path.endsWith('/files')) {
      await new Promise<void>((resolve) => {
        uploadRelease = resolve;
      });
      const file = { ...reference('A-file', 1, 'delayed.txt'), sessionId: id };
      files.set(file.id, file);
      return r.fulfill({ json: file });
    }
    if (path.endsWith('/metadata')) return r.fulfill({ json: files.get(path.split('/')[5]!) });
    return r.fulfill({ status: 404, json: { error: 'Unexpected route' } });
  });
  await page.goto('/#capability=test');
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.fill('A @same');
  await expect.poll(() => Boolean(searchRelease)).toBe(true);
  await page
    .getByLabel('Attach files', { exact: true })
    .setInputFiles({ name: 'delayed.txt', mimeType: 'text/plain', buffer: Buffer.from('A') });
  await expect.poll(() => Boolean(uploadRelease)).toBe(true);
  await selectSession(page, 'B');
  await input.fill('B @same');
  await expect(page.locator('.file-picker')).toContainText('B/same.txt');
  uploadRelease!();
  searchRelease!();
  await expect.poll(() => workspaces.A?.data.attachmentIds).toEqual(['A-file']);
  await expect(page.locator('.composer .attachment-card')).toHaveCount(0);
  await expect(page.locator('.file-picker')).not.toContainText('A/same.txt');
  await expect(input).toHaveValue('B @same');
  await input.press('Escape');
  await selectSession(page, 'A');
  await expect(page.locator('.composer .attachment-card')).toContainText('File 1');
  await page.reload();
  await expect(page.locator('.composer .attachment-card')).toContainText('delayed.txt');
});

test('unresolved mention with no picker result submits ordinary text on Enter', async ({
  page,
}) => {
  const snapshot = basicSnapshot();
  await mockSession(page, () => snapshot);
  const calls: any[] = [];
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route('**/files/search?*', (r) => r.fulfill({ json: [] }));
  await page.route('**/actions', (r) => {
    calls.push(r.request().postDataJSON());
    return r.fulfill({ json: { sessionId: snapshot.id, sequence: 2, snapshot } });
  });
  await page.goto('/#capability=test');
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.fill('Discuss @unknown');
  await expect(page.getByText('No matching files', { exact: true })).toBeVisible();
  await input.press('Enter');
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toMatchObject({ type: 'send-composer', text: 'Discuss @unknown' });
});

test('authoritative unreadable status appears on composer, history, selection and review cards', async ({
  page,
}) => {
  const binary = reference('binary', 1, 'binary.dat');
  const invalid = reference('invalid', 2, 'invalid.txt');
  const snapshot: any = {
    ...basicSnapshot(),
    discussion: [
      { role: 'assistant', text: 'Captured references', attachments: [binary, invalid] },
    ],
    currentDraft: {
      id: 'status-review',
      revision: 1,
      target: basicSnapshot().target,
      sourceRevision: 1,
      language: 'he',
      localizedText: 'Review files',
      englishText: 'Private English',
      attachments: [binary, invalid],
      selectedDiscussion: [0],
    },
  };
  await mockSession(page, () => snapshot);
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route('**/files', (r) => r.fulfill({ json: binary }));
  await page.route('**/files/*/metadata', (r) => {
    const id = new URL(r.request().url()).pathname.split('/')[5];
    return r.fulfill({
      json: {
        ...(id === 'binary' ? binary : invalid),
        contentStatus: {
          state: 'unreadable',
          reason: 'Unsupported binary or invalid UTF-8 content',
        },
      },
    });
  });
  await page.goto('/#capability=test');
  await page.getByLabel('Attach files', { exact: true }).setInputFiles({
    name: 'binary.dat',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from([0, 1]),
  });
  await expect(page.locator('.composer .attachment-card')).toContainText(
    'Unreadable content: Unsupported binary or invalid UTF-8 content',
  );
  await expect(page.locator('.composer .attachment-card')).toContainText('File 1');
  for (const card of await page.locator('.discussion .attachment-card').all())
    await expect(card).toContainText(
      'Unreadable content: Unsupported binary or invalid UTF-8 content',
    );
  await page.getByRole('button', { name: 'Add to answer', exact: true }).click();
  await page.getByRole('button', { name: '1 selected', exact: true }).click();
  const selected = page.getByRole('dialog', { name: 'Selected messages', exact: true });
  await expect(selected.locator('.attachment-card')).toHaveCount(2);
  for (const card of await selected.locator('.attachment-card').all())
    await expect(card).toContainText('Unreadable content:');
  await selected.getByRole('button', { name: 'Close Selected messages', exact: true }).click();
  await page.getByRole('button', { name: 'Resume review', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review instruction', exact: true });
  await expect(review.locator('.attachment-card')).toHaveCount(2);
  for (const card of await review.locator('.attachment-card').all())
    await expect(card).toContainText('Unreadable content:');
  await page.getByRole('button', { name: 'Close review', exact: true }).click();
  await page.reload();
  await expect(page.locator('.composer .attachment-card')).toContainText('Unreadable content:');
});
