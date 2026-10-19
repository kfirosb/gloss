import { expect, test, type Page } from '@playwright/test';
import type { RegistrationStatus } from '../../src/runtime/claude-registration.js';
import { basicSnapshot, mockSession } from './session-fixture.js';

const OLD = '/Applications/Old Gloss.app/Contents/MacOS/Gloss';
async function registration(page: Page, initial: RegistrationStatus) {
  let status = initial;
  const posts: unknown[] = [];
  await page.route('**/api/claude/registration', (route) => {
    if (route.request().method() === 'POST') {
      const body: unknown = route.request().postDataJSON();
      posts.push(body);
      status =
        JSON.stringify(body) === JSON.stringify({ action: 'remove' })
          ? { state: 'unregistered' }
          : { state: 'registered' };
    }
    return route.fulfill({ json: status });
  });
  return posts;
}
async function openSettings(page: Page) {
  await mockSession(page, () => basicSnapshot());
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route('**/api/settings/language', (r) =>
    r.fulfill({ json: { write: 'he', send: 'en', reply: 'he', assist: 'he' } }),
  );
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  return page.getByRole('dialog', { name: 'Settings' });
}

test('Settings shows a stale connection with Update, then Remove Claude connection', async ({
  page,
}) => {
  const posts = await registration(page, { state: 'stale', found: OLD });
  const dialog = await openSettings(page);
  const section = dialog.getByRole('region', { name: 'Claude connection' });
  await expect(section).toContainText('The Claude connection needs updating');
  await expect(section).toContainText(OLD);
  await section.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(section).toContainText('Gloss is registered with Claude Code');
  await section.getByRole('button', { name: 'Remove Claude connection', exact: true }).click();
  await expect(section).toContainText('isn’t registered');
  expect(posts).toEqual([{ action: 'register' }, { action: 'remove' }]);
});

test('Settings reports a foreign gloss entry and offers no change', async ({ page }) => {
  const posts = await registration(page, { state: 'conflict', found: '/usr/local/bin/other' });
  const section = (await openSettings(page)).getByRole('region', { name: 'Claude connection' });
  await expect(section.getByRole('alert')).toContainText('/usr/local/bin/other');
  await expect(section.getByRole('button')).toHaveCount(0);
  expect(posts).toEqual([]);
});

test('opening the connect dialog shows a stale connection without another click', async ({
  page,
}) => {
  await registration(page, { state: 'stale', found: OLD });
  const snapshot = {
    ...basicSnapshot(),
    target: {
      agent: 'claude',
      sessionRef: '11111111-1111-4111-8111-111111111111',
      projectId: '/project',
    },
  };
  await page.route('**/api/sessions/*/claude-route', (r) =>
    r.fulfill({ json: { transport: null, reason: 'Gloss can’t reach this session yet.' } }),
  );
  await mockSession(page, () => snapshot);
  await page.route('**/api/sessions/*/events', (r) =>
    r.fulfill({ contentType: 'text/event-stream', body: '' }),
  );
  await page.route('**/api/sessions/*/claude-channel', (r) =>
    r.fulfill({ json: { state: 'setup-required' } }),
  );
  await page.route('**/api/sessions/*/claude-move', (r) =>
    r.fulfill({
      json: {
        state: 'unavailable',
        reason: 'This Claude session isn’t running in a terminal now.',
      },
    }),
  );
  await page.goto('/#capability=test');
  await page.getByText(/Connect this session to Gloss/).click();
  await expect(page.getByText('The Claude connection needs updating')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeVisible();
});
