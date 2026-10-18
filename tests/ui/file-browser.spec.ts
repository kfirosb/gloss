import { test, expect } from '@playwright/test';
import { defaultWorkspace } from '../../src/core/session-contracts.js';
import { mockSession, basicSnapshot, selectSession } from './session-fixture.js';
for (const [width, height] of [
  [1280, 800],
  [390, 700],
  [900, 450],
])
  test(`browse preview attach drop and Discuss first at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width: width!, height: height! });
    const snapshot = basicSnapshot();
    await mockSession(page, () => snapshot);
    const ref = {
      id: 'ref',
      sessionId: 'basic',
      kind: 'file',
      index: 1,
      name: 'notes.txt',
      path: '/project/src/notes.txt',
      originalPath: 'src/notes.txt',
      worktreePath: '/project',
      source: 'worktree',
      mime: 'text/plain',
      size: 20,
    };
    let registrations = 0;
    const actions: any[] = [];
    await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: '' }));
    await page.route('**/files/browse?*', (r) =>
      r.fulfill({
        json: {
          entries: new URL(r.request().url()).searchParams.get('path')
            ? [{ name: 'notes.txt', relativePath: 'src/notes.txt', kind: 'file' }]
            : [{ name: 'src', relativePath: 'src', kind: 'directory' }],
          limited: false,
        },
      }),
    );
    await page.route('**/files/preview?*', (r) =>
      r.fulfill({
        json: {
          name: 'notes.txt',
          relativePath: 'src/notes.txt',
          state: 'text',
          size: 20,
          text: '<script>unsafe()</script>\n' + 'long line '.repeat(500),
        },
      }),
    );
    await page.route('**/files/find?*', (r) =>
      r.fulfill({
        json: {
          entries: [{ name: 'notes.txt', relativePath: 'src/notes.txt' }],
          limited: true,
          guidance: 'Bounded content search',
        },
      }),
    );
    await page.route('**/files/reference', (r) => {
      registrations++;
      return r.fulfill({ json: ref });
    });
    await page.route('**/files/*/metadata', (r) => r.fulfill({ json: ref }));
    await page.route('**/actions', (r) => {
      actions.push(r.request().postDataJSON());
      return r.fulfill({ json: { sessionId: snapshot.id, sequence: 2, snapshot } });
    });
    await page.goto('/#capability=test');
    const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
    await input.fill('Keep this');
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.getByRole('button', { name: 'Open folder src', exact: true }).click();
    await page.getByRole('button', { name: 'Preview notes.txt', exact: true }).click();
    const preview = page
      .getByRole('dialog', { name: 'File preview' })
      .locator('.files-window-preview');
    await expect(preview).toContainText('<script>unsafe()</script>');
    await expect(input).toHaveValue('Keep this');
    expect(registrations).toBe(0);
    await expect(page.locator('.composer .attachment-card')).toHaveCount(0);
    await preview.getByRole('button', { name: 'Attach file', exact: true }).click();
    await expect(input).toHaveValue('Keep this \u200E@File 1 ');
    await expect(preview.getByRole('status')).toHaveText('Attached as File 1');
    await preview.getByRole('button', { name: 'Attach file', exact: true }).click();
    await expect(input).toHaveValue('Keep this \u200E@File 1 ');
    // Closing the popup leaves the Files column open for the search below.
    await page
      .getByRole('dialog', { name: 'File preview' })
      .getByRole('button', { name: 'Close file preview', exact: true })
      .click();
    await expect(page.getByRole('dialog', { name: 'File preview' })).toHaveCount(0);
    await expect(page.locator('.composer .attachment-card')).toHaveCount(1);
    await expect(page.locator('.composer .attachment-card')).not.toContainText('/project');
    await input.evaluate((e) => {
      const data = new DataTransfer();
      data.setData(
        'application/x-session-file',
        JSON.stringify({ sessionId: 'basic', relativePath: 'src/notes.txt' }),
      );
      e.dispatchEvent(
        new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }),
      );
    });
    await expect(input).toHaveValue('Keep this \u200E@File 1 ');
    expect(actions).toEqual([]);
    await page.getByLabel('Search mode').selectOption('content');
    await page.getByRole('textbox', { name: 'Search files' }).fill('needle');
    await expect(page.getByText('Bounded content search', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close files', exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('button', { name: 'Discuss first', exact: true }).click();
    await expect.poll(() => actions.length).toBe(1);
    expect(actions[0]).toMatchObject({
      type: 'discuss',
      text: 'Keep this @File 1 ',
      attachmentIds: ['ref'],
    });
  });
test('failed Attach is visible and preserves text; successful delayed Attach preserves new typing', async ({
  page,
}) => {
  const snapshot = basicSnapshot();
  await mockSession(page, () => snapshot);
  let fail = true;
  let release: (() => void) | undefined;
  const ref = {
    id: 'ref',
    sessionId: 'basic',
    kind: 'file',
    index: 1,
    name: 'notes.txt',
    path: '/project/notes.txt',
    originalPath: 'notes.txt',
    worktreePath: '/project',
    source: 'worktree',
    mime: 'text/plain',
    size: 4,
  };
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route('**/files/search?*', (r) =>
    r.fulfill({ json: [{ name: 'notes.txt', relativePath: 'notes.txt' }] }),
  );
  await page.route('**/files/preview?*', (r) =>
    r.fulfill({
      json: { name: 'notes.txt', relativePath: 'notes.txt', state: 'text', text: 'safe', size: 4 },
    }),
  );
  await page.route('**/files/reference', async (r) => {
    if (fail) return r.fulfill({ status: 400, json: { error: 'File vanished' } });
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return r.fulfill({ json: ref });
  });
  await page.route('**/files/*/metadata', (r) => r.fulfill({ json: ref }));
  await page.goto('/#capability=test');
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.fill('Use @note');
  await expect(page.locator('.file-picker [role=option]')).toHaveCount(1);
  await input.press('Enter');
  const preview = page
    .getByRole('dialog', { name: 'File preview' })
    .locator('.files-window-preview');
  await preview.getByRole('button', { name: 'Attach file', exact: true }).click();
  await expect(preview.getByRole('alert')).toContainText('File vanished');
  await expect(input).toHaveValue('Use @note');
  await expect(page.locator('.composer .attachment-card')).toHaveCount(0);
  fail = false;
  await preview.getByRole('button', { name: 'Attach file', exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.getByRole('button', { name: 'Close file preview' }).click();
  await input.fill('New wording @notebook');
  release!();
  await expect(input).toHaveValue('New wording @notebook \u200E@File 1 ');
  await expect(page.locator('.composer .attachment-card')).toHaveCount(1);
});
test('sidebar drag carries relative session identity and attaches image reference without sending', async ({
  page,
}) => {
  const snapshot = basicSnapshot();
  await mockSession(page, () => snapshot);
  let registered = 0;
  const actions: any[] = [];
  const ref = {
    id: 'image',
    sessionId: 'basic',
    kind: 'image',
    index: 3,
    name: 'picture.png',
    path: '/project/picture.png',
    originalPath: 'picture.png',
    worktreePath: '/project',
    source: 'worktree',
    mime: 'image/png',
    size: 1,
  };
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route('**/files/browse?*', (r) =>
    r.fulfill({
      json: {
        entries: [{ name: 'picture.png', relativePath: 'picture.png', kind: 'file' }],
        limited: false,
      },
    }),
  );
  await page.route('**/files/reference', (r) => {
    registered++;
    expect(r.request().postDataJSON()).toEqual({ relativePath: 'picture.png' });
    return r.fulfill({ json: ref });
  });
  await page.route('**/files/*/metadata', (r) => r.fulfill({ json: ref }));
  await page.route('**/files/*/content', (r) => r.fulfill({ status: 404, body: '' }));
  await page.route('**/actions', (r) => {
    actions.push(r.request().postDataJSON());
    return r.fulfill({ json: { sessionId: snapshot.id, sequence: 2, snapshot } });
  });
  await page.goto('/#capability=test');
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.fill('Inspect');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  const row = page.getByRole('button', { name: 'Preview picture.png' });
  const payload = await row.evaluate((e) => {
    const data = new DataTransfer();
    e.dispatchEvent(new DragEvent('dragstart', { dataTransfer: data, bubbles: true }));
    return data.getData('application/x-session-file');
  });
  expect(JSON.parse(payload)).toEqual({ sessionId: 'basic', relativePath: 'picture.png' });
  const drop = async (value: string) =>
    input.evaluate((e, payload) => {
      const data = new DataTransfer();
      data.setData('application/x-session-file', payload);
      e.dispatchEvent(
        new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }),
      );
    }, value);
  await drop(JSON.stringify({ sessionId: 'other', relativePath: 'picture.png' }));
  await expect(page.getByRole('alert')).toContainText('this session');
  expect(registered).toBe(0);
  await expect(input).toHaveValue('Inspect');
  await drop(payload);
  await expect(input).toHaveValue('Inspect \u200E@Image 3 ');
  await expect(page.locator('.composer .attachment-card')).toContainText('Image 3');
  expect(actions).toEqual([]);
  await input.press('Enter');
  await expect.poll(() => actions.length).toBe(1);
  expect(actions[0]).toMatchObject({ text: 'Inspect @Image 3 ', attachmentIds: ['image'] });
});
test('late preview and attachment responses stay with their originating session', async ({
  page,
}) => {
  const records = ['A', 'B'].map((id) => ({
    id,
    target: { agent: 'codex', sessionRef: id, projectId: '/project/' + id },
    canonicalRoot: '/project/' + id,
    projectName: id,
    enabled: true,
  }));
  const workspaces: any = {};
  let attachRelease: (() => void) | undefined, previewRelease: (() => void) | undefined;
  let slowPreview = false;
  const ref = {
    id: 'A-ref',
    sessionId: 'A',
    kind: 'file',
    index: 1,
    name: 'notes.txt',
    path: '/project/A/notes.txt',
    originalPath: 'notes.txt',
    worktreePath: '/project/A',
    source: 'worktree',
    mime: 'text/plain',
    size: 5,
  };
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
    if (path.endsWith('/files/browse'))
      return r.fulfill({
        json: {
          entries: [{ name: 'notes.txt', relativePath: 'notes.txt', kind: 'file' }],
          limited: false,
        },
      });
    if (path.endsWith('/files/preview')) {
      if (slowPreview)
        await new Promise<void>((resolve) => {
          previewRelease = resolve;
        });
      return r
        .fulfill({
          json: {
            name: 'notes.txt',
            relativePath: 'notes.txt',
            state: 'text',
            text: 'Preview ' + id,
            size: 5,
          },
        })
        .catch(() => {});
    }
    if (path.endsWith('/files/reference')) {
      await new Promise<void>((resolve) => {
        attachRelease = resolve;
      });
      return r.fulfill({ json: ref });
    }
    if (path.endsWith('/metadata')) return r.fulfill({ json: ref });
    return r.fulfill({ status: 404, json: { error: 'Unexpected route' } });
  });
  await page.goto('/#capability=test');
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.fill('A draft');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'Preview notes.txt' }).click();
  await page.getByRole('button', { name: 'Attach file', exact: true }).click();
  await expect.poll(() => Boolean(attachRelease)).toBe(true);
  await page
    .getByRole('dialog', { name: 'File preview' })
    .getByRole('button', { name: 'Close file preview' })
    .click();
  await selectSession(page, 'B');
  await input.fill('B draft');
  attachRelease!();
  await expect.poll(() => workspaces.A?.data.composer).toBe('A draft \u200E@File 1 ');
  await expect(input).toHaveValue('B draft');
  await expect(page.locator('.composer .attachment-card')).toHaveCount(0);
  await expect(input).toBeFocused();
  await selectSession(page, 'A');
  await expect(input).toHaveValue('A draft \u200E@File 1 ');
  slowPreview = true;
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'Preview notes.txt' }).click();
  await expect.poll(() => Boolean(previewRelease)).toBe(true);
  await page
    .getByRole('dialog', { name: 'File preview' })
    .getByRole('button', { name: 'Close file preview' })
    .click();
  await selectSession(page, 'B');
  previewRelease!();
  await expect(input).toHaveValue('B draft');
  await expect(page.getByRole('dialog', { name: 'File preview' })).toHaveCount(0);
  await expect(page.getByText('Preview A', { exact: true })).toHaveCount(0);
});
test('cards compact legacy internal absolute paths and never label managed copies as originals', async ({
  page,
}) => {
  const base = {
    sessionId: 'basic',
    kind: 'file',
    mime: 'text/plain',
    size: 1,
    worktreePath: '/project',
  };
  const files = [
    {
      ...base,
      id: 'internal',
      index: 1,
      name: 'inside.txt',
      path: '/project/src/inside.txt',
      originalPath: '/project/src/inside.txt',
      source: 'worktree',
    },
    {
      ...base,
      id: 'managed',
      index: 2,
      name: 'uploaded.txt',
      path: '/project/.uploads/uuid',
      originalPath: '/project/.uploads/uuid',
      source: 'upload',
    },
    {
      ...base,
      id: 'external',
      index: 3,
      name: 'external.txt',
      path: '/managed/other',
      originalPath: '/external/external.txt',
      source: 'upload',
    },
  ];
  const snapshot: any = {
    ...basicSnapshot(),
    discussion: [{ role: 'assistant', text: 'Files', attachments: files }],
  };
  await mockSession(page, () => snapshot);
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route('**/files/*/metadata', (r) =>
    r.fulfill({
      json: {
        ...files.find((f) => r.request().url().includes(f.id)),
        contentStatus: { state: 'readable' },
      },
    }),
  );
  await page.goto('/#capability=test');
  const cards = page.locator('.discussion .attachment-card');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText('src/inside.txt');
  await expect(cards.nth(0)).not.toContainText('/project');
  await expect(cards.nth(1)).not.toContainText('.uploads');
  await expect(cards.nth(2)).toContainText('/external/external.txt');
  await expect(cards.nth(2)).not.toContainText('/managed');
});
