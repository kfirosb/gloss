import { test, expect } from '@playwright/test';
import { sessionFixture } from './multi-session-fixture.js';

type Fixture = Awaited<ReturnType<typeof sessionFixture>>;
const entryFor = (f: Fixture, index: number, extra: Record<string, unknown> = {}) => {
  const r = f.records[index]!;
  return {
    key: r.id,
    sessionId: r.id,
    target: { ...r.target, agent: 'claude' as const },
    projectKey: '/repo/.git',
    projectName: 'repo',
    sessionTitle: 'Session ' + r.id,
    worktreePath: '/repo',
    open: true,
    activity: 'idle',
    availability: 'available',
    ...extra,
  };
};
async function serve(context: any, entries: any[]) {
  const catalog = { epoch: 'n', sequence: 1, discovery: { state: 'healthy' }, entries };
  await context.route('**/api/session-catalog', (r: any) => r.fulfill({ json: catalog }));
  await context.route('**/api/session-catalog/events', (r: any) =>
    r.fulfill({
      contentType: 'text/event-stream',
      body: 'data: ' + JSON.stringify(catalog) + '\n\n',
    }),
  );
}

test('+ opens the dialog and launches with the chosen agent and only the changed languages', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  await serve(context, [entryFor(f, 0), entryFor(f, 1)]);
  const launched: any[] = [];
  const languagePuts: any[] = [];
  await context.route('**/api/settings/language', (r) =>
    r.fulfill({ json: { write: 'he', send: 'en', reply: 'he', assist: 'he' } }),
  );
  await context.route('**/api/launches', (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    const body = r.request().postDataJSON();
    launched.push(body);
    return r.fulfill({ json: { id: 'L9', ...body, panePid: 5, state: 'starting', createdAt: 0 } });
  });
  await context.route('**/api/sessions/*/language', (r) => {
    languagePuts.push(r.request().method());
    return r.fulfill({ json: {} });
  });
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'New session' }).click();
  const dialog = page.getByRole('dialog', { name: 'New session' });
  await dialog.getByRole('radio', { name: 'Codex' }).check();
  await dialog.getByLabel('Show agent replies in').selectOption('en');
  await dialog.getByRole('button', { name: 'Open session' }).click();
  await expect(dialog).toBeHidden();
  expect(launched).toEqual([
    { agent: 'codex', folder: '/repo', languageOverride: { reply: 'en' } },
  ]);
  expect(languagePuts).toEqual([]);
});
test('unchanged languages send no override and a launch error stays in the dialog', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  await serve(context, [entryFor(f, 0)]);
  const launched: any[] = [];
  await context.route('**/api/settings/language', (r) =>
    r.fulfill({ json: { write: 'he', send: 'en', reply: 'he', assist: 'he' } }),
  );
  await context.route('**/api/launches', (r) => {
    launched.push(r.request().postDataJSON());
    return r.fulfill({ status: 400, json: { error: 'tmux is not installed.' } });
  });
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'New session' }).click();
  const dialog = page.getByRole('dialog', { name: 'New session' });
  await dialog.getByRole('button', { name: 'Open session' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('tmux is not installed.');
  expect(launched).toEqual([{ agent: 'claude', folder: '/repo' }]);
});
test('a launch without a panel shows a Starting tab', async ({ page, context }) => {
  const f = await sessionFixture(context);
  await serve(context, [
    entryFor(f, 0),
    {
      ...entryFor(f, 1),
      key: 'launch:L2',
      sessionId: undefined,
      sessionTitle: undefined,
      launchId: 'L2',
      launchState: 'starting',
    },
  ]);
  await page.goto('/#capability=test');
  await expect(page.getByRole('tab', { name: /Starting…/ })).toBeVisible();
});
test('hovering a session tab turns its dot into an X that ends the session at once', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  await serve(context, [entryFor(f, 0, { launchId: 'L1', launchState: 'running' })]);
  const ended: string[] = [];
  await context.route('**/api/launches/L1/end', (r) => {
    ended.push('L1');
    return r.fulfill({ json: {} });
  });
  await page.goto('/#capability=test');
  const tab = page.getByRole('tab', { name: /Session A/ });
  const close = page.getByRole('button', { name: 'End Session A' });
  await expect(close).toBeHidden();
  await tab.hover();
  await expect(close).toBeVisible();
  await close.click();
  await expect.poll(() => ended).toEqual(['L1']);
  await expect(page.getByRole('dialog', { name: 'End session' })).toHaveCount(0);
});
test('End session in the context menu ends at once and a failure says why', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  await serve(context, [entryFor(f, 0, { launchId: 'L1', launchState: 'running' })]);
  await context.route('**/api/launches/L1/end', (r) =>
    r.fulfill({ status: 400, json: { error: 'tmux command failed: lost server' } }),
  );
  await page.goto('/#capability=test');
  await page.getByRole('tab', { name: /Session A/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'End session', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'End session' })).toHaveCount(0);
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Could not end Session A: tmux command failed: lost server' }),
  ).toBeVisible();
});
test('the context menu opens from the keyboard and Escape returns focus to the tab', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  await serve(context, [
    entryFor(f, 0, { launchId: 'L1', launchState: 'running' }),
    entryFor(f, 1),
  ]);
  await page.goto('/#capability=test');
  const tab = page.getByRole('tab', { name: /Session A/ });
  await tab.focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'End session', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(tab).toBeFocused();
  await page.keyboard.press('ContextMenu');
  await expect(page.getByRole('menuitem', { name: 'End session', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  const other = page.getByRole('tab', { name: /Session B/ });
  await other.focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu')).toHaveCount(0);
});
test('+ is available before any folder exists and the dialog explains how to get one', async ({
  page,
  context,
}) => {
  await sessionFixture(context);
  await serve(context, []);
  await context.route('**/api/sessions', (r) => r.fulfill({ json: [] }));
  await context.route('**/api/settings/language', (r) =>
    r.fulfill({ json: { write: 'he', send: 'en', reply: 'he', assist: 'he' } }),
  );
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'New session' }).click();
  const dialog = page.getByRole('dialog', { name: 'New session' });
  await expect(dialog).toContainText('No project folders yet.');
  await expect(dialog.getByRole('button', { name: 'Open session' })).toBeDisabled();
  await expect(dialog).toContainText('If it asks for approval, use Show terminal.');
});
test('a Starting tab offers Show terminal and Retry connection from its context menu', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  await serve(context, [
    entryFor(f, 0),
    {
      ...entryFor(f, 1),
      key: 'launch:L2',
      sessionId: undefined,
      sessionTitle: undefined,
      launchId: 'L2',
      launchState: 'starting',
      availability: 'unavailable',
      activity: 'connecting',
    },
  ]);
  const retried: string[] = [];
  await context.route('**/api/launches/L2/identify', (r) => {
    retried.push(r.request().method());
    return r.fulfill({ status: 202, json: {} });
  });
  await context.route('**/api/launches/L2/terminal-ticket', (r) =>
    r.fulfill({ json: { ticket: 'tk2', expiresAt: Date.now() + 30000 } }),
  );
  await page.routeWebSocket(/\/api\/launches\/L2\/terminal\?ticket=tk2/, (ws) => {
    ws.send('Quick safety check');
  });
  await page.goto('/#capability=test');
  const tab = page.getByRole('tab', { name: /Starting…/ });
  await tab.click({ button: 'right', force: true }); // Unselectable (aria-disabled), but its menu still opens.
  await page.getByRole('menuitem', { name: 'Show terminal' }).click();
  const popup = page.getByRole('dialog', { name: /Terminal:/ });
  await expect(popup.locator('.xterm')).toContainText('Quick safety check');
  await popup.getByRole('button', { name: /Close terminal/ }).click();
  await expect(popup).toBeHidden();
  await tab.click({ button: 'right', force: true }); // Unselectable (aria-disabled), but its menu still opens.
  await page.getByRole('menuitem', { name: 'Retry connection' }).click();
  await expect.poll(() => retried).toEqual(['POST', 'POST']); // closing the popup retries once, then the menu item
});

test('the folder picker deduplicates a shared path shown under multiple projects', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  await serve(context, [
    entryFor(f, 0),
    { ...entryFor(f, 1), projectKey: '/another/.git', projectName: 'another' },
  ]);
  await context.route('**/api/settings/language', (r) =>
    r.fulfill({ json: { write: 'he', send: 'en', reply: 'he', assist: 'he' } }),
  );
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'New session' }).click();
  const folder = page.getByRole('combobox', { name: 'Folder' });
  await expect(folder.locator('option[value="/repo"]')).toHaveCount(1);
});

async function launchAndWait(page: any, context: any, popup: string) {
  const f = await sessionFixture(context);
  const row = (extra: Record<string, unknown>) => ({
    ...entryFor(f, 1),
    key: 'launch:L9',
    sessionId: undefined,
    sessionTitle: undefined,
    launchId: 'L9',
    launchState: 'starting',
    availability: 'unavailable',
    ...extra,
  });
  let catalog: any = {
    epoch: 'n',
    sequence: 1,
    discovery: { state: 'healthy' },
    entries: [entryFor(f, 0)],
  };
  await context.route('**/api/session-catalog', (r: any) => r.fulfill({ json: catalog }));
  await context.route('**/api/session-catalog/events', (r: any) =>
    r.fulfill({
      contentType: 'text/event-stream',
      body: 'data: ' + JSON.stringify(catalog) + '\n\n',
    }),
  );
  await context.route('**/api/settings/launch', (r: any) =>
    r.fulfill({ json: { extraArgs: { claude: [], codex: [] }, popup } }),
  );
  await context.route('**/api/settings/language', (r: any) =>
    r.fulfill({ json: { write: 'he', send: 'en', reply: 'he', assist: 'he' } }),
  );
  await context.route('**/api/launches', (r: any) =>
    r.request().method() !== 'POST'
      ? r.fallback()
      : r.fulfill({
          json: { id: 'L9', agent: 'claude', folder: '/repo', state: 'starting', createdAt: 0 },
        }),
  );
  const identified: string[] = [];
  await context.route('**/api/launches/L9/identify', (r: any) => {
    identified.push('x');
    return r.fulfill({ status: 202, json: {} });
  });
  await context.route('**/api/launches/L9/terminal-ticket', (r: any) =>
    r.fulfill({ json: { ticket: 'tk9', expiresAt: Date.now() + 30000 } }),
  );
  await page.routeWebSocket(/\/api\/launches\/L9\/terminal\?ticket=tk9/, (ws: any) => {
    ws.send('Hooks need review');
  });
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'New session' }).click();
  await page
    .getByRole('dialog', { name: 'New session' })
    .getByRole('button', { name: 'Open session' })
    .click();
  await expect(page.getByRole('dialog', { name: 'New session' })).toBeHidden();
  catalog = {
    ...catalog,
    sequence: 2,
    entries: [entryFor(f, 0), row({ activity: 'approval-required' })],
  };
  // The mocked stream ends at once, so the client reconnects within a second and reads the new catalog.
  return identified;
}
test('a launch waiting for approval before it is identified opens its terminal, and closing it retries identification', async ({
  page,
  context,
}) => {
  const identified = await launchAndWait(page, context, 'auto');
  const popup = page.getByRole('dialog', { name: /Terminal:/ });
  await expect(popup.locator('.xterm')).toContainText('Hooks need review', { timeout: 10_000 });
  expect(identified).toEqual([]);
  await popup.getByRole('button', { name: /Close terminal/ }).click();
  await expect(popup).toBeHidden();
  await expect.poll(() => identified.length).toBe(1);
});
test('dot-only never opens a waiting launch automatically', async ({ page, context }) => {
  await launchAndWait(page, context, 'dot-only');
  await expect(page.getByRole('tab', { name: /Starting…/ })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(3500);
  await expect(page.getByRole('dialog', { name: /Terminal:/ })).toHaveCount(0);
});
test('the first message is prefilled per agent, sent only when edited, and required', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  await serve(context, [entryFor(f, 0)]);
  const launched: any[] = [];
  await context.route('**/api/settings/language', (r) =>
    r.fulfill({ json: { write: 'he', send: 'en', reply: 'he', assist: 'he' } }),
  );
  await context.route('**/api/launches', (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    const body = r.request().postDataJSON();
    launched.push(body);
    return r.fulfill({ json: { id: 'L9', ...body, panePid: 5, state: 'starting', createdAt: 0 } });
  });
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'New session' }).click();
  const dialog = page.getByRole('dialog', { name: 'New session' });
  const message = dialog.getByLabel('First message');
  await expect(message).toHaveValue('Reply with READY only. Do not use tools.');
  await dialog.getByRole('radio', { name: 'Codex' }).check();
  await expect(message).toHaveValue('Reply with READY only. Do not run commands.');
  await message.fill('');
  await expect(dialog.getByRole('button', { name: 'Open session' })).toBeDisabled();
  await expect(
    dialog.getByText('A first message is required: it is what lets Gloss connect to the session'),
  ).toBeVisible();
  await message.fill('Review the diff');
  await dialog.getByRole('radio', { name: 'Claude' }).check();
  await expect(message).toHaveValue('Review the diff'); // an edited message survives switching agents
  await dialog.getByRole('button', { name: 'Open session' }).click();
  await expect(dialog).toBeHidden();
  expect(launched).toEqual([{ agent: 'claude', folder: '/repo', prompt: 'Review the diff' }]);
});
test('Terminal hides the message and languages and opens a shell', async ({ page, context }) => {
  const f = await sessionFixture(context);
  await serve(context, [entryFor(f, 0)]);
  const launched: any[] = [];
  await context.route('**/api/settings/language', (r) =>
    r.fulfill({ json: { write: 'he', send: 'en', reply: 'he', assist: 'he' } }),
  );
  await context.route('**/api/launches', (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    const body = r.request().postDataJSON();
    launched.push(body);
    return r.fulfill({
      json: { id: 'T9', ...body, title: 'Terminal', panePid: 5, state: 'running', createdAt: 0 },
    });
  });
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'New session' }).click();
  const dialog = page.getByRole('dialog', { name: 'New session' });
  await dialog.getByRole('radio', { name: 'Terminal' }).check();
  await expect(dialog.getByLabel('First message')).toHaveCount(0);
  await expect(dialog.getByLabel('Show agent replies in')).toHaveCount(0);
  await expect(
    dialog.getByText('Opens a shell in this folder. Nothing is launched inside it.'),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Open terminal' }).click();
  await expect(dialog).toBeHidden();
  expect(launched).toEqual([{ agent: 'shell', folder: '/repo' }]);
});
