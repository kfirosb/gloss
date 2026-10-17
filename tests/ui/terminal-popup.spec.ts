import { test, expect, type Page } from '@playwright/test';
import { mockSession, basicSnapshot } from './session-fixture.js';

const entryFor = (over: Record<string, unknown> = {}) => ({
  key: 'L-panel',
  sessionId: 'L-panel',
  target: { agent: 'claude', sessionRef: 's1', projectId: '/project' },
  projectKey: '/project',
  projectName: 'project',
  worktreePath: '/project',
  open: true,
  activity: 'idle',
  availability: 'available',
  launchId: 'L1',
  launchState: 'running',
  ...over,
});
async function withLaunch(
  page: Page,
  activity = 'idle',
  popup = 'auto',
  extra: Record<string, unknown>[] = [],
  entryOver: Record<string, unknown> = {},
) {
  const snap = {
    ...basicSnapshot(),
    id: 'L-panel',
    target: { agent: 'claude', sessionRef: 's1', projectId: '/project' },
  };
  await mockSession(page, () => snap);
  const catalog = {
    epoch: 'e',
    sequence: 1,
    discovery: { state: 'healthy' },
    entries: [entryFor({ activity, ...entryOver }), ...extra],
  };
  await page.unroute('**/api/session-catalog**');
  await page.route('**/api/session-catalog', (r) => r.fulfill({ json: catalog }));
  await page.route('**/api/session-catalog/events', (r) =>
    r.fulfill({
      contentType: 'text/event-stream',
      body: 'data: ' + JSON.stringify(catalog) + '\n\n',
    }),
  );
  await page.route('**/api/settings/launch', (r) =>
    r.fulfill({ json: { extraArgs: { claude: [], codex: [] }, popup, terminalView: 'popup' } }),
  );
  const tickets: string[] = [];
  const received: any[] = [];
  await page.route('**/api/launches/L1/terminal-ticket', (r) => {
    tickets.push('x');
    return r.fulfill({ json: { ticket: 'tk', expiresAt: Date.now() + 30000 } });
  });
  await page.routeWebSocket(/\/api\/launches\/L1\/terminal\?ticket=tk/, (ws) => {
    ws.send('Allow this command? (y/n)');
    ws.onMessage((m) => {
      received.push(JSON.parse(String(m)));
    });
  });
  await page.route('**/events', (r) =>
    r.request().url().includes('session-catalog')
      ? r.fallback()
      : r.fulfill({ contentType: 'text/event-stream', body: '' }),
  );
  return { tickets, received };
}
test('auto mode toasts another session that needs approval, without opening it', async ({
  page,
}) => {
  await withLaunch(page, 'idle', 'auto', [
    entryFor({
      key: 'other',
      sessionId: 'other',
      launchId: 'L2',
      sessionTitle: 'Billing fix',
      activity: 'approval-required',
    }),
  ]);
  await page.goto('/#capability=test');
  await expect(
    page.getByRole('status').filter({ hasText: 'Billing fix needs approval' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show Billing fix' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: /Terminal:/ })).toBeHidden();
});
test('no toast in dot-only mode', async ({ page }) => {
  await withLaunch(page, 'idle', 'dot-only', [
    entryFor({
      key: 'other',
      sessionId: 'other',
      launchId: 'L2',
      sessionTitle: 'Billing fix',
      activity: 'approval-required',
    }),
  ]);
  await page.goto('/#capability=test');
  await expect(page.getByRole('radio', { name: 'Terminal' })).toBeEnabled();
  await expect(page.getByText('Billing fix needs approval')).toHaveCount(0);
});
test('language defaults dialog edits popup behavior and extra launch arguments', async ({
  page,
}) => {
  await withLaunch(page);
  let put: any;
  await page.route('**/api/settings/language', (r) =>
    r.fulfill({ json: { write: 'he', send: 'en', reply: 'he', assist: 'he' } }),
  );
  await page.route('**/api/settings/launch', (r) => {
    if (r.request().method() === 'PUT') {
      put = r.request().postDataJSON();
      return r.fulfill({
        json: {
          extraArgs: { claude: [], codex: [] },
          popup: put.popup,
          terminalView: put.terminalView,
        },
      });
    }
    return r.fallback();
  });
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  await dialog.getByLabel('When a session needs approval').selectOption('dot-only');
  await dialog.getByLabel('Extra Claude launch arguments').fill('--model "opus 4"');
  await dialog.getByLabel('Terminal tabs open as').selectOption('workspace');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(() => put)
    .toEqual({
      extraArgs: { claude: '--model "opus 4"', codex: '' },
      popup: 'dot-only',
      terminalView: 'workspace',
    });
});
