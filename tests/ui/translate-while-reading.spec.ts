import { test, expect, type Page } from '@playwright/test';
import { mockSession, basicSnapshot } from './session-fixture.js';

const hebrew = { write: 'he', send: 'en', reply: 'he', assist: 'he' };
const reading = { ...hebrew, translateOnlyWhileReading: true };
const skipped = {
  sourceId: 'r1',
  revision: 1,
  role: 'assistant',
  text: 'Tests pass on main',
  complete: true,
};

/** A session whose actions are recorded; the snapshot never changes, as when the server skipped the reply. */
async function open(page: Page, settings: object) {
  const snapshot = { ...basicSnapshot(), languageSettings: settings, codingMessages: [skipped] };
  const actions: { type: string; view?: string; sourceId?: string }[] = [];
  await mockSession(page, () => snapshot);
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route('**/api/sessions/*/actions', (route) => {
    actions.push(route.request().postDataJSON());
    return route.fulfill({ json: { sessionId: snapshot.id, sequence: 1, snapshot } });
  });
  await page.goto('/#capability=test');
  return actions;
}
/** Reported views with repeats collapsed: development StrictMode runs the reporting effect twice, which is harmless. */
const views = (actions: { type: string; view?: string }[]) =>
  actions
    .filter((a) => a.type === 'conversation-view')
    .map((a) => a.view)
    .filter((view, i, all) => view !== all[i - 1]);

test('with the setting on, the page reports each view change and says translation follows the view', async ({
  page,
}) => {
  const actions = await open(page, reading);
  await expect(page.getByText('Translation on while reading')).toBeVisible();
  await expect.poll(() => views(actions)).toEqual(['translated']);
  const switcher = page.getByRole('radiogroup', { name: 'Live Conversation view' });
  await switcher.getByRole('radio', { name: 'Original' }).click();
  await expect.poll(() => views(actions)).toEqual(['translated', 'original']);
  await switcher.getByRole('radio', { name: 'Translated' }).click();
  await expect.poll(() => views(actions)).toEqual(['translated', 'original', 'translated']);
});

test('a skipped reply shows in English with Translate, never as Translating', async ({ page }) => {
  const actions = await open(page, reading);
  const message = page.locator('.feed article[data-source-id="r1"]');
  await expect(message.locator('.rich-text').first()).toContainText('Tests pass on main');
  await expect(message).not.toContainText('Translating…');
  await message.getByRole('button', { name: 'Translate' }).click();
  await expect
    .poll(() => actions.filter((a) => a.type === 'translate-message').map((a) => a.sourceId))
    .toEqual(['r1']);
});

test('with the setting off, the view is not reported and the indicator is unchanged', async ({
  page,
}) => {
  const actions = await open(page, hebrew);
  await expect(page.getByText('Translation on', { exact: true })).toBeVisible();
  await page
    .getByRole('radiogroup', { name: 'Live Conversation view' })
    .getByRole('radio', { name: 'Original' })
    .click();
  await expect(page.locator('.feed article[data-source-id="r1"]')).toHaveAttribute(
    'data-translation-status',
    'original',
  );
  expect(views(actions)).toEqual([]);
});

test('the defaults dialog saves the setting, off by default', async ({ page }) => {
  let defaults: Record<string, unknown> = { ...hebrew };
  await page.route('**/api/settings/language', (route) => {
    if (route.request().method() === 'PUT') defaults = route.request().postDataJSON();
    return route.fulfill({ json: defaults });
  });
  await open(page, hebrew);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const box = dialog.getByLabel('Translate only while reading translated');
  await expect(box).not.toBeChecked();
  await box.check();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => defaults.translateOnlyWhileReading).toBe(true);
  expect(defaults.reply).toBe('he');
});

test('the session language menu overrides the setting for this session', async ({ page }) => {
  let saved: Record<string, unknown> = {};
  await page.route('**/api/sessions/*/language', (route) => {
    if (route.request().method() === 'PUT') saved = route.request().postDataJSON();
    if (route.request().method() === 'DELETE') saved = {};
    return route.fulfill({
      json: { defaults: reading, override: saved, effective: { ...reading, ...saved } },
    });
  });
  await open(page, reading);
  await page.getByRole('button', { name: /Session languages/ }).click();
  const menu = page.getByRole('dialog', { name: 'Languages for this session' });
  const box = menu.getByLabel('Translate only while reading translated');
  await expect(box).toBeChecked();
  // The fixture snapshot never changes, so the box stays as the effective setting shows it; the click is what is saved.
  await box.click();
  await expect.poll(() => saved).toEqual({ translateOnlyWhileReading: false });
  await menu.getByRole('button', { name: 'Reset to defaults' }).click();
  await expect.poll(() => saved).toEqual({});
});
