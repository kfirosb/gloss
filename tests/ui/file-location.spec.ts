import { test, expect, type Page } from '@playwright/test';
import { mockSession, basicSnapshot } from './session-fixture.js';

const reveal = /^Open in (Finder|file manager)$/;
async function setup(page: Page) {
  await mockSession(page, basicSnapshot);
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route('**/files/browse?*', (r) =>
    r.fulfill({
      json: {
        entries: [
          { name: 'src', relativePath: 'src', kind: 'directory' },
          { name: 'notes.txt', relativePath: 'notes.txt', kind: 'file' },
        ],
        limited: false,
      },
    }),
  );
  await page.route('**/files/locate?*', (r) => {
    const path = new URL(r.request().url()).searchParams.get('path');
    return r.fulfill({ json: { path: '/work/project/' + path, kind: 'file' } });
  });
  await page.route('**/files/preview?*', (r) =>
    r.fulfill({
      json: { name: 'notes.txt', relativePath: 'notes.txt', state: 'text', size: 4, text: 'Note' },
    }),
  );
}
async function open(page: Page) {
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
}

test('the browser build offers Copy path but hides Open in Finder', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await setup(page);
  await open(page);
  await page.getByRole('button', { name: 'Preview notes.txt' }).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Actions for notes.txt' });
  await expect(menu.getByRole('menuitem', { name: 'Copy path' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: reveal })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Copy path' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Path copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('/work/project/notes.txt');
  await page.getByRole('button', { name: 'Preview notes.txt' }).first().click();
  const header = page.locator('.file-preview-pane .file-location-actions');
  await expect(header.getByRole('button', { name: 'Copy path' })).toBeVisible();
  await expect(header.getByRole('button', { name: reveal })).toHaveCount(0);
});

test('the desktop build reveals files and folders through the bridge', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: [string, string][] = [];
    Object.assign(window, {
      __reveals: calls,
      languageAssistant: {
        pickFolder: async () => null,
        revealPath: async (sessionId: string, relativePath: string) => {
          calls.push([sessionId, relativePath]);
          return relativePath === 'src' ? { error: 'Folder unavailable' } : { ok: true };
        },
      },
    });
  });
  await setup(page);
  await open(page);
  const row = page.getByRole('button', { name: 'Preview notes.txt' });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: reveal }).click();
  await expect(row).toBeFocused();
  const folder = page.getByRole('button', { name: 'Open folder src' });
  await folder.focus();
  await folder.press('Shift+F10');
  const menu = page.getByRole('menu', { name: 'Actions for src' });
  await expect(menu.getByRole('menuitem', { name: 'Copy path' })).toBeVisible();
  await menu.getByRole('menuitem', { name: reveal }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Could not open' })).toContainText(
    'Folder unavailable',
  );
  await row.first().click();
  await page
    .locator('.file-preview-pane .file-location-actions')
    .getByRole('button', { name: reveal })
    .click();
  expect(
    await page.evaluate(() => (window as unknown as { __reveals: unknown }).__reveals),
  ).toEqual([
    ['basic', 'notes.txt'],
    ['basic', 'src'],
    ['basic', 'notes.txt'],
  ]);
});
