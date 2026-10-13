import { test, expect } from '@playwright/test';
import { mockSession, basicSnapshot } from './session-fixture.js';

const reply = { sourceId: 'r1', revision: 1, role: 'assistant', text: '## Summary\n\n- Added `sessionLanguage`', complete: true };
function withSettings(settings: any, extra: any = {}) { return { ...basicSnapshot(), languageSettings: settings, codingMessages: [reply], ...extra }; }

test('English replies render formatted without translation', async ({ page }) => {
  const snapshot = withSettings({ write: 'en', send: 'en', reply: 'en', assist: 'en' });
  await mockSession(page, () => snapshot); await page.route('**/events', r => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.goto('/#capability=test');
  const message = page.locator('.feed article[data-source-id="r1"]');
  await expect(message.getByRole('heading', { name: 'Summary' })).toBeVisible();
  await expect(message.locator('.rich-text').first()).toHaveCSS('direction', 'ltr');
  await expect(message).toContainText('original');
  await expect(message.locator('details summary', { hasText: 'Original' })).toHaveCount(0);
  await expect(page.getByText('No translation')).toBeVisible();
});
test('session chip shows codes and opens the per-session popover', async ({ page }) => {
  const snapshot = withSettings({ write: 'he', send: 'en', reply: 'he', assist: 'he' }, { codingMessages: [{ ...reply, translatedText: 'סיכום', translationStatus: 'complete' }] });
  let saved: any = {};
  await mockSession(page, () => snapshot); await page.route('**/events', r => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route('**/api/sessions/*/language', route => {
    if (route.request().method() === 'PUT') saved = route.request().postDataJSON();
    if (route.request().method() === 'DELETE') saved = {};
    const effective = { write: 'he', send: 'en', reply: 'he', assist: 'he', ...saved };
    return route.fulfill({ json: { defaults: { write: 'he', send: 'en', reply: 'he', assist: 'he' }, override: saved, effective } });
  });
  await page.goto('/#capability=test');
  const chip = page.getByRole('button', { name: /Session languages HE→EN→HE/ });
  await expect(chip).toBeVisible(); await expect(page.getByText('Translation on')).toBeVisible();
  await chip.click();
  const dialog = page.getByRole('dialog', { name: 'Languages for this session' });
  await dialog.getByLabel('Show agent replies in').selectOption('en');
  await expect.poll(() => saved).toEqual({ reply: 'en' });
  await dialog.getByRole('button', { name: 'Reset to defaults' }).click();
  await expect.poll(() => saved).toEqual({});
});
test('composer direction follows the write language', async ({ page }) => {
  const snapshot = withSettings({ write: 'en', send: 'en', reply: 'en', assist: 'en' });
  await mockSession(page, () => snapshot); await page.route('**/events', r => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.goto('/#capability=test');
  const composer = page.getByPlaceholder('Write in English…');
  await expect(composer).toHaveAttribute('dir', 'ltr');
  await expect(composer).toHaveCSS('direction', 'ltr');
});
test('defaults dialog saves app-wide defaults', async ({ page }) => {
  const snapshot = withSettings({ write: 'he', send: 'en', reply: 'he', assist: 'he' });
  let defaults: any = { write: 'he', send: 'en', reply: 'he', assist: 'he' };
  await mockSession(page, () => snapshot); await page.route('**/events', r => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route('**/api/settings/language', route => { if (route.request().method() === 'PUT') defaults = route.request().postDataJSON(); return route.fulfill({ json: defaults }); });
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByLabel('I write in').selectOption('en');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => defaults.write).toBe('en');
  await expect(dialog).toBeHidden();
});
test('streaming reply in a Hebrew session shows Translating, not English', async ({ page }) => {
  const snapshot = withSettings({ write: 'he', send: 'en', reply: 'he', assist: 'he' }, { codingMessages: [{ ...reply, complete: false, text: 'Streaming english text' }] });
  await mockSession(page, () => snapshot); await page.route('**/events', r => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.goto('/#capability=test');
  const message = page.locator('.feed article[data-source-id="r1"]');
  await expect(message).toContainText('Translating…');
  await expect(message.locator('.rich-text')).not.toContainText('Streaming english text');
});
test('back-to-back select changes are serialized and keep both fields', async ({ page }) => {
  const snapshot = withSettings({ write: 'he', send: 'en', reply: 'he', assist: 'he' });
  let saved: any = {}; const puts: any[] = [];
  await mockSession(page, () => snapshot); await page.route('**/events', r => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route('**/api/sessions/*/language', async route => {
    if (route.request().method() === 'PUT') { const body = route.request().postDataJSON(); puts.push(body); await new Promise(r => setTimeout(r, 150)); saved = body; }
    return route.fulfill({ json: { defaults: { write: 'he', send: 'en', reply: 'he', assist: 'he' }, override: saved, effective: { write: 'he', send: 'en', reply: 'he', assist: 'he', ...saved } } });
  });
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: /Session languages/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Languages for this session' });
  await dialog.getByLabel('Show agent replies in').selectOption('en');
  await dialog.getByLabel('I write in').selectOption('en');
  await expect.poll(() => puts.length).toBe(2);
  expect(puts[1]).toEqual({ reply: 'en', write: 'en' });
});
test('the settings dialog is a compact left-to-right form with readable controls, and the sidebar has no path finder', async ({ page }) => {
  const snapshot = withSettings({ write: 'he', send: 'en', reply: 'he', assist: 'he' });
  await mockSession(page, () => snapshot); await page.route('**/events', r => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route('**/api/settings/language', route => route.fulfill({ json: { write: 'he', send: 'en', reply: 'he', assist: 'he' } }));
  await page.route('**/api/settings/launch', route => route.fulfill({ json: { extraArgs: { claude: [], codex: ['--dangerously-bypass-approvals-and-sandbox'] }, popup: 'auto' } }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#capability=test');
  await expect(page.getByRole('navigation', { name: 'Sessions' }).getByRole('button', { name: 'Find sessions by path' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('heading', { name: 'Languages' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  await expect(dialog.locator('.review-body')).toHaveCSS('direction', 'ltr');
  const box = (await dialog.boundingBox())!; expect(box.width).toBeLessThanOrEqual(620); expect(box.height).toBeLessThan(700);
  const approval = await dialog.getByLabel('When a session needs approval').boundingBox();
  expect(approval!.width).toBeGreaterThan(240);
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
});
