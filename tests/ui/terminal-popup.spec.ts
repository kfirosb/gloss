import { test, expect, type Page } from '@playwright/test';
import { mockSession, basicSnapshot } from './session-fixture.js';

const entryFor = (over: Record<string, unknown> = {}) => ({ key: 'L-panel', sessionId: 'L-panel', target: { agent: 'claude', sessionRef: 's1', projectId: '/project' }, projectKey: '/project', projectName: 'project', worktreePath: '/project', open: true, activity: 'idle', availability: 'available', launchId: 'L1', launchState: 'running', ...over });
async function withLaunch(page: Page, activity = 'idle', popup = 'auto', extra: Record<string, unknown>[] = [], entryOver: Record<string, unknown> = {}) {
  const snap = { ...basicSnapshot(), id: 'L-panel', target: { agent: 'claude', sessionRef: 's1', projectId: '/project' } };
  await mockSession(page, () => snap);
  const catalog = { epoch: 'e', sequence: 1, discovery: { state: 'healthy' }, entries: [entryFor({ activity, ...entryOver }), ...extra] };
  await page.unroute('**/api/session-catalog**');
  await page.route('**/api/session-catalog', r => r.fulfill({ json: catalog }));
  await page.route('**/api/session-catalog/events', r => r.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify(catalog) + '\n\n' }));
  await page.route('**/api/settings/launch', r => r.fulfill({ json: { extraArgs: { claude: [], codex: [] }, popup } }));
  const tickets: string[] = []; const received: any[] = [];
  await page.route('**/api/launches/L1/terminal-ticket', r => { tickets.push('x'); return r.fulfill({ json: { ticket: 'tk', expiresAt: Date.now() + 30000 } }); });
  await page.routeWebSocket(/\/api\/launches\/L1\/terminal\?ticket=tk/, ws => { ws.send('Allow this command? (y/n)'); ws.onMessage(m => { received.push(JSON.parse(String(m))); }); });
  await page.route('**/events', r => r.request().url().includes('session-catalog') ? r.fallback() : r.fulfill({ contentType: 'text/event-stream', body: '' }));
  return { tickets, received };
}
test('Show terminal opens the popup, streams output, sends input and closing leaves the session', async ({ page }) => {
  const { received } = await withLaunch(page);
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'Show terminal' }).click();
  const dialog = page.getByRole('dialog', { name: /Terminal:/ });
  await expect(dialog.locator('.xterm')).toContainText('Allow this command?');
  await expect.poll(() => received.some(m => m.type === 'resize' && m.cols > 0)).toBe(true);
  await dialog.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('y');
  await expect.poll(() => received.filter(m => m.type === 'input').map(m => m.data).join('')).toBe('y');
  await dialog.getByRole('button', { name: /Close terminal/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Show terminal' })).toBeVisible();
});
test('shows the attention notice beside Show terminal', async ({ page }) => {
  await withLaunch(page, 'idle', 'auto', [], { attentionNotice: 'Cannot tell if this session needs you' });
  await page.goto('/#capability=test');
  await expect(page.getByText('Cannot tell if this session needs you')).toBeVisible();
});
test('auto mode opens on approval, but not while typing', async ({ page }) => {
  await withLaunch(page, 'approval-required', 'auto');
  await page.goto('/#capability=test');
  const box = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await box.pressSequentially('typing now', { delay: 200 });
  await expect(page.getByRole('dialog', { name: /Terminal:/ })).toBeHidden();
  await expect(page.getByRole('dialog', { name: /Terminal:/ })).toBeVisible({ timeout: 4000 });
});
test('dot-only mode never opens automatically', async ({ page }) => {
  await withLaunch(page, 'approval-required', 'dot-only');
  await page.goto('/#capability=test');
  await page.waitForTimeout(2500);
  await expect(page.getByRole('dialog', { name: /Terminal:/ })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Show terminal' })).toBeVisible();
});
test('auto mode toasts another session that needs approval, without opening it', async ({ page }) => {
  await withLaunch(page, 'idle', 'auto', [entryFor({ key: 'other', sessionId: 'other', launchId: 'L2', sessionTitle: 'Billing fix', activity: 'approval-required' })]);
  await page.goto('/#capability=test');
  await expect(page.getByRole('status').filter({ hasText: 'Billing fix needs approval' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show Billing fix' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: /Terminal:/ })).toBeHidden();
});
test('no toast in dot-only mode', async ({ page }) => {
  await withLaunch(page, 'idle', 'dot-only', [entryFor({ key: 'other', sessionId: 'other', launchId: 'L2', sessionTitle: 'Billing fix', activity: 'approval-required' })]);
  await page.goto('/#capability=test');
  await expect(page.getByRole('button', { name: 'Show terminal' })).toBeVisible();
  await expect(page.getByText('Billing fix needs approval')).toHaveCount(0);
});
test('discovered sessions without a launch get no Show terminal button', async ({ page }) => {
  await mockSession(page, () => basicSnapshot());
  await page.goto('/#capability=test');
  await expect(page.getByRole('textbox', { name: 'Discuss with language assistant' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show terminal' })).toHaveCount(0);
});
test('language defaults dialog edits popup behavior and extra launch arguments', async ({ page }) => {
  await withLaunch(page);
  let put: any;
  await page.route('**/api/settings/language', r => r.fulfill({ json: { write: 'he', send: 'en', reply: 'he', assist: 'he' } }));
  await page.route('**/api/settings/launch', r => { if (r.request().method() === 'PUT') { put = r.request().postDataJSON(); return r.fulfill({ json: { extraArgs: { claude: [], codex: [] }, popup: put.popup } }); } return r.fallback(); });
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  await dialog.getByLabel('When a session needs approval').selectOption('dot-only');
  await dialog.getByLabel('Extra Claude launch arguments').fill('--model "opus 4"');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => put).toEqual({ extraArgs: { claude: '--model "opus 4"', codex: '' }, popup: 'dot-only' });
});

test('the popup shows a status and an Expand button when given one', async ({ page }) => {
  await withLaunch(page);
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'Show terminal' }).click();
  const dialog = page.getByRole('dialog', { name: /Terminal:/ });
  await expect(dialog.getByRole('button', { name: 'Expand' })).toHaveCount(0); // agent popups have no Expand
  await expect(dialog.locator('.xterm')).toContainText('Allow this command?');
});

test('the terminal has keyboard focus as soon as the popup opens', async ({ page }) => {
  const { received } = await withLaunch(page);
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'Show terminal' }).click();
  const dialog = page.getByRole('dialog', { name: /Terminal:/ });
  await expect(dialog.locator('.xterm')).toContainText('Allow this command?');
  await expect.poll(() => received.some(m => m.type === 'resize' && m.cols > 0)).toBe(true);
  await expect(dialog.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type("y");
  await expect.poll(() => received.filter(m => m.type === "input").map(m => m.data).join("")).toBe("y");
});
