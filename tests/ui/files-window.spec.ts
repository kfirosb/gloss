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

test('files window keeps the list beside the preview, moves, expands, and remembers', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockFiles(page);
  await page.goto('/#capability=test');
  const filesButton = page.getByRole('button', { name: 'Files', exact: true });
  await filesButton.click();
  const win = page.getByRole('dialog', { name: 'Files' });
  await expect(win).toHaveAttribute('aria-modal', 'false');
  await expect(win).toContainText('Select a file to preview');
  await win.getByRole('button', { name: 'Preview a.md', exact: true }).click();
  await expect(win.locator('.files-window-preview')).toContainText('content of a.md');
  await win.getByRole('button', { name: 'Preview b.md', exact: true }).click();
  await expect(win.locator('.files-window-preview')).toContainText('content of b.md');
  await expect(win.locator('.files-window-preview')).not.toContainText('content of a.md');
  await expect(win.locator('.files-window-list')).toBeVisible();

  const before = (await win.boundingBox())!;
  const title = (await win.locator('.files-window-title').boundingBox())!;
  // The default 900x620 window sits at y=90 in an 800px viewport and stays fully inside it, so 80px down is the room it has.
  const start = { x: title.x + title.width / 2, y: title.y + title.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 150, start.y + 80, { steps: 5 });
  await page.mouse.up();
  const moved = (await win.boundingBox())!;
  expect(Math.round(moved.x - before.x)).toBe(150);
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
  await expect(win).toHaveCount(0);
  await expect(filesButton).toBeFocused();

  await filesButton.click();
  await expect(win.locator('.files-window-preview')).toContainText('content of b.md');
  await page.keyboard.press('Escape');
  await expect(win).toHaveCount(0);

  await page.reload();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  const restored = (await page.getByRole('dialog', { name: 'Files' }).boundingBox())!;
  expect(Math.round(restored.x)).toBe(Math.round(moved.x));
  expect(Math.round(restored.y)).toBe(Math.round(moved.y));
});

test('split handle and resize grip change the window and the split is keyboard operable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockFiles(page);
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  const win = page.getByRole('dialog', { name: 'Files' });
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
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  const box = (await page.getByRole('dialog', { name: 'Files' }).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1280);
  expect(box.y + box.height).toBeLessThanOrEqual(800);
});

test('a TL;DR still loading for one file never lands on the next file', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockFiles(page);
  await page.route('**/files/review-status?*', (r) =>
    r.fulfill({ json: { summary: false, translation: false } }),
  );
  let heldReview: Route | undefined;
  const reviewRequested = new Promise<void>((resolve) => {
    void page.route('**/files/review', (r) => {
      heldReview = r;
      resolve();
    });
  });
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  const win = page.getByRole('dialog', { name: 'Files' });
  const preview = win.locator('.files-window-preview');
  await win.getByRole('button', { name: 'Preview a.md', exact: true }).click();
  await expect(preview).toContainText('content of a.md');
  await preview.getByRole('button', { name: 'TL;DR' }).click();
  await reviewRequested;

  await win.getByRole('button', { name: 'Preview b.md', exact: true }).click();
  await expect(preview).toContainText('content of b.md');

  await heldReview!.fulfill({ json: { path: 'a.md', mode: 'summary', text: 'summary of a' } });
  await expect(preview).toContainText('content of b.md');
  await expect(preview).not.toContainText('summary of a');
  await expect(preview.getByRole('button', { name: 'Show original' })).toHaveCount(0);
  await expect(preview.getByRole('button', { name: 'TL;DR' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});
