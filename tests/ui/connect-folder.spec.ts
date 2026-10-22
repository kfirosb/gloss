import { test, expect } from '@playwright/test';
import { mockSession, basicSnapshot } from './session-fixture.js';
test('search, states and connect', async ({ page }) => {
  const snapshot = basicSnapshot();
  await mockSession(page, () => snapshot);
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  const portfolio = {
    path: '/Users/me/Projects/portfolio',
    projectKey: '/Users/me/Projects/portfolio/.git',
    kind: 'main',
    createdByApp: false,
    connectedAt: 1,
    projectName: 'portfolio',
    missing: false,
  };
  const connected: unknown[] = [];
  const posted: unknown[] = [];
  await page.route('**/api/folders', (r) => {
    if (r.request().method() === 'POST') {
      posted.push(r.request().postDataJSON());
      connected.push(portfolio);
      return r.fulfill({ json: portfolio });
    }
    return r.fulfill({ json: connected });
  });
  await page.route('**/api/folders/search?*', (r) => {
    const q = new URL(r.request().url()).searchParams.get('q');
    return r.fulfill({
      json:
        q === 'slow'
          ? { hits: [], timedOut: true, unavailable: false }
          : q === 'none'
            ? { hits: [], timedOut: false, unavailable: false }
            : q === 'off'
              ? { hits: [], timedOut: false, unavailable: true }
              : {
                  hits: [
                    { path: '/Users/me/Projects/portfolio', name: 'portfolio', git: true },
                    { path: '/Users/me/Documents/recipes', name: 'recipes', git: false },
                  ],
                  timedOut: false,
                  unavailable: false,
                },
    });
  });
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'Connect folder' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect a folder' });
  await dialog.getByLabel('Search folders').fill('slow');
  await expect(dialog.getByText('Search took too long')).toBeVisible();
  await dialog.getByLabel('Search folders').fill('none');
  await expect(dialog.getByText('No folders found')).toBeVisible();
  await dialog.getByLabel('Search folders').fill('off');
  await expect(
    dialog.getByText('Search is unavailable here. Type the folder’s full path instead'),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Browse folders…' })).toHaveCount(0);
  await dialog.getByLabel('Search folders').fill('po');
  await expect(dialog.getByRole('option', { name: /portfolio/ })).toContainText('Git');
  await expect(dialog.getByRole('option', { name: /recipes/ })).toContainText('Folder');
  await expect(dialog.getByRole('option', { name: /portfolio/ })).toContainText(
    '/Users/me/Projects/portfolio',
  );
  await dialog.getByRole('option', { name: /portfolio/ }).click();
  await expect(dialog).toBeHidden();
  expect(posted).toEqual([{ path: '/Users/me/Projects/portfolio' }]);
  const sidebar = page.getByRole('navigation', { name: 'Sessions' });
  await expect(sidebar.getByRole('group', { name: 'portfolio' })).toBeVisible();
  await expect(
    sidebar.locator('.project-folder[data-folder-key="/Users/me/Projects/portfolio"]'),
  ).toHaveAttribute('aria-current', 'true');
});
test('in the Mac app, unavailable search points at Browse folders and a failing picker shows its error', async ({
  page,
}) => {
  const snapshot = basicSnapshot();
  await mockSession(page, () => snapshot);
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.addInitScript(() => {
    (window as any).gloss = {
      pickFolder: () => Promise.reject(new Error('Picker failed')),
    };
  });
  await page.route('**/api/folders', (r) => r.fulfill({ json: [] }));
  await page.route('**/api/folders/search?*', (r) =>
    r.fulfill({ json: { hits: [], timedOut: false, unavailable: true } }),
  );
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'Connect folder' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect a folder' });
  await dialog.getByLabel('Search folders').fill('off');
  await expect(dialog.getByText('Use Browse folders to choose a folder instead')).toBeVisible();
  await dialog.getByRole('button', { name: 'Browse folders…' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Picker failed');
});
