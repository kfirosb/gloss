import { test, expect, type Page } from '@playwright/test';
import { mockSession, basicSnapshot } from './session-fixture.js';

type Calls = { install: number; check: number };
type Stubbed = Window & {
  __calls: Calls;
  __push(state: unknown): void;
};

/** Stubs the desktop update bridge; `afterCheck` is the state a manual check pushes. */
async function setup(
  page: Page,
  initial: unknown,
  withBridge = true,
  afterCheck?: unknown,
  slowInitial?: unknown,
) {
  const snapshot = basicSnapshot();
  await mockSession(page, () => snapshot);
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route('**/api/about', (r) =>
    r.fulfill({ json: { name: 'gloss', version: '0.21.0', platform: 'darwin', arch: 'arm64' } }),
  );
  await page.addInitScript(
    ({ initial, withBridge, afterCheck, slowInitial }) => {
      if (!withBridge) return;
      const w = window as unknown as Stubbed;
      const host = window as unknown as { gloss: unknown };
      const listeners = new Set<(s: unknown) => void>();
      w.__calls = { install: 0, check: 0 };
      w.__push = (s) => listeners.forEach((l) => l(s));
      host.gloss = {
        updates: {
          onState: (cb: (s: unknown) => void) => {
            listeners.add(cb);
            return () => listeners.delete(cb);
          },
          state: () =>
            slowInitial
              ? new Promise((resolve) => setTimeout(() => resolve(slowInitial), 400))
              : Promise.resolve(initial),
          check: async () => {
            w.__calls.check++;
            if (afterCheck) w.__push(afterCheck);
          },
          install: async () => {
            w.__calls.install++;
          },
        },
      };
    },
    { initial, withBridge, afterCheck, slowInitial },
  );
  await page.goto('/#capability=test');
}
const calls = (page: Page) => page.evaluate(() => (window as unknown as Stubbed).__calls);
const footer = (page: Page) => page.locator('.sidebar-footer');

test('an available update shows a button beside the version and installs once', async ({
  page,
}) => {
  await setup(page, { kind: 'available', version: '0.22.0' });
  await expect(footer(page)).toContainText('v0.21.0');
  const mark = footer(page).getByRole('button', { name: 'Update to 0.22.0' });
  await expect(mark.locator('.update-dot')).toBeVisible();
  expect(await mark.evaluate((el) => (el as HTMLElement).innerText)).toBe('Update to 0.22.0');
  const label = await footer(page).locator('.version-label').boundingBox();
  const box = await mark.boundingBox();
  if (!label || !box) throw new Error('footer controls are not laid out');
  expect(box.x - (label.x + label.width)).toBeLessThan(16);
  await mark.click();
  expect((await calls(page)).install).toBe(1);
});

test('downloading shows progress and no button', async ({ page }) => {
  await setup(page, { kind: 'downloading', version: '0.22.0', percent: 42 });
  await expect(footer(page)).toContainText('Downloading 42%');
  await expect(footer(page).getByRole('button', { name: /^Update to/ })).toHaveCount(0);
});

test('an error shows the message and Try again runs a check', async ({ page }) => {
  await setup(page, { kind: 'error', message: 'Download failed' });
  await expect(footer(page)).toContainText('Download failed');
  await footer(page).getByRole('button', { name: 'Try again' }).click();
  expect((await calls(page)).check).toBe(1);
});

for (const kind of ['idle', 'up-to-date', 'checking']) {
  test(`${kind} shows nothing beside the label`, async ({ page }) => {
    await setup(page, { kind });
    await expect(footer(page)).toContainText('v0.21.0');
    await expect(footer(page).locator('.update-mark, .update-progress, .update-error')).toHaveCount(
      0,
    );
  });
}

test('a pushed state replaces the mark', async ({ page }) => {
  await setup(page, { kind: 'idle' });
  await expect(footer(page)).toContainText('v0.21.0');
  await page.evaluate(() =>
    (window as unknown as Stubbed).__push({ kind: 'available', version: '0.23.0' }),
  );
  await expect(footer(page).getByRole('button', { name: 'Update to 0.23.0' })).toBeVisible();
});

test('the version label still opens About, whose button checks for updates', async ({ page }) => {
  await setup(page, { kind: 'idle' }, true, { kind: 'up-to-date' });
  await page.getByRole('button', { name: 'About Gloss, version 0.21.0' }).click();
  const dialog = page.getByRole('dialog', { name: 'About Gloss' });
  await dialog.getByRole('button', { name: 'Check for updates' }).click();
  expect((await calls(page)).check).toBe(1);
  await expect(dialog.getByText('Gloss is up to date')).toBeVisible();
});

test('without the desktop bridge there is no mark and no About button', async ({ page }) => {
  await setup(page, { kind: 'available', version: '0.22.0' }, false);
  await expect(footer(page)).toContainText('v0.21.0');
  await expect(footer(page).locator('.update-mark')).toHaveCount(0);
  await page.getByRole('button', { name: 'About Gloss, version 0.21.0' }).click();
  const dialog = page.getByRole('dialog', { name: 'About Gloss' });
  await expect(dialog).toContainText('0.21.0');
  await expect(dialog.getByRole('button', { name: 'Check for updates' })).toHaveCount(0);
});

async function collapse(page: Page) {
  await page.getByRole('button', { name: 'Collapse sessions' }).click();
  await expect(page.locator('.sessions-sidebar')).toHaveAttribute('data-collapsed', 'true');
}

test('collapsed rail: available is a clickable dot titled with the version', async ({ page }) => {
  await setup(page, { kind: 'available', version: '0.22.0' });
  await collapse(page);
  const dot = footer(page).locator('button[title="Update to 0.22.0"]');
  await expect(dot).toBeVisible();
  await expect(dot.locator('.update-dot')).toBeVisible();
  await dot.click();
  expect((await calls(page)).install).toBe(1);
});

test('collapsed rail: downloading is a compact indicator with the percentage', async ({ page }) => {
  await setup(page, { kind: 'downloading', version: '0.22.0', percent: 42 });
  await collapse(page);
  await expect(footer(page).locator('[title="Downloading 42%"]')).toBeVisible();
});

test('collapsed rail: error is an error dot that retries', async ({ page }) => {
  await setup(page, { kind: 'error', message: 'Download failed' });
  await collapse(page);
  const dot = footer(page).locator('button[title="Download failed — click to try again"]');
  await expect(dot).toBeVisible();
  await dot.click();
  expect((await calls(page)).check).toBe(1);
});

test('a long error cannot overflow the footer and keeps the full text in a title', async ({
  page,
}) => {
  const message = 'The update server answered with an unexpected response '.repeat(4);
  await setup(page, { kind: 'error', message });
  const error = footer(page).locator('.update-error');
  await expect(error).toBeVisible();
  await expect(error.locator('[title]').first()).toHaveAttribute('title', message);
  const fits = await footer(page).evaluate((el) => el.scrollWidth <= el.clientWidth);
  expect(fits).toBe(true);
});

test('a state pushed before the initial read resolves is not overwritten by it', async ({
  page,
}) => {
  await setup(page, { kind: 'idle' }, true, undefined, { kind: 'idle' });
  await page.evaluate(() =>
    (window as unknown as Stubbed).__push({ kind: 'available', version: '0.23.0' }),
  );
  await page.waitForTimeout(700);
  await expect(footer(page).getByRole('button', { name: 'Update to 0.23.0' })).toBeVisible();
});

test('About offers the same Update button when an update is available', async ({ page }) => {
  await setup(page, { kind: 'available', version: '0.22.0' });
  await page.getByRole('button', { name: 'About Gloss, version 0.21.0' }).click();
  const dialog = page.getByRole('dialog', { name: 'About Gloss' });
  await expect(dialog.getByText('Version 0.22.0 is available')).toBeVisible();
  await dialog.getByRole('button', { name: 'Update to 0.22.0' }).click();
  expect((await calls(page)).install).toBe(1);
});
