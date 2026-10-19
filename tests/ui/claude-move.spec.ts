import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
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
  let held: Promise<void> | undefined;
  let heldReads: Promise<void> | undefined;
  const posts: unknown[] = [];
  await target.route('**/api/sessions/*/claude-move', async (route) => {
    if (route.request().method() === 'GET') await heldReads;
    if (route.request().method() === 'POST') {
      posts.push(route.request().postDataJSON());
      await held;
      if (next) status = next;
      next = undefined;
    }
    return route.fulfill({ json: status });
  });
  return {
    posts,
    /** POSTs wait until the returned function is called. */
    hold() {
      let release = () => {};
      held = new Promise((resolve) => {
        release = () => {
          held = undefined;
          resolve();
        };
      });
      return release;
    },
    /** Status reads wait until the returned function is called. */
    holdReads() {
      let release = () => {};
      heldReads = new Promise((resolve) => {
        release = () => {
          heldReads = undefined;
          resolve();
        };
      });
      return release;
    },
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
  const connect = page.locator('.claude-connection');
  await connect.getByRole('button', { name: 'Move to Gloss', exact: true }).click();
  const popover = connect.getByRole('dialog', { name: 'Move to Gloss' });
  await expect(popover.getByText(CONFIRMATION, { exact: true })).toBeVisible();
  await popover.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(popover).toHaveCount(0);
  expect(move.posts).toEqual([]);
  await connect.getByRole('button', { name: 'Move to Gloss', exact: true }).click();
  move.afterPost({ state: 'in-gloss' });
  await popover.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(popover.getByText('This session now runs in Gloss.', { exact: true })).toBeVisible();
  expect(move.posts).toEqual([{ action: 'move', ...PROCESS }]);
});

test('a working session offers Move when it finishes, which can be cancelled', async ({ page }) => {
  const move = await outsideSession(page, { state: 'busy', reason: WORKING, process: PROCESS });
  const connect = page.locator('.claude-connection');
  await expect(connect.getByRole('button', { name: WORKING, exact: true })).toBeDisabled();
  await connect.getByRole('button', { name: 'Move when it finishes', exact: true }).click();
  const popover = connect.getByRole('dialog', { name: 'Move to Gloss' });
  await expect(popover.getByText(WORKING, { exact: true })).toBeVisible();
  await expect(popover.getByText(CONFIRMATION, { exact: true })).toBeVisible();
  move.afterPost({ state: 'waiting' });
  await popover.getByRole('button', { name: 'Move when it finishes', exact: true }).click();
  await expect(
    popover.getByText('Gloss will move this session when Claude finishes.', { exact: true }),
  ).toBeVisible();
  expect(move.posts).toEqual([{ action: 'when-idle', ...PROCESS }]);
  move.afterPost({ state: 'busy', reason: WORKING, process: PROCESS });
  await popover.getByRole('button', { name: 'Don’t move', exact: true }).click();
  await expect(
    popover.getByRole('button', { name: 'Move when it finishes', exact: true }),
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
  const connect = page.locator('.claude-connection');
  await connect.getByRole('button', { name: 'Move to Gloss', exact: true }).click();
  const popover = connect.getByRole('dialog', { name: 'Move to Gloss' });
  move.afterPost({ state: 'in-gloss' });
  await popover.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(popover.getByText('This session now runs in Gloss.', { exact: true })).toBeVisible();
  // The route turns to Gloss's terminal; the dialog showing the move must not disappear with it.
  move.setRoute({ transport: 'tmux' });
  await expect(page.locator('.route-line > summary')).toHaveText('Terminal');
  move.set({ state: 'unavailable', reason: 'x', failure: { reason: EXITED, manual: MANUAL } });
  await expect(popover.getByRole('alert').filter({ hasText: EXITED })).toBeVisible();
  await expect(popover.getByLabel('Claude resume command')).toHaveValue(MANUAL.cdCommand);
});

test('a move whose connect dialog was closed reports its outcome as the session’s notice', async ({
  page,
}) => {
  const move = await outsideSession(page, { state: 'ready', process: PROCESS });
  const connect = page.locator('.claude-connection');
  await connect.getByRole('button', { name: 'Move to Gloss', exact: true }).click();
  move.afterPost({ state: 'moving' });
  await connect.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(connect.getByText('Moving the session to Gloss…', { exact: true })).toBeVisible();
  await page.getByText(/Connect this session to Gloss/).click();
  await expect(connect.getByText('Moving the session to Gloss…')).toHaveCount(0);
  move.set({ state: 'unavailable', reason: 'x', failure: { reason: EXITED, manual: MANUAL } });
  await expect(page.getByRole('status').filter({ hasText: EXITED })).toContainText(
    MANUAL.cdCommand,
  );
});

/** `launched` runs in a Gloss launch; `codex`, if given, is a Codex session. Every other session is Claude. */
async function tabsWithMove(context: BrowserContext, launched = 'B', codex?: string) {
  const f = await sessionFixture(context);
  const catalog: CatalogSnapshot = {
    epoch: 'move',
    sequence: 1,
    discovery: { state: 'healthy' },
    entries: f.records.map((r) => ({
      key: r.id,
      sessionId: r.id,
      target: {
        agent: r.id === codex ? ('codex' as const) : ('claude' as const),
        sessionRef: r.target.sessionRef,
        projectId: '/repo',
      },
      projectKey: '/repo/.git',
      projectName: 'repo',
      sessionTitle: `Session ${r.id}`,
      worktreePath: '/repo',
      open: true,
      activity: 'idle' as const,
      availability: 'available' as const,
      ...(r.id === launched ? { launchId: 'launch-' + r.id, launchState: 'running' as const } : {}),
    })),
  };
  await context.route('**/api/session-catalog', (r) => r.fulfill({ json: catalog }));
  await context.route('**/api/session-catalog/events', (r) =>
    r.fulfill({
      contentType: 'text/event-stream',
      body: 'data: ' + JSON.stringify(catalog) + '\n\n',
    }),
  );
  return {
    ...(await moveRoute(context, { state: 'ready', process: PROCESS })),
    records: f.records,
  };
}

test('the session tab menu opens one small Move popover only for outside Claude sessions', async ({
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
  const popover = page.getByRole('dialog', { name: 'Move to Gloss' });
  // One step: the confirmation is shown at once, with no full-size dialog around it.
  await expect(popover.getByText(CONFIRMATION, { exact: true })).toBeVisible();
  await expect(popover).toHaveClass(/move-popover/);
  await expect(popover.getByRole('button', { name: 'Move to Gloss', exact: true })).toHaveCount(0);
  await popover.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(popover).toHaveCount(0);
  expect(move.posts).toEqual([]);
  await tabs.getByRole('tab', { name: /Session A/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Gloss…' }).click();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await tabs.getByRole('tab', { name: /Session A/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Gloss…' }).click();
  move.afterPost({ state: 'in-gloss' });
  await popover.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(popover.getByText('This session now runs in Gloss.', { exact: true })).toBeVisible();
  expect(move.posts).toEqual([{ action: 'move', ...PROCESS }]);
});

const tabButton = (page: Page, name: string) =>
  page
    .getByRole('tablist', { name: 'Sessions in repo' })
    .getByRole('button', { name, exact: true, includeHidden: true });

test('an outside Claude session tab has a Move icon where a launched tab has its ×', async ({
  page,
  context,
}) => {
  const move = await tabsWithMove(context);
  await page.goto('/#capability=test');
  const tabs = page.getByRole('tablist', { name: 'Sessions in repo' });
  await tabs.getByRole('tab', { name: /Session B/ }).hover();
  await expect(tabButton(page, 'End Session B')).toBeVisible();
  await expect(tabButton(page, 'Move Session B to Gloss')).toHaveCount(0);
  await expect(tabButton(page, 'End Session A')).toHaveCount(0);
  const icon = tabButton(page, 'Move Session A to Gloss');
  await expect(icon).toBeHidden();
  await tabs.getByRole('tab', { name: /Session A/ }).hover();
  await expect(icon).toBeVisible();
  await expect(icon).toHaveAttribute('title', 'Move Session A to Gloss');
  await expect(icon).toHaveAttribute('aria-haspopup', 'dialog');
  await icon.click();
  const popover = page.getByRole('dialog', { name: 'Move to Gloss' });
  await expect(popover.getByText(CONFIRMATION, { exact: true })).toBeVisible();
  await expect(icon).toHaveAttribute('aria-expanded', 'true');
  // Pressing the icon again closes its popover rather than reopening it.
  await icon.click();
  await expect(popover).toHaveCount(0);
  expect(move.posts).toEqual([]);
  await tabs.getByRole('tab', { name: /Session A/ }).hover();
  await icon.click();
  await expect(popover.getByText(CONFIRMATION, { exact: true })).toBeVisible();
  move.afterPost({ state: 'in-gloss' });
  await popover.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(popover.getByText('This session now runs in Gloss.', { exact: true })).toBeVisible();
  expect(move.posts).toEqual([{ action: 'move', ...PROCESS }]);
});

test('a Codex session tab has no Move icon', async ({ page, context }) => {
  await tabsWithMove(context, 'none', 'A');
  await page.goto('/#capability=test');
  await page
    .getByRole('tablist', { name: 'Sessions in repo' })
    .getByRole('tab', { name: /Session A/ })
    .hover();
  await expect(tabButton(page, 'Move Session A to Gloss')).toHaveCount(0);
  await expect(tabButton(page, 'Move Session B to Gloss')).toHaveCount(1);
});

test('a working session in the tab menu popover offers Move when it finishes', async ({
  page,
  context,
}) => {
  const move = await tabsWithMove(context);
  move.set({ state: 'busy', reason: WORKING, process: PROCESS });
  await page.goto('/#capability=test');
  const tabs = page.getByRole('tablist', { name: 'Sessions in repo' });
  await tabs.getByRole('tab', { name: /Session A/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Gloss…' }).click();
  const popover = page.getByRole('dialog', { name: 'Move to Gloss' });
  await expect(popover.getByText(WORKING, { exact: true })).toBeVisible();
  await expect(popover.getByRole('button', { name: 'Move', exact: true })).toHaveCount(0);
  move.afterPost({ state: 'waiting' });
  await popover.getByRole('button', { name: 'Move when it finishes', exact: true }).click();
  await expect(
    popover.getByText('Gloss will move this session when Claude finishes.', { exact: true }),
  ).toBeVisible();
  await expect(popover.getByRole('button', { name: 'Don’t move', exact: true })).toBeVisible();
  expect(move.posts).toEqual([{ action: 'when-idle', ...PROCESS }]);
});

test('a move whose tab-menu popover was closed reports its outcome on that session', async ({
  page,
  context,
}) => {
  const move = await tabsWithMove(context);
  await page.goto('/#capability=test');
  const tabs = page.getByRole('tablist', { name: 'Sessions in repo' });
  await tabs.getByRole('tab', { name: /Session A/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Gloss…' }).click();
  const popover = page.getByRole('dialog', { name: 'Move to Gloss' });
  move.afterPost({ state: 'moving' });
  await popover.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(popover.getByText('Moving the session to Gloss…', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  move.set({ state: 'unavailable', reason: 'x', failure: { reason: EXITED, manual: MANUAL } });
  await tabs.getByRole('tab', { name: /Session A/ }).click();
  await expect(page.getByRole('status').filter({ hasText: EXITED })).toContainText(
    MANUAL.cdCommand,
  );
});

test('two popovers for one session send one move, and a confirmation never outlives its status', async ({
  page,
  context,
}) => {
  const move = await tabsWithMove(context);
  // The workspace shows the connect dialog only for a Claude record.
  for (const record of move.records) record.target.agent = 'claude';
  await context.route('**/api/sessions/*/claude-route', (r) =>
    r.fulfill({ json: { transport: null, reason: 'Gloss can’t reach this session yet.' } }),
  );
  await context.route('**/api/sessions/*/claude-channel', (r) =>
    r.fulfill({ json: { state: 'setup-required' } }),
  );
  await page.goto('/#capability=test');
  const tabs = page.getByRole('tablist', { name: 'Sessions in repo' });
  await tabs.getByRole('tab', { name: /Session A/ }).click();
  await page.getByText(/Connect this session to Gloss/).click();
  const connect = page.locator('.claude-connection');
  await connect.getByRole('button', { name: 'Move to Gloss', exact: true }).click();
  const connectConfirm = connect.getByRole('dialog', { name: 'Move to Gloss' });
  await expect(connectConfirm.getByRole('button', { name: 'Move', exact: true })).toBeEnabled();
  // Keyboard only, so the connect popover is not closed by an outside click.
  await tabs.getByRole('tab', { name: /Session A/ }).press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Move to Gloss…' }).press('Enter');
  const menuPopover = page.locator('.session-context').getByRole('dialog', {
    name: 'Move to Gloss',
  });
  const release = move.hold();
  move.afterPost({ state: 'in-gloss' });
  await menuPopover.getByRole('button', { name: 'Move', exact: true }).press('Enter');
  await expect(
    menuPopover.getByText('Moving the session to Gloss…', { exact: true }),
  ).toBeVisible();
  // While the first move is being sent, the other popover shows it and can't send a second one.
  await expect(
    connectConfirm.getByText('Moving the session to Gloss…', { exact: true }),
  ).toBeVisible();
  await expect(connectConfirm.getByRole('button', { name: 'Move', exact: true })).toHaveCount(0);
  release();
  // The session left the state the confirmation was opened from, so it is gone, not left armed.
  await expect(
    connectConfirm.getByText('This session now runs in Gloss.', { exact: true }),
  ).toBeVisible();
  await expect(connectConfirm.getByRole('button', { name: 'Move', exact: true })).toHaveCount(0);
  expect(move.posts).toEqual([{ action: 'move', ...PROCESS }]);
});

test('a popover whose status changes under it drops its confirmation and sends nothing', async ({
  page,
}) => {
  const move = await outsideSession(page, { state: 'ready', process: PROCESS });
  const connect = page.locator('.claude-connection');
  await connect.getByRole('button', { name: 'Move to Gloss', exact: true }).click();
  const popover = connect.getByRole('dialog', { name: 'Move to Gloss' });
  await expect(popover.getByRole('button', { name: 'Move', exact: true })).toBeVisible();
  // Another window moved it meanwhile.
  move.set({ state: 'in-gloss' });
  await expect(popover.getByText('This session now runs in Gloss.', { exact: true })).toBeVisible();
  await expect(popover.getByRole('button', { name: 'Move', exact: true })).toHaveCount(0);
  expect(move.posts).toEqual([]);
});

async function claudeTabsWithMove(context: BrowserContext, launched = 'B') {
  const move = await tabsWithMove(context, launched);
  for (const record of move.records) record.target.agent = 'claude';
  await context.route('**/api/sessions/*/claude-route', (r) =>
    r.fulfill({ json: { transport: null, reason: 'Gloss can’t reach this session yet.' } }),
  );
  await context.route('**/api/sessions/*/claude-channel', (r) =>
    r.fulfill({ json: { state: 'setup-required' } }),
  );
  return move;
}
const liveViews = (page: Page) =>
  page.locator('.pane-live > .pane-toolbar').getByRole('radiogroup', {
    name: 'Live Conversation view',
  });
const moveHere = (page: Page) =>
  page
    .locator('.pane-live > .pane-toolbar')
    .getByRole('button', { name: 'Move session here', exact: true });

test('“Move session here” replaces Split and Terminal only for outside Claude sessions', async ({
  page,
  context,
}) => {
  const move = await claudeTabsWithMove(context);
  await page.goto('/#capability=test');
  const tabs = page.getByRole('tablist', { name: 'Sessions in repo' });
  await tabs.getByRole('tab', { name: /Session B/ }).click();
  await expect(liveViews(page).getByRole('radio', { name: 'Split' })).toBeEnabled();
  await expect(liveViews(page).getByRole('radio', { name: 'Terminal' })).toBeEnabled();
  await expect(moveHere(page)).toHaveCount(0);
  await tabs.getByRole('tab', { name: /Session A/ }).click();
  await expect(moveHere(page)).toBeVisible();
  // It is clickable, so it looks like the enabled buttons beside it, not like the disabled ones it replaced.
  await expect(moveHere(page)).toBeEnabled();
  await expect(moveHere(page)).not.toHaveAttribute('aria-disabled');
  const look = (target: Locator) =>
    target.evaluate((el) => {
      const style = getComputedStyle(el);
      return [style.color, style.backgroundColor, style.opacity, style.cursor];
    });
  expect(await look(moveHere(page))).toEqual(
    await look(liveViews(page).getByRole('radio', { name: 'Original' })),
  );
  await expect(liveViews(page).getByRole('radio', { name: 'Translated' })).toBeVisible();
  await expect(liveViews(page).getByRole('radio', { name: 'Split' })).toHaveCount(0);
  await expect(liveViews(page).getByRole('radio', { name: 'Terminal' })).toHaveCount(0);
  await moveHere(page).click();
  const popover = page.locator('.pane-live').getByRole('dialog', { name: 'Move to Gloss' });
  await expect(popover.getByText(CONFIRMATION, { exact: true })).toBeVisible();
  await popover.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(popover).toHaveCount(0);
  await expect(moveHere(page)).toBeFocused();
  expect(move.posts).toEqual([]);
  await moveHere(page).click();
  move.afterPost({ state: 'in-gloss' });
  await popover.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(popover.getByText('This session now runs in Gloss.', { exact: true })).toBeVisible();
  expect(move.posts).toEqual([{ action: 'move', ...PROCESS }]);
});

test('“Move session here” for a working session offers Move when it finishes', async ({
  page,
  context,
}) => {
  const move = await claudeTabsWithMove(context);
  move.set({ state: 'busy', reason: WORKING, process: PROCESS });
  await page.goto('/#capability=test');
  await page
    .getByRole('tablist', { name: 'Sessions in repo' })
    .getByRole('tab', { name: /Session A/ })
    .click();
  await moveHere(page).click();
  const popover = page.locator('.pane-live').getByRole('dialog', { name: 'Move to Gloss' });
  await expect(popover.getByText(WORKING, { exact: true })).toBeVisible();
  move.afterPost({ state: 'waiting' });
  await popover.getByRole('button', { name: 'Move when it finishes', exact: true }).click();
  await expect(
    popover.getByText('Gloss will move this session when Claude finishes.', { exact: true }),
  ).toBeVisible();
  expect(move.posts).toEqual([{ action: 'when-idle', ...PROCESS }]);
});

const DISPLAY_KEY = 'language-assistant:display:v1';
const storedNoConfirm = (page: Page) =>
  page.evaluate((key) => {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    return saved && typeof saved === 'object' && 'moveWithoutConfirmation' in saved
      ? saved.moveWithoutConfirmation
      : undefined;
  }, DISPLAY_KEY);
async function withoutConfirmation(target: Page | BrowserContext) {
  await target.addInitScript(
    (key) =>
      localStorage.setItem(key, JSON.stringify({ version: 1, moveWithoutConfirmation: true })),
    DISPLAY_KEY,
  );
}
const liveNotice = (page: Page) => page.locator('.pane-live > .pane-toolbar').getByRole('status');

test('Don’t ask again: the next click moves at once with no popover, and the notice shows the outcome', async ({
  page,
  context,
}) => {
  const move = await claudeTabsWithMove(context);
  await page.goto('/#capability=test');
  await page
    .getByRole('tablist', { name: 'Sessions in repo' })
    .getByRole('tab', { name: /Session A/ })
    .click();
  await moveHere(page).click();
  const popover = page.locator('.pane-live').getByRole('dialog', { name: 'Move to Gloss' });
  await popover.getByRole('checkbox', { name: 'Don’t ask again' }).check();
  move.afterPost({ state: 'in-gloss' });
  await popover.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(popover.getByText('This session now runs in Gloss.', { exact: true })).toBeVisible();
  expect(await storedNoConfirm(page)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  // A new Claude process: the identity sent is the one in the status read for this click.
  const next = { pid: 5151, procStart: 'Sat Oct 18 11:00:00 2026' };
  move.set({ state: 'ready', process: next });
  const release = move.hold();
  move.afterPost({
    state: 'unavailable',
    reason: 'x',
    failure: { reason: EXITED, manual: MANUAL },
  });
  await moveHere(page).click();
  await expect(liveNotice(page)).toHaveText('Moving the session to Gloss…');
  await expect(page.getByRole('dialog', { name: 'Move to Gloss' })).toHaveCount(0);
  release();
  await expect(liveNotice(page)).toContainText(EXITED);
  await expect(liveNotice(page)).toContainText(MANUAL.cdCommand);
  await expect(page.getByRole('dialog', { name: 'Move to Gloss' })).toHaveCount(0);
  expect(move.posts).toEqual([
    { action: 'move', ...PROCESS },
    { action: 'move', ...next },
  ]);
});

test('without asking, the tab menu waits for a working session, and an unavailable one still explains why', async ({
  page,
  context,
}) => {
  await withoutConfirmation(context);
  const move = await claudeTabsWithMove(context);
  move.set({ state: 'busy', reason: WORKING, process: PROCESS });
  await page.goto('/#capability=test');
  const tabs = page.getByRole('tablist', { name: 'Sessions in repo' });
  await tabs.getByRole('tab', { name: /Session A/ }).click();
  move.afterPost({ state: 'waiting' });
  await tabs.getByRole('tab', { name: /Session A/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Gloss…' }).click();
  await expect(liveNotice(page)).toHaveText('Gloss will move this session when Claude finishes.');
  await expect(page.getByRole('dialog', { name: 'Move to Gloss' })).toHaveCount(0);
  expect(move.posts).toEqual([{ action: 'when-idle', ...PROCESS }]);
  // The wait can still be cancelled: the popover opens for a state there is nothing to do at once.
  await moveHere(page).click();
  const popover = page.locator('.pane-live').getByRole('dialog', { name: 'Move to Gloss' });
  await expect(popover.getByRole('button', { name: 'Don’t move', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  // The waited-for session closed: the wait ends with the reason as the notice, and a new click explains it.
  move.set({
    state: 'unavailable',
    reason: 'This Claude session isn’t running in a terminal now.',
  });
  await expect(liveNotice(page)).toHaveText('This Claude session isn’t running in a terminal now.');
  await moveHere(page).click();
  await expect(
    popover.getByText('This Claude session isn’t running in a terminal now.', { exact: true }),
  ).toBeVisible();
  expect(move.posts).toEqual([{ action: 'when-idle', ...PROCESS }]);
});

test('without asking, the tab’s Move icon moves at once with one POST and no popover', async ({
  page,
  context,
}) => {
  await withoutConfirmation(context);
  const move = await claudeTabsWithMove(context);
  await page.goto('/#capability=test');
  const tabs = page.getByRole('tablist', { name: 'Sessions in repo' });
  await tabs.getByRole('tab', { name: /Session A/ }).click();
  move.afterPost({ state: 'moving' });
  await tabs.getByRole('tab', { name: /Session A/ }).hover();
  await tabButton(page, 'Move Session A to Gloss').click();
  await expect(liveNotice(page)).toHaveText('Moving the session to Gloss…');
  await expect(page.getByRole('dialog', { name: 'Move to Gloss' })).toHaveCount(0);
  expect(move.posts).toEqual([{ action: 'move', ...PROCESS }]);
});

test('Settings → Ask before moving a session restores the popover at once', async ({ page }) => {
  await withoutConfirmation(page);
  await page.route('**/api/settings/language', (r) =>
    r.fulfill({ json: { write: 'he', send: 'en', reply: 'he', assist: 'he' } }),
  );
  const move = await outsideSession(page, { state: 'ready', process: PROCESS });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const ask = settings
    .getByRole('region', { name: 'Claude connection' })
    .getByRole('checkbox', { name: 'Ask before moving a session' });
  await expect(ask).not.toBeChecked();
  await ask.check();
  expect(await storedNoConfirm(page)).toBe(false);
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(settings).toBeHidden();
  await moveHere(page).click();
  const popover = page.locator('.pane-live').getByRole('dialog', { name: 'Move to Gloss' });
  await expect(popover.getByText(CONFIRMATION, { exact: true })).toBeVisible();
  await expect(popover.getByRole('checkbox', { name: 'Don’t ask again' })).not.toBeChecked();
  expect(move.posts).toEqual([]);
});

test('a popover whose Claude process changes under it drops its confirmation and sends nothing', async ({
  page,
}) => {
  const move = await outsideSession(page, { state: 'ready', process: PROCESS });
  const connect = page.locator('.claude-connection');
  await connect.getByRole('button', { name: 'Move to Gloss', exact: true }).click();
  const popover = connect.getByRole('dialog', { name: 'Move to Gloss' });
  await expect(popover.getByRole('button', { name: 'Move', exact: true })).toBeVisible();
  move.set({ state: 'ready', process: { pid: 5151, procStart: PROCESS.procStart } });
  await expect(popover).toHaveCount(0);
  await expect(connect.getByRole('button', { name: 'Move to Gloss', exact: true })).toBeVisible();
  expect(move.posts).toEqual([]);
});

test('without asking, a double click on “Move session here” sends one move', async ({
  page,
  context,
}) => {
  await withoutConfirmation(context);
  const move = await claudeTabsWithMove(context);
  await page.goto('/#capability=test');
  await page
    .getByRole('tablist', { name: 'Sessions in repo' })
    .getByRole('tab', { name: /Session A/ })
    .click();
  const release = move.holdReads();
  move.afterPost({ state: 'moving' });
  await moveHere(page).click();
  await moveHere(page).click();
  release();
  await expect(liveNotice(page)).toHaveText('Moving the session to Gloss…');
  await moveHere(page).click();
  await expect(liveNotice(page)).toHaveText('Moving the session to Gloss…');
  expect(move.posts).toEqual([{ action: 'move', ...PROCESS }]);
});

test('the tab menu popover stays inside the window for the last tab', async ({ page, context }) => {
  await page.setViewportSize({ width: 540, height: 700 });
  await tabsWithMove(context, 'A');
  await page.goto('/#capability=test');
  const tab = page
    .getByRole('tablist', { name: 'Sessions in repo' })
    .getByRole('tab', { name: /Session B/ });
  const box = await tab.boundingBox();
  if (!box) throw new Error('no tab box');
  await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Gloss…' }).click();
  const popover = page.getByRole('dialog', { name: 'Move to Gloss' });
  await expect(popover.getByText(CONFIRMATION, { exact: true })).toBeVisible();
  const shown = await popover.boundingBox();
  if (!shown) throw new Error('no popover box');
  expect(shown.x).toBeGreaterThanOrEqual(0);
  expect(shown.x + shown.width).toBeLessThanOrEqual(540);
});
