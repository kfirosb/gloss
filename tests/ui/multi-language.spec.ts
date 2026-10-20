import { test, expect, type Page } from '@playwright/test';
import type { LanguageSettings } from '../../src/core/language-settings.js';
import { mockSession, basicSnapshot, selectSession } from './session-fixture.js';
import { sessionFixture } from './multi-session-fixture.js';

const reply = {
  sourceId: 'r1',
  revision: 1,
  role: 'assistant',
  text: 'Done: the tests pass.',
  complete: true,
};
function withSettings(settings: LanguageSettings) {
  return { ...basicSnapshot(), languageSettings: settings, codingMessages: [reply] };
}
async function open(page: Page, settings: LanguageSettings) {
  await page.setViewportSize({ width: 1280, height: 800 });
  const snapshot = withSettings(settings);
  await mockSession(page, () => snapshot);
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route('**/files/browse?*', (r) =>
    r.fulfill({ json: { entries: [{ name: 'a.md', relativePath: 'a.md', kind: 'file' }] } }),
  );
  await page.goto('/#capability=test');
}
/** The sidebar and the docked Files column sit outside the conversation root and never move with it. */
async function expectChromeOrder(page: Page) {
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  const files = page
    .locator('.file-workspace')
    .getByRole('complementary', { name: 'Session files' });
  await expect(files).toBeVisible();
  const sidebar = (await page.locator('.sessions-sidebar').boundingBox())!;
  const column = (await files.boundingBox())!;
  const main = (await page.locator('main.app').boundingBox())!;
  expect(sidebar.x).toBeLessThan(column.x);
  expect(column.x).toBeLessThan(main.x);
}

test('a French session lays out left-to-right with French labels', async ({ page }) => {
  await open(page, { write: 'fr', send: 'en', reply: 'fr', assist: 'fr' });
  await expect(page.locator('main.app')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByPlaceholder('Write in French…')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('label[for="composer"]')).toHaveText(
    'Chat with the language assistant',
  );
  await expect(
    page.getByText('Write here in French to discuss and refine the request.'),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Live conversation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Summarize in French' })).toBeVisible();
  await expectChromeOrder(page);
});
test('a Hebrew session keeps the same sidebar and Files column placement', async ({ page }) => {
  await open(page, { write: 'he', send: 'en', reply: 'he', assist: 'he' });
  await expect(page.locator('main.app')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByPlaceholder('Write in Hebrew…')).toHaveAttribute('dir', 'rtl');
  await expectChromeOrder(page);
});
test('an Arabic session is right-to-left and the menu marks RTL languages', async ({ page }) => {
  await open(page, { write: 'ar', send: 'en', reply: 'ar', assist: 'ar' });
  await expect(page.locator('main.app')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByPlaceholder('Write in Arabic…')).toHaveAttribute('dir', 'rtl');
  await page.route('**/api/settings/language', (route) =>
    route.fulfill({ json: { write: 'ar', send: 'en', reply: 'ar', assist: 'ar' } }),
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const write = page.getByRole('dialog', { name: 'Settings' }).getByLabel('I write in');
  await expect(write.locator('option[value="ar"]')).toHaveText('Arabic (RTL)');
  await expect(write.locator('option[value="fr"]')).toHaveText('French');
  await expect(write.locator('option[value="he"]')).toHaveText('Hebrew (RTL)');
  await expect(write.locator('option[value="fa"]')).toHaveText('Persian (RTL)');
  await expect(write.locator('option[value="ur"]')).toHaveText('Urdu (RTL)');
  await expect(write.locator('option')).toHaveCount(19);
});
test('switching the selected session flips the root direction', async ({ page, context }) => {
  const f = await sessionFixture(context);
  f.snapshots.A.languageSettings = { write: 'he', send: 'en', reply: 'he', assist: 'he' };
  f.snapshots.B.languageSettings = { write: 'fr', send: 'en', reply: 'fr', assist: 'fr' };
  await page.goto('/#capability=test');
  await expect(page.locator('main.app')).toBeVisible();
  await selectSession(page, 'A');
  await expect(page.locator('main.app')).toHaveAttribute('dir', 'rtl');
  await selectSession(page, 'B');
  await expect(page.locator('main.app')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByPlaceholder('Write in French…')).toBeVisible();
  await selectSession(page, 'A');
  await expect(page.locator('main.app')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByPlaceholder('Write in Hebrew…')).toBeVisible();
});
