import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { DeliveryRoute } from '../../src/core/contracts.js';
import type { CatalogSnapshot } from '../../src/core/session-catalog.js';
import type { ClaudeMoveStatus } from '../../src/runtime/claude-move.js';
import { basicSnapshot, mockSession } from './session-fixture.js';
import { sessionFixture } from './multi-session-fixture.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const PROCESS = { pid: 4242, procStart: 'Sat Oct 18 10:00:00 2026' };
const CONFIRMATION =
  "Claude in the other terminal will close, and the session will continue here with all its history. Text you typed there and didn't send will be lost, and so will commands still running in the background of that session.";
const WORKING = 'Claude is working; it can be moved when it finishes';
const MANUAL = {
  command: `claude --resume ${SESSION}`,
  cdCommand: `cd '/project' && claude --resume ${SESSION}`,
};
const EXITED = 'Claude closed as soon as Gloss reopened the session.';

/**
 * The status the server reports. `afterPost` is what it reports from the next POST on, so a poll racing a click
 * cannot change what the click sees.
 */
async function moveRoute(target: Page | BrowserContext, initial: ClaudeMoveStatus) {
  let status = initial;
  let next: ClaudeMoveStatus | undefined;
  const posts: unknown[] = [];
  await target.route('**/api/sessions/*/claude-move', (route) => {
    if (route.request().method() === 'POST') {
      posts.push(route.request().postDataJSON());
      if (next) status = next;
      next = undefined;
    }
    return route.fulfill({ json: status });
  });
  return {
    posts,
    set(value: ClaudeMoveStatus) {
      status = value;
    },
    afterPost(value: ClaudeMoveStatus) {
      next = value;
    },
  };
}
async function outsideSession(page: Page, initial: ClaudeMoveStatus) {
  const snapshot = {
    ...basicSnapshot(),
    target: { agent: 'claude', sessionRef: SESSION, projectId: '/project' },
  };
  let route: DeliveryRoute = { transport: null, reason: 'Gloss can’t reach this session yet.' };
  await page.route('**/api/sessions/*/claude-route', (r) => r.fulfill({ json: route }));
  await mockSession(page, () => snapshot);
  await page.route('**/api/sessions/*/events', (r) =>
    r.fulfill({ contentType: 'text/event-stream', body: '' }),
  );
  await page.route('**/api/sessions/*/claude-channel', (r) =>
    r.fulfill({ json: { state: 'setup-required' } }),
  );
  await page.route('**/api/claude/registration', (r) =>
    r.fulfill({ json: { state: 'registered' } }),
  );
  const move = await moveRoute(page, initial);
  await page.goto('/#capability=test');
  await page.getByText(/Connect this session to Gloss/).click();
  return {
    ...move,
    setRoute(value: DeliveryRoute) {
      route = value;
    },
  };
}

test('Move to Gloss asks with the exact confirmation, and Cancel sends nothing', async ({
  page,
}) => {
  const move = await outsideSession(page, { state: 'ready', process: PROCESS });
  await page.getByRole('button', { name: 'Move to Gloss', exact: true }).click();
  const confirm = page.getByRole('group', { name: 'Confirm Move to Gloss' });
  await expect(confirm.getByText(CONFIRMATION, { exact: true })).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  expect(move.posts).toEqual([]);
  await page.getByRole('button', { name: 'Move to Gloss', exact: true }).click();
  move.afterPost({ state: 'in-gloss' });
  await confirm.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page.getByText('This session now runs in Gloss.', { exact: true })).toBeVisible();
  expect(move.posts).toEqual([{ action: 'move', ...PROCESS }]);
});

test('a working session offers Move when it finishes, which can be cancelled', async ({ page }) => {
  const move = await outsideSession(page, { state: 'busy', reason: WORKING, process: PROCESS });
  await expect(page.getByRole('button', { name: WORKING, exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Move when it finishes', exact: true }).click();
  const confirm = page.getByRole('group', { name: 'Confirm Move to Gloss' });
  await expect(confirm.getByText(CONFIRMATION, { exact: true })).toBeVisible();
  move.afterPost({ state: 'waiting' });
  await confirm.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(
    page.getByText('Gloss will move this session when Claude finishes.', { exact: true }),
  ).toBeVisible();
  expect(move.posts).toEqual([{ action: 'when-idle', ...PROCESS }]);
  move.afterPost({ state: 'busy', reason: WORKING, process: PROCESS });
  await page.getByRole('button', { name: 'Don’t move', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Move when it finishes', exact: true }),
  ).toBeVisible();
  expect(move.posts.at(-1)).toEqual({ action: 'cancel' });
});

test('a failed move shows the reason and the manual resume command', async ({ page }) => {
  await outsideSession(page, {
    state: 'unavailable',
    reason: 'This Claude session isn’t running in a terminal now.',
    failure: { reason: EXITED, manual: MANUAL },
  });
  const alert = page.getByRole('alert').filter({ hasText: EXITED });
  await expect(alert).toContainText('Open it in a terminal with:');
  await expect(page.getByLabel('Claude resume command')).toHaveValue(MANUAL.cdCommand);
  await expect(page.getByRole('button', { name: 'Move to Gloss', exact: true })).toHaveCount(0);
});

test('the connect dialog stays until the reopen is checked, and shows a late failure in place', async ({
  page,
}) => {
  const move = await outsideSession(page, { state: 'ready', process: PROCESS });
  await page.getByRole('button', { name: 'Move to Gloss', exact: true }).click();
  move.afterPost({ state: 'in-gloss' });
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page.getByText('This session now runs in Gloss.', { exact: true })).toBeVisible();
  // The route turns to Gloss's terminal; the dialog showing the move must not disappear with it.
  move.setRoute({ transport: 'tmux' });
  await expect(page.locator('.route-line > summary')).toHaveText('Terminal');
  move.set({ state: 'unavailable', reason: 'x', failure: { reason: EXITED, manual: MANUAL } });
  await expect(page.getByRole('alert').filter({ hasText: EXITED })).toBeVisible();
  await expect(page.getByLabel('Claude resume command')).toHaveValue(MANUAL.cdCommand);
});

test('a move whose connect dialog was closed reports its outcome as the session’s notice', async ({
  page,
}) => {
  const move = await outsideSession(page, { state: 'ready', process: PROCESS });
  await page.getByRole('button', { name: 'Move to Gloss', exact: true }).click();
  move.afterPost({ state: 'moving' });
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page.getByText('Moving the session to Gloss…', { exact: true })).toBeVisible();
  await page.getByText(/Connect this session to Gloss/).click();
  await expect(page.getByText('Moving the session to Gloss…', { exact: true })).toHaveCount(0);
  move.set({ state: 'unavailable', reason: 'x', failure: { reason: EXITED, manual: MANUAL } });
  await expect(page.getByRole('status').filter({ hasText: EXITED })).toContainText(
    MANUAL.cdCommand,
  );
});

async function tabsWithMove(context: BrowserContext) {
  const f = await sessionFixture(context);
  const catalog: CatalogSnapshot = {
    epoch: 'move',
    sequence: 1,
    discovery: { state: 'healthy' },
    entries: f.records.map((r) => ({
      key: r.id,
      sessionId: r.id,
      target: { agent: 'claude' as const, sessionRef: r.target.sessionRef, projectId: '/repo' },
      projectKey: '/repo/.git',
      projectName: 'repo',
      sessionTitle: `Session ${r.id}`,
      worktreePath: '/repo',
      open: true,
      activity: 'idle' as const,
      availability: 'available' as const,
      ...(r.id === 'B' ? { launchId: 'launch-B', launchState: 'running' as const } : {}),
    })),
  };
  await context.route('**/api/session-catalog', (r) => r.fulfill({ json: catalog }));
  await context.route('**/api/session-catalog/events', (r) =>
    r.fulfill({
      contentType: 'text/event-stream',
      body: 'data: ' + JSON.stringify(catalog) + '\n\n',
    }),
  );
  return moveRoute(context, { state: 'ready', process: PROCESS });
}

test('the session tab menu offers Move to Gloss only for outside Claude sessions', async ({
  page,
  context,
}) => {
  const move = await tabsWithMove(context);
  await page.goto('/#capability=test');
  const tabs = page.getByRole('tablist', { name: 'Sessions in repo' });
  await tabs.getByRole('tab', { name: /Session B/ }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'End session' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Move to Gloss…' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await tabs.getByRole('tab', { name: /Session A/ }).press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Move to Gloss…' }).press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Move to Gloss' });
  await dialog.getByRole('button', { name: 'Move to Gloss', exact: true }).click();
  await expect(dialog.getByText(CONFIRMATION, { exact: true })).toBeVisible();
  expect(move.posts).toEqual([]);
  move.afterPost({ state: 'in-gloss' });
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(dialog.getByText('This session now runs in Gloss.', { exact: true })).toBeVisible();
  expect(move.posts).toEqual([{ action: 'move', ...PROCESS }]);
});

test('a move whose tab-menu dialog was closed reports its outcome on that session', async ({
  page,
  context,
}) => {
  const move = await tabsWithMove(context);
  await page.goto('/#capability=test');
  const tabs = page.getByRole('tablist', { name: 'Sessions in repo' });
  await tabs.getByRole('tab', { name: /Session A/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Gloss…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Move to Gloss' });
  await dialog.getByRole('button', { name: 'Move to Gloss', exact: true }).click();
  move.afterPost({ state: 'moving' });
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(dialog.getByText('Moving the session to Gloss…', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close Move to Gloss', exact: true }).click();
  await expect(dialog).toBeHidden();
  move.set({ state: 'unavailable', reason: 'x', failure: { reason: EXITED, manual: MANUAL } });
  await tabs.getByRole('tab', { name: /Session A/ }).click();
  await expect(page.getByRole('status').filter({ hasText: EXITED })).toContainText(
    MANUAL.cdCommand,
  );
});
