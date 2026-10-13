import { test, expect } from '@playwright/test';
import { mockSession, basicSnapshot } from './session-fixture.js';
test('version label opens About', async ({ page }) => {
  const snapshot = basicSnapshot(); await mockSession(page, () => snapshot); await page.route('**/events', r => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route('**/api/about', r => r.fulfill({ json: { name: 'language-assistant', version: '9.8.7', platform: 'darwin', arch: 'arm64' } }));
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'About Language Assistant, version 9.8.7' }).click();
  const dialog = page.getByRole('dialog', { name: 'About Language Assistant' });
  await expect(dialog).toContainText('9.8.7'); await expect(dialog).toContainText('macOS · Apple Silicon');
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
});
