import { test, expect, type Page, type Route } from '@playwright/test';
import { mockSession, basicSnapshot } from './session-fixture.js';

async function mockFiles(page: Page) {
  const snapshot = basicSnapshot();
  await mockSession(page, () => snapshot);
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route('**/files/browse?*', (r) =>
    r.fulfill({
      json: {
        entries: [
          { name: 'a.md', relativePath: 'a.md', kind: 'file' },
          { name: 'b.md', relativePath: 'b.md', kind: 'file' },
        ],
        limited: false,
      },
    }),
  );
  await page.route('**/files/preview?*', (r) => {
    const path = new URL(r.request().url()).searchParams.get('path') ?? '';
    return r.fulfill({
      json: { name: path, relativePath: path, state: 'text', size: 20, text: 'content of ' + path },
    });
  });
}

/** The docked column, as opposed to the copy of the list inside the popup. */
const fileColumn = (page: Page) =>
  page.locator('.file-workspace').getByRole('complementary', { name: 'Session files' });

/** Opens the Files column and, from it, the popup on one file. */
async function openFilePopup(page: Page, name = 'a.md') {
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await fileColumn(page)
    .getByRole('button', { name: `Preview ${name}`, exact: true })
    .click();
  return page.getByRole('dialog', { name: 'Files' });
}

test('Files opens the column; a file opens the popup, which moves, expands, and remembers', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockFiles(page);
  await page.goto('/#capability=test');
  const filesButton = page.getByRole('button', { name: 'Files', exact: true });
  await filesButton.click();
  const column = fileColumn(page);
  await expect(column).toBeVisible();
  await expect(filesButton).toHaveAttribute('aria-expanded', 'true');
  const win = page.getByRole('dialog', { name: 'Files' });
  await expect(win).toHaveCount(0);
  const rowA = column.getByRole('button', { name: 'Preview a.md', exact: true });
  await rowA.click();
  await expect(win).toHaveAttribute('aria-modal', 'false');
  await expect(win.locator('.files-window-preview')).toContainText('content of a.md');
  await win.getByRole('button', { name: 'Preview b.md', exact: true }).click();
  await expect(win.locator('.files-window-preview')).toContainText('content of b.md');
  await expect(win.locator('.files-window-preview')).not.toContainText('content of a.md');
  await expect(win.locator('.files-window-list')).toBeVisible();

  const before = (await win.boundingBox())!;
  // The default 900x620 window is centred over the agent column, not the whole viewport.
  const agentColumn = (await page.locator('.session-column').boundingBox())!;
  expect(Math.round(before.x)).toBe(Math.round(agentColumn.x + (agentColumn.width - 900) / 2));
  expect(Math.round(before.y)).toBe(Math.round(agentColumn.y + (agentColumn.height - 620) / 2));
  const title = (await win.locator('.files-window-title').boundingBox())!;
  // It sits at y=90 in an 800px viewport and stays fully inside it, so 80px down is the room it has.
  const start = { x: title.x + title.width / 2, y: title.y + title.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 150, start.y + 80, { steps: 5 });
  await page.mouse.up();
  const moved = (await win.boundingBox())!;
  expect(Math.round(moved.x - before.x)).toBe(-150);
  expect(Math.round(moved.y - before.y)).toBe(80);

  const expand = win.getByRole('button', { name: 'Expand', exact: true });
  await expect(expand).toHaveAttribute('aria-pressed', 'false');
  await expand.click();
  await expect(win).toHaveAttribute('data-expanded', 'true');
  expect(await win.boundingBox()).toMatchObject({ x: 0, y: 0, width: 1280, height: 800 });
  await expect(win.getByRole('button', { name: 'Collapse', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(win.locator('.files-window-list')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(win).toHaveAttribute('data-expanded', 'false');
  expect((await win.boundingBox())!).toMatchObject({ x: moved.x, y: moved.y });
  await page.keyboard.press('Escape');
  // Closing the popup leaves the column open and returns focus to the row that opened it.
  await expect(win).toHaveCount(0);
  await expect(column).toBeVisible();
  await expect(rowA).toBeFocused();

  await column.getByRole('button', { name: 'Preview b.md', exact: true }).click();
  await expect(win.locator('.files-window-preview')).toContainText('content of b.md');
  await page.keyboard.press('Escape');
  await expect(win).toHaveCount(0);
  await column.getByRole('button', { name: 'Close files', exact: true }).click();
  await expect(column).toHaveCount(0);
  await expect(filesButton).toBeFocused();
  await expect(filesButton).toHaveAttribute('aria-expanded', 'false');

  await page.reload();
  const restored = (await (await openFilePopup(page)).boundingBox())!;
  expect(Math.round(restored.x)).toBe(Math.round(moved.x));
  expect(Math.round(restored.y)).toBe(Math.round(moved.y));
});

test('the Files column moves to the right and stays there after reload', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockFiles(page);
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  const column = fileColumn(page);
  const app = page.locator('main.app');
  expect((await column.boundingBox())!.x).toBeLessThan((await app.boundingBox())!.x);
  await column.getByRole('button', { name: 'Move files to the right', exact: true }).click();
  await expect(page.locator('.file-workspace')).toHaveAttribute('data-side', 'right');
  expect((await column.boundingBox())!.x).toBeGreaterThan((await app.boundingBox())!.x);
  await expect(
    column.getByRole('button', { name: 'Move files to the left', exact: true }),
  ).toBeFocused();

  await page.reload();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page.locator('.file-workspace')).toHaveAttribute('data-side', 'right');
  expect((await column.boundingBox())!.x).toBeGreaterThan((await app.boundingBox())!.x);
  await column.getByRole('button', { name: 'Move files to the left', exact: true }).click();
  expect((await column.boundingBox())!.x).toBeLessThan((await app.boundingBox())!.x);
});

test('on a narrow viewport the column floats at its edge, under the popup', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await mockFiles(page);
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  const column = fileColumn(page);
  expect(Math.round((await column.boundingBox())!.x)).toBe(8);
  await column.getByRole('button', { name: 'Move files to the right', exact: true }).click();
  const right = (await column.boundingBox())!;
  expect(Math.round(right.x + right.width)).toBe(800 - 8);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await column.getByRole('button', { name: 'Preview a.md', exact: true }).click();
  const win = page.getByRole('dialog', { name: 'Files' });
  await expect(win.locator('.files-window-preview')).toContainText('content of a.md');
  // Where the two overlap, the popup is on top.
  const point = { x: right.x + right.width / 2, y: right.y + right.height / 2 };
  expect(
    await page.evaluate(
      ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.files-window')),
      point,
    ),
  ).toBe(true);
});

test('closing the Files column closes the popup and forgets its file', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockFiles(page);
  await page.goto('/#capability=test');
  const filesButton = page.getByRole('button', { name: 'Files', exact: true });
  const win = await openFilePopup(page);
  await expect(win.locator('.files-window-preview')).toContainText('content of a.md');
  // The default popup covers the column's header and the Files button, so both are pressed from the keyboard.
  await fileColumn(page).getByRole('button', { name: 'Close files', exact: true }).press('Enter');
  await expect(win).toHaveCount(0);
  await expect(fileColumn(page)).toHaveCount(0);
  await expect(filesButton).toBeFocused();
  await expect(filesButton).toHaveAttribute('aria-expanded', 'false');

  // Reopened, the column comes back alone: the last file does not pop up again.
  await filesButton.click();
  await expect(fileColumn(page)).toBeVisible();
  await expect(win).toHaveCount(0);

  // The Files button closes both too.
  await fileColumn(page).getByRole('button', { name: 'Preview b.md', exact: true }).click();
  await expect(win.locator('.files-window-preview')).toContainText('content of b.md');
  await filesButton.press('Enter');
  await expect(win).toHaveCount(0);
  await expect(fileColumn(page)).toHaveCount(0);
  await expect(filesButton).toBeFocused();
});

test('split handle and resize grip change the window and the split is keyboard operable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockFiles(page);
  await page.goto('/#capability=test');
  const win = await openFilePopup(page);
  const list = win.locator('.files-window-list');
  const split = win.getByRole('separator');
  await expect(split).toHaveAttribute('aria-orientation', 'vertical');
  const listBefore = (await list.boundingBox())!.width;
  await split.focus();
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(async () => Math.round((await list.boundingBox())!.width))
    .toBe(Math.round(listBefore + 20));
  await page.keyboard.press('Home');
  await expect(split).toHaveAttribute('aria-valuenow', '160');

  const before = (await win.boundingBox())!;
  const grip = (await win.locator('.files-window-resize').boundingBox())!;
  const start = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 100, start.y - 60, { steps: 5 });
  await page.mouse.up();
  const resized = (await win.boundingBox())!;
  expect(Math.round(before.width - resized.width)).toBe(100);
  expect(Math.round(before.height - resized.height)).toBe(60);

  // Expanded, the split may pass the collapsed maximum (800 - 240 = 560) and stays there after release.
  await win.getByRole('button', { name: 'Expand', exact: true }).click();
  const handle = (await split.boundingBox())!;
  const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 740, from.y, { steps: 5 });
  await page.mouse.up();
  await expect(split).toHaveAttribute('aria-valuenow', '900');
  expect(Math.round((await list.boundingBox())!.width)).toBe(900);
  await split.focus();
  await page.keyboard.press('End');
  await expect(split).toHaveAttribute('aria-valuemax', '1040');
  await expect(split).toHaveAttribute('aria-valuenow', '1040');
  expect(Math.round((await list.boundingBox())!.width)).toBe(1040);
});

test('an off-screen saved window opens fully inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockFiles(page);
  await page.addInitScript(() => {
    localStorage.setItem(
      'language-assistant:display:v1',
      JSON.stringify({
        version: 1,
        collapsed: false,
        assistantModes: { basic: 'full' },
        lastByFolder: {},
        tabOrder: {},
        filesWindow: { x: 5000, y: 5000, width: 900, height: 620, split: 270 },
      }),
    );
  });
  await page.goto('/#capability=test');
  const box = (await (await openFilePopup(page)).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1280);
  expect(box.y + box.height).toBeLessThanOrEqual(800);
});

test('a TL;DR still loading for one file never lands on the next file', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockFiles(page);
  let heldReview: Route | undefined;
  let reviewHeld!: () => void;
  const reviewRequested = new Promise<void>((resolve) => {
    reviewHeld = resolve;
  });
  await page.route('**/files/review', (r) => {
    heldReview = r;
    reviewHeld();
  });
  await page.goto('/#capability=test');
  const win = await openFilePopup(page);
  const preview = win.locator('.files-window-preview');
  await expect(preview).toContainText('content of a.md');
  await preview.getByRole('button', { name: 'TL;DR' }).click();
  await reviewRequested;

  const aborted = page.waitForEvent('requestfailed', (request) =>
    new URL(request.url()).pathname.endsWith('/files/review'),
  );
  await win.getByRole('button', { name: 'Preview b.md', exact: true }).click();
  await expect(preview).toContainText('content of b.md');
  // Switching files unmounts FileReview, which aborts its request: the response is aborted, not delivered.
  await aborted;

  // Fulfilling an already-aborted request may be refused by the browser; either way nothing may reach b.md.
  await heldReview!
    .fulfill({ json: { path: 'a.md', mode: 'summary', text: 'summary of a' } })
    .catch(() => undefined);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await expect(preview).toContainText('content of b.md');
  await expect(preview).not.toContainText('summary of a');
  await expect(preview.getByRole('button', { name: 'Show original' })).toHaveCount(0);
  await expect(preview.getByRole('button', { name: 'TL;DR' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});

test('attach outcomes stay in the preview pane and clear when the popup closes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockFiles(page);
  const file = {
    id: 'file-1',
    sessionId: 'basic',
    kind: 'file',
    index: 1,
    name: 'a.md',
    path: '/project/a.md',
    originalPath: 'a.md',
    worktreePath: '/project',
    source: 'worktree',
    mime: 'text/markdown',
    size: 20,
  };
  let references = 0;
  await page.route('**/files/reference', (r) =>
    ++references === 1
      ? r.fulfill({ status: 400, json: { error: 'Reference failed' } })
      : r.fulfill({ json: file }),
  );
  await page.route('**/files/*/metadata', (r) => r.fulfill({ json: file }));
  await page.goto('/#capability=test');
  const win = await openFilePopup(page);
  const attach = win.getByRole('button', { name: 'Attach file', exact: true });
  await attach.click();
  await expect(win.getByRole('alert')).toHaveText('Reference failed');
  // Announced once, in the pane, not again as a workspace error.
  await expect(page.getByRole('alert').filter({ hasText: 'Reference failed' })).toHaveCount(1);
  await attach.click();
  await expect(win.getByRole('status')).toHaveText('Attached as File 1');
  await expect(win.getByRole('alert')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(win).toHaveCount(0);
  await fileColumn(page).getByRole('button', { name: 'Preview a.md', exact: true }).click();
  await expect(win.locator('.files-window-preview')).toContainText('content of a.md');
  await expect(win.getByText('Attached as File 1')).toHaveCount(0);
});
