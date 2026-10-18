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

/** The docked column: the only file list. */
const fileColumn = (page: Page) =>
  page.locator('.file-workspace').getByRole('complementary', { name: 'Session files' });

/** Opens the Files column and, from it, the popup on one file. */
async function openFilePopup(page: Page, name = 'a.md') {
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await fileColumn(page)
    .getByRole('button', { name: `Preview ${name}`, exact: true })
    .click();
  return page.getByRole('dialog', { name: 'File preview' });
}

test('Files opens the only list; a file opens the popup, which swaps, moves, expands, and remembers', async ({
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
  const win = page.getByRole('dialog', { name: 'File preview' });
  await expect(win).toHaveCount(0);
  const rowA = column.getByRole('button', { name: 'Preview a.md', exact: true });
  await rowA.click();
  await expect(win).toHaveAttribute('aria-modal', 'false');
  await expect(win.locator('.files-window-title strong')).toHaveText('a.md');
  await expect(win.locator('.files-window-preview')).toContainText('content of a.md');
  // The popup shows only the file: the column is the single list, and stays visible beside it.
  await expect(win.locator('.file-sidebar')).toHaveCount(0);
  await expect(page.locator('aside.file-sidebar')).toHaveCount(1);
  await expect(column).toBeVisible();
  await column.getByRole('button', { name: 'Preview b.md', exact: true }).click();
  await expect(win).toHaveCount(1);
  await expect(win.locator('.files-window-title strong')).toHaveText('b.md');
  await expect(win.locator('.files-window-preview')).toContainText('content of b.md');
  await expect(win.locator('.files-window-preview')).not.toContainText('content of a.md');
  await expect(column).toBeVisible();

  const before = (await win.boundingBox())!;
  // The default 760x620 window is centred over the agent area beside the column, narrowed to fit it.
  const agentArea = (await page.locator('main.app').boundingBox())!;
  const defaultWidth = Math.min(760, Math.round(agentArea.width));
  const defaultHeight = Math.min(620, Math.round(agentArea.height));
  expect(Math.round(before.width)).toBe(defaultWidth);
  expect(Math.round(before.height)).toBe(defaultHeight);
  expect(Math.round(before.x)).toBe(Math.round(agentArea.x + (agentArea.width - defaultWidth) / 2));
  expect(Math.round(before.y)).toBe(
    Math.round(agentArea.y + (agentArea.height - defaultHeight) / 2),
  );
  const title = (await win.locator('.files-window-title').boundingBox())!;
  // It sits about 130px down an 800px viewport and stays fully inside it, so 40px down is within its room.
  const start = { x: title.x + title.width / 2, y: title.y + title.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 150, start.y + 40, { steps: 5 });
  await page.mouse.up();
  const moved = (await win.boundingBox())!;
  expect(Math.round(moved.x - before.x)).toBe(-150);
  expect(Math.round(moved.y - before.y)).toBe(40);

  const expand = win.getByRole('button', { name: 'Expand', exact: true });
  await expect(expand).toHaveAttribute('aria-pressed', 'false');
  await expand.click();
  await expect(win).toHaveAttribute('data-expanded', 'true');
  // Expanded fills the viewport beside the column, top to bottom.
  const docked = (await column.boundingBox())!;
  const expandedBox = (await win.boundingBox())!;
  expect(Math.abs(expandedBox.x - (docked.x + docked.width))).toBeLessThanOrEqual(1);
  expect(expandedBox).toMatchObject({ y: 0, height: 800 });
  expect(Math.round(expandedBox.x + expandedBox.width)).toBe(1280);
  await expect(win.getByRole('button', { name: 'Collapse', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(win).toHaveAttribute('data-expanded', 'false');
  expect((await win.boundingBox())!).toMatchObject({ x: moved.x, y: moved.y });
  await page.keyboard.press('Escape');
  // Closing the popup leaves the column open and returns focus to the row that first opened it.
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

  // On the right the column follows the workspace in the DOM too, so Tab reaches the workspace first.
  expect(
    await page.evaluate(() => {
      const main = document.querySelector('.file-workspace > main.app')!;
      const aside = document.querySelector('.file-workspace > aside')!;
      return Boolean(main.compareDocumentPosition(aside) & Node.DOCUMENT_POSITION_FOLLOWING);
    }),
  ).toBe(true);
  const border = await column.evaluate((e) => {
    const style = getComputedStyle(e);
    return { left: style.borderLeftWidth, right: style.borderRightWidth };
  });
  expect(border).toEqual({ left: '1px', right: '0px' });

  await page.reload();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page.locator('.file-workspace')).toHaveAttribute('data-side', 'right');
  expect((await column.boundingBox())!.x).toBeGreaterThan((await app.boundingBox())!.x);
  // A popup opened on the right sits beside the column, and follows the agent area when the side flips.
  await column.getByRole('button', { name: 'Preview a.md', exact: true }).click();
  const win = page.getByRole('dialog', { name: 'File preview' });
  await expect(win.locator('.files-window-preview')).toContainText('content of a.md');
  let box = (await column.boundingBox())!;
  let popup = (await win.boundingBox())!;
  expect(Math.round(popup.x + popup.width)).toBeLessThanOrEqual(Math.round(box.x));
  await column.getByRole('button', { name: 'Move files to the left', exact: true }).click();
  expect((await column.boundingBox())!.x).toBeLessThan((await app.boundingBox())!.x);
  await expect(
    column.getByRole('button', { name: 'Move files to the right', exact: true }),
  ).toBeFocused();
  box = (await column.boundingBox())!;
  await expect
    .poll(async () => Math.round((await win.boundingBox())!.x))
    .toBeGreaterThanOrEqual(Math.round(box.x + box.width));
  popup = (await win.boundingBox())!;
  expect(popup.x + popup.width).toBeLessThanOrEqual(1280);
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
  const win = page.getByRole('dialog', { name: 'File preview' });
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
  // The default popup sits beside the column, so the column's × is clickable with the mouse.
  const close = fileColumn(page).getByRole('button', { name: 'Close files', exact: true });
  const box = (await close.boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  expect(
    await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('aria-label'),
      centre,
    ),
  ).toBe('Close files');
  await page.mouse.click(centre.x, centre.y);
  await expect(win).toHaveCount(0);
  await expect(fileColumn(page)).toHaveCount(0);
  await expect(filesButton).toBeFocused();
  await expect(filesButton).toHaveAttribute('aria-expanded', 'false');

  // Reopened, the column comes back alone: the last file does not pop up again.
  await filesButton.click();
  await expect(fileColumn(page)).toBeVisible();
  await expect(win).toHaveCount(0);

  // The Files button closes both too, and the popup does not cover it.
  await fileColumn(page).getByRole('button', { name: 'Preview b.md', exact: true }).click();
  await expect(win.locator('.files-window-preview')).toContainText('content of b.md');
  await filesButton.click();
  await expect(win).toHaveCount(0);
  await expect(fileColumn(page)).toHaveCount(0);
  await expect(filesButton).toBeFocused();
});

test('Escape closes the popup after a swap from the column, but not from the column search', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockFiles(page);
  await page.goto('/#capability=test');
  const win = await openFilePopup(page);
  const column = fileColumn(page);
  await expect(win.locator('.files-window-preview')).toContainText('content of a.md');
  const rowB = column.getByRole('button', { name: 'Preview b.md', exact: true });
  await rowB.click();
  await expect(win.locator('.files-window-preview')).toContainText('content of b.md');
  // Swapping does not move focus: keyboard users keep browsing the column.
  await expect(rowB).toBeFocused();

  // Escape typed in the column's search box belongs to the input, not to the popup.
  const search = column.getByRole('textbox', { name: 'Search files' });
  await search.click();
  await search.press('Escape');
  await expect(win).toHaveCount(1);

  await rowB.focus();
  await page.keyboard.press('Escape');
  await expect(win).toHaveCount(0);
  await expect(column).toBeVisible();
  // Focus returns to the opener kept since the popup opened: the a.md row.
  await expect(column.getByRole('button', { name: 'Preview a.md', exact: true })).toBeFocused();
});

test('a moved popup keeps its place across swaps and Expand; expanded it leaves the column uncovered', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockFiles(page);
  await page.goto('/#capability=test');
  const win = await openFilePopup(page);
  const column = fileColumn(page);
  const title = (await win.locator('.files-window-title').boundingBox())!;
  const start = { x: title.x + title.width / 2, y: title.y + title.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 60, start.y + 20, { steps: 5 });
  await page.mouse.up();
  const moved = (await win.boundingBox())!;

  await column.getByRole('button', { name: 'Preview b.md', exact: true }).click();
  await expect(win.locator('.files-window-preview')).toContainText('content of b.md');
  expect(await win.boundingBox()).toEqual(moved);

  await win.getByRole('button', { name: 'Expand', exact: true }).click();
  await expect(win).toHaveAttribute('data-expanded', 'true');
  const box = (await column.boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const hit = ({ x, y }: { x: number; y: number }) => {
    const element = document.elementFromPoint(x, y);
    return element?.closest('.files-window')
      ? 'popup'
      : element?.closest('.file-workspace > aside')
        ? 'column'
        : 'other';
  };
  expect(await page.evaluate(hit, centre)).toBe('column');
  let popup = (await win.boundingBox())!;
  expect(Math.abs(popup.x - (box.x + box.width))).toBeLessThanOrEqual(1);

  // Flipped to the right while expanded, the popup ends at the column's left edge.
  await column.getByRole('button', { name: 'Move files to the right', exact: true }).click();
  await expect(page.locator('.file-workspace')).toHaveAttribute('data-side', 'right');
  const right = (await column.boundingBox())!;
  await expect
    .poll(async () => {
      const b = (await win.boundingBox())!;
      return Math.abs(b.x + b.width - right.x) <= 1 && Math.round(b.x) === 0;
    })
    .toBe(true);
  expect(
    await page.evaluate(hit, { x: right.x + right.width / 2, y: right.y + right.height / 2 }),
  ).toBe('column');
  await column.getByRole('button', { name: 'Move files to the left', exact: true }).click();
  await expect
    .poll(async () => Math.round((await win.boundingBox())!.x))
    .toBe(Math.round(box.x + box.width));

  // Escape from the column's side button still reaches the popup: it collapses to the moved rectangle.
  await page.keyboard.press('Escape');
  await expect(win).toHaveAttribute('data-expanded', 'false');
  popup = (await win.boundingBox())!;
  expect(popup).toEqual(moved);
});

test('an expanded popup without the column fills the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockFiles(page);
  await page.route('**/files/search?*', (r) =>
    r.fulfill({ json: [{ name: 'a.md', relativePath: 'a.md' }] }),
  );
  await page.goto('/#capability=test');
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.fill('@a');
  await expect(page.locator('.file-picker [role=option]')).toHaveCount(1);
  await input.press('Enter');
  const win = page.getByRole('dialog', { name: 'File preview' });
  await expect(win.locator('.files-window-preview')).toContainText('content of a.md');
  await expect(fileColumn(page)).toHaveCount(0);
  await win.getByRole('button', { name: 'Expand', exact: true }).click();
  expect(await win.boundingBox()).toMatchObject({ x: 0, y: 0, width: 1280, height: 800 });
});

test('the resize grip changes the popup and the size is remembered', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockFiles(page);
  await page.goto('/#capability=test');
  const win = await openFilePopup(page);
  await expect(win.getByRole('separator')).toHaveCount(0);
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
  // The preview pane fills the body below the title bar.
  const pane = (await win.locator('.files-window-preview').boundingBox())!;
  expect(Math.round(pane.width)).toBe(Math.round(resized.width - 2));

  await page.reload();
  const restored = (await (await openFilePopup(page)).boundingBox())!;
  expect(Math.round(restored.width)).toBe(Math.round(resized.width));
  expect(Math.round(restored.height)).toBe(Math.round(resized.height));
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
  await fileColumn(page).getByRole('button', { name: 'Preview b.md', exact: true }).click();
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
