import { test, expect } from '@playwright/test';
import { expectSelected, pastFromCatalog, routePastSessions } from './session-fixture.js';
import { sessionFixture } from './multi-session-fixture.js';
import type { CatalogSnapshot } from '../../src/core/session-catalog.js';

function catalogFor(
  f: Awaited<ReturnType<typeof sessionFixture>>,
  overrides: Record<string, Partial<CatalogSnapshot['entries'][number]>> = {},
): CatalogSnapshot {
  return {
    epoch: 'tabs',
    sequence: 1,
    discovery: { state: 'healthy' },
    entries: f.records.map((r) => ({
      key: r.id,
      sessionId: r.id,
      target: { ...r.target, agent: 'codex' as const },
      projectKey: '/repo/.git',
      projectName: 'repo',
      sessionTitle: `Session ${r.id}`,
      worktreePath: '/repo',
      open: true,
      activity: 'idle' as const,
      availability: 'available' as const,
      ...overrides[r.id],
    })),
  };
}
async function serve(context: any, catalog: CatalogSnapshot) {
  await context.route('**/api/session-catalog', (r: any) => r.fulfill({ json: catalog }));
  await context.route('**/api/session-catalog/events', (r: any) =>
    r.fulfill({
      contentType: 'text/event-stream',
      body: 'data: ' + JSON.stringify(catalog) + '\n\n',
    }),
  );
}

test('one click switches tabs and each tab keeps its draft', async ({ page, context }) => {
  const f = await sessionFixture(context);
  await serve(context, catalogFor(f));
  await page.goto('/#capability=test');
  const tabs = page.getByRole('tablist', { name: 'Sessions in repo' });
  await expect(tabs.getByRole('tab')).toHaveCount(2);
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.fill('Draft A');
  await tabs.getByRole('tab', { name: /Session B/ }).click();
  await expect(tabs.getByRole('tab', { name: /Session B/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(input).toHaveValue('');
  await tabs.getByRole('tab', { name: /Session A/ }).click();
  await expect(input).toHaveValue('Draft A');
});
test('activity dots have text labels and keyboard moves between tabs', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  await serve(context, catalogFor(f, { B: { activity: 'approval-required' } }));
  await page.goto('/#capability=test');
  const tabs = page.getByRole('tablist', { name: 'Sessions in repo' });
  await expect(
    tabs.getByRole('tab', { name: /Session B/ }).getByLabel('Approval required'),
  ).toBeVisible();
  await tabs.getByRole('tab', { name: /Session A/ }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: /Session B/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(tabs.getByRole('tab', { name: /Session B/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});
test('a closed selected session moves to Saved and stays selected', async ({ page, context }) => {
  const f = await sessionFixture(context);
  const catalog = catalogFor(f, { A: { open: false, activity: 'disconnected' } });
  await serve(context, catalog);
  await routePastSessions(
    context,
    pastFromCatalog(() => catalog),
  );
  await page.goto('/#capability=test');
  const tabs = page.getByRole('tablist', { name: 'Sessions in repo' });
  await expect(tabs.getByRole('tab')).toHaveCount(1);
  await page.getByRole('button', { name: 'Saved sessions (1)' }).click();
  await expect(page.getByRole('menuitem', { name: /Session A/ })).toBeVisible();
  await expect(page.locator('.session-header')).toContainText('Disconnected');
});
test('a folder with only saved sessions shows the empty state and the Saved menu', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  const catalog = catalogFor(f, {
    A: { open: false, activity: 'disconnected' },
    B: { open: false, activity: 'disconnected' },
  });
  await serve(context, catalog);
  await routePastSessions(
    context,
    pastFromCatalog(() => catalog),
  );
  await page.goto('/#capability=test');
  await expect(page.getByText('No open sessions in this folder.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Saved sessions (2)' })).toBeVisible();
});
test('narrow viewport keeps the selected tab in view without page overflow', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  const f = await sessionFixture(context);
  const catalog = catalogFor(f);
  const extras = Array.from({ length: 6 }, (_, i) => {
    const { sessionId: _omit, ...base } = catalog.entries[1]!;
    return {
      ...base,
      key: 'X' + i,
      sessionTitle: 'Extra ' + i,
      target: { ...catalog.entries[1]!.target, sessionRef: 'X' + i },
    };
  });
  catalog.entries.unshift(...extras);
  await serve(context, catalog);
  await page.goto('/#capability=test');
  const tabs = page.getByRole('tablist', { name: 'Sessions in repo' });
  await expect(tabs.getByRole('tab', { name: /Session A/ })).toBeInViewport();
  expect(await tabs.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await tabs.getByRole('tab', { name: /Session B/ }).click();
  await expect(tabs.getByRole('tab', { name: /Session B/ })).toBeInViewport();
  await tabs.getByRole('tab', { name: /Extra 0/ }).scrollIntoViewIfNeeded();
  await tabs.getByRole('tab', { name: /Session A/ }).focus();
  await page.keyboard.press('Enter');
  await expect(tabs.getByRole('tab', { name: /Session A/ })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('tabs do not show a per-tab language badge', async ({ page, context }) => {
  const f = await sessionFixture(context);
  await serve(context, catalogFor(f, { A: { languageCode: 'HE→EN→HE' } }));
  await page.goto('/#capability=test');
  const tabs = page.getByRole('tablist', { name: 'Sessions in repo' });
  await expect(tabs.getByRole('tab', { name: /Session A/ })).toBeVisible();
  await expect(tabs.locator('.session-tab-language')).toHaveCount(0);
});
test('roving tabindex always leaves exactly one tab reachable', async ({ page, context }) => {
  const f = await sessionFixture(context);
  const catalog = catalogFor(f);
  await serve(context, catalog);
  await page.goto('/#capability=test');
  const tabs = page.getByRole('tablist', { name: 'Sessions in repo' });
  await expect(tabs.getByRole('tab')).toHaveCount(2);
  await tabs.getByRole('tab', { name: /Session A/ }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: /Session B/ })).toBeFocused();
  await tabs.getByRole('tab', { name: /Session A/ }).click();
  await expect(tabs.getByRole('tab', { name: /Session A/ })).toHaveAttribute('tabindex', '0');
  await expect(tabs.getByRole('tab', { name: /Session B/ })).toHaveAttribute('tabindex', '-1');
  await tabs.getByRole('tab', { name: /Session A/ }).focus();
  await page.keyboard.press('ArrowRight');
  const closed = catalogFor(f, { B: { open: false, activity: 'disconnected' } });
  await context.unroute('**/api/session-catalog/events');
  await context.unroute('**/api/session-catalog');
  closed.sequence = 2;
  await serve(context, closed);
  await page.reload();
  await expect(tabs.getByRole('tab')).toHaveCount(1);
  await expect(tabs.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
});

test('choosing a folder shows its tabs and returns to its last tab', async ({ page, context }) => {
  const f = await sessionFixture(context);
  const catalog = catalogFor(f, { B: { worktreePath: '/wt/feature' } });
  await serve(context, catalog);
  await page.goto('/#capability=test');
  const sidebar = page.getByRole('navigation', { name: 'Sessions' });
  await expect(sidebar.getByRole('button', { name: 'main, 1 open' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await sidebar.getByRole('button', { name: 'feature, 1 open' }).click();
  await expect(
    page
      .getByRole('tablist', { name: 'Sessions in feature' })
      .getByRole('tab', { name: /Session B/ }),
  ).toHaveAttribute('aria-selected', 'true');
  await sidebar.getByRole('button', { name: 'main, 1 open' }).click();
  await expect(
    page.getByRole('tablist', { name: 'Sessions in main' }).getByRole('tab', { name: /Session A/ }),
  ).toHaveAttribute('aria-selected', 'true');
});
test('a newly discovered session adds a tab without stealing selection', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  const catalog = catalogFor(f);
  const second = {
    ...catalog,
    sequence: 2,
    entries: [
      ...catalog.entries,
      {
        ...catalog.entries[1]!,
        key: 'N',
        sessionId: undefined,
        sessionTitle: 'New one',
        target: { ...catalog.entries[1]!.target, sessionRef: 'N' },
      },
    ],
  };
  await context.route('**/api/session-catalog', (r: any) => r.fulfill({ json: catalog }));
  await context.route('**/api/session-catalog/events', (r: any) =>
    r.fulfill({
      contentType: 'text/event-stream',
      body:
        'data: ' + JSON.stringify(catalog) + '\n\n' + 'data: ' + JSON.stringify(second) + '\n\n',
    }),
  );
  await page.goto('/#capability=test');
  const tabs = page.getByRole('tablist', { name: 'Sessions in repo' });
  await expect(tabs.getByRole('tab')).toHaveCount(3);
  await expect(tabs.getByRole('tab', { name: /Session A/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('with discovery unavailable, registered sessions stay reachable and can reconnect', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  f.records[1]!.enabled = false;
  await page.goto('/#capability=test');
  const sidebar = page.getByRole('navigation', { name: 'Sessions' });
  await sidebar.getByRole('button', { name: 'B, 0 open' }).click();
  await expect(page.getByText('No open sessions in this folder.')).toBeVisible();
  await page.getByRole('button', { name: 'Saved sessions (1)' }).click();
  await page.getByRole('menuitem').click();
  await expect(page.locator('.session-header')).toContainText('Disconnected');
  await sidebar.getByRole('button', { name: 'Session details' }).click();
  await expect(sidebar.getByRole('button', { name: 'Reconnect same target' })).toBeVisible();
  await sidebar.getByRole('button', { name: 'A, 0 open' }).click();
  await expect(page.getByRole('button', { name: 'Saved sessions (1)' })).toBeVisible();
});
test('a folder whose open entries cannot be selected still shows the empty state', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  const catalog = catalogFor(f, {
    A: { sessionId: undefined } as any,
    B: { worktreePath: '/wt/feature' },
  });
  await serve(context, catalog);
  await page.goto('/#capability=test');
  await page
    .getByRole('navigation', { name: 'Sessions' })
    .getByRole('button', { name: 'main, 1 open' })
    .click();
  await expect(page.getByText('No open sessions in this folder.')).toBeVisible();
});

test('an unsupported selected identity keeps its own folder active among several folders', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  const catalog = catalogFor(f, {
    A: {
      worktreePath: '/zeta',
      availability: 'unavailable',
      reason: 'Native transport unsupported',
    },
    B: { worktreePath: '/repo' },
  });
  delete catalog.entries[0]!.sessionId;
  await serve(context, catalog);
  await page.addInitScript(() => sessionStorage.setItem('selected-session', 'A'));
  await page.goto('/#capability=test');
  await expectSelected(page, 'A');
  await expect(
    page.getByRole('tablist', { name: 'Sessions in zeta' }).getByRole('tab', { name: /Session A/ }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Sessions' })
      .getByRole('button', { name: 'zeta, 1 open' }),
  ).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('tablist', { name: 'Sessions in repo' })).toHaveCount(0);
});
test('the collapsed rail icon of the selected folder only expands the sidebar', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  await serve(context, catalogFor(f, { B: { worktreePath: '/wt/feature' } }));
  await page.addInitScript(() => {
    sessionStorage.setItem('selected-session', 'B');
    localStorage.setItem('gloss:display:v1', JSON.stringify({ version: 1, collapsed: true }));
  });
  await page.goto('/#capability=test');
  await expect(page.getByRole('tablist', { name: 'Sessions in feature' })).toBeVisible();
  await page.locator('.session-rail button').first().click();
  await expect(
    page
      .getByRole('navigation', { name: 'Sessions' })
      .getByRole('button', { name: 'feature, 1 open' }),
  ).toHaveAttribute('aria-current', 'true');
  await expect(
    page
      .getByRole('tablist', { name: 'Sessions in feature' })
      .getByRole('tab', { name: /Session B/ }),
  ).toHaveAttribute('aria-selected', 'true');
});
test.describe('Saved sessions menu', () => {
  const allSaved = {
    A: { open: false, activity: 'disconnected' as const },
    B: { open: false, activity: 'disconnected' as const },
  };
  test('opens on the first item, arrows move, Enter selects and focus returns to the trigger', async ({
    page,
    context,
  }) => {
    const f = await sessionFixture(context);
    const catalog = catalogFor(f, allSaved);
    await serve(context, catalog);
    await routePastSessions(
      context,
      pastFromCatalog(() => catalog),
    );
    await page.goto('/#capability=test');
    const trigger = page.getByRole('button', { name: /Saved sessions \(2\)/ });
    await expect(trigger).toHaveAccessibleDescription('(current session inside)');
    await trigger.click();
    const items = page.getByRole('menuitem');
    await expect(items.first()).toBeFocused();
    await expect(items.first()).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expectSelected(page, 'B');
    await trigger.click();
    await expect(page.getByRole('menuitem', { name: /Session B/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });
  test('Escape returns focus to the trigger and is scoped to the menu', async ({
    page,
    context,
  }) => {
    const f = await sessionFixture(context);
    const catalog = catalogFor(f, allSaved);
    await serve(context, catalog);
    await routePastSessions(
      context,
      pastFromCatalog(() => catalog),
    );
    await page.goto('/#capability=test');
    const trigger = page.getByRole('button', { name: /Saved sessions/ });
    await trigger.click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.locator('body').press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
  });
  test('outside click closes the menu and a folder change resets it', async ({ page, context }) => {
    const f = await sessionFixture(context);
    const catalog = catalogFor(f, {
      ...allSaved,
      B: { ...allSaved.B, worktreePath: '/wt/feature' },
    });
    await serve(context, catalog);
    await routePastSessions(
      context,
      pastFromCatalog(() => catalog),
    );
    await page.goto('/#capability=test');
    const trigger = page.getByRole('button', { name: /Saved sessions/ });
    await trigger.click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.locator('.session-header').click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Sessions' })
      .getByRole('button', { name: 'feature, 0 open' })
      .click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Saved sessions/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
  test('lists past conversations with Reopen, and reopening selects the session', async ({
    page,
    context,
  }) => {
    const f = await sessionFixture(context);
    const past = {
      folder: '/repo',
      entries: [
        {
          agent: 'claude',
          sessionRef: 'c-1',
          title: 'Login fix',
          lastActiveAt: new Date().toISOString(),
          branch: 'main',
          state: 'closed',
        },
        {
          agent: 'codex',
          sessionRef: 'B',
          panelSessionId: 'B',
          title: 'Session B',
          lastActiveAt: new Date(Date.now() - 7_200_000).toISOString(),
          state: 'open-outside',
        },
      ],
    };
    await context.route('**/api/past-sessions**', (r) => r.fulfill({ json: past }));
    const posts: unknown[] = [];
    await context.route('**/api/launches/resume', (r) => {
      posts.push(r.request().postDataJSON());
      return r.fulfill({
        json: {
          id: 'R1',
          agent: 'claude',
          folder: '/repo',
          panePid: 1,
          state: 'running',
          createdAt: 0,
          sessionRef: 'c-1',
          panelSessionId: 'A',
        },
      });
    });
    await serve(context, catalogFor(f, { A: { open: true }, B: { open: false } }));
    await page.goto('/#capability=test');
    const trigger = page.getByRole('button', { name: 'Saved sessions (2)' });
    await trigger.click();
    await expect(page.getByText('Login fix')).toBeVisible();
    await expect(page.getByText('Open elsewhere')).toBeVisible();
    await page.getByRole('button', { name: 'Reopen Login fix' }).click();
    await expect
      .poll(() => posts)
      .toEqual([{ agent: 'claude', sessionRef: 'c-1', folder: '/repo' }]);
    await expectSelected(page, 'A');
    // The reopened session is selected, so the menu has nothing more to show.
    await expect(page.getByRole('menu')).toHaveCount(0);
  });
  test('a late reopen does not change a session chosen meanwhile', async ({ page, context }) => {
    const f = await sessionFixture(context);
    await routePastSessions(context, () => [
      { agent: 'claude', sessionRef: 'c-1', title: 'Login fix', state: 'closed' },
    ]);
    const held: Array<() => void> = [];
    await context.route('**/api/launches/resume', async (r) => {
      await new Promise<void>((res) => held.push(res));
      return r.fulfill({
        json: {
          id: 'R1',
          agent: 'claude',
          folder: '/repo',
          state: 'running',
          createdAt: 0,
          panelSessionId: 'A',
        },
      });
    });
    await serve(context, catalogFor(f));
    await page.goto('/#capability=test');
    await expectSelected(page, 'A');
    await page.getByRole('button', { name: 'Saved sessions (1)' }).click();
    await page.getByRole('button', { name: 'Reopen Login fix' }).click();
    await expect.poll(() => held.length).toBe(1);
    await page.getByRole('tab', { name: /Session B/ }).click();
    await expectSelected(page, 'B');
    for (const release of held) release();
    await page.waitForTimeout(500);
    await expectSelected(page, 'B');
  });
  test('the saved menu scrolls when it is taller than the window', async ({ page, context }) => {
    const f = await sessionFixture(context);
    const entries = Array.from({ length: 10 }, (_, i) => ({
      agent: 'claude',
      sessionRef: `c${i}`,
      title: `Conversation ${i}`,
      lastActiveAt: new Date().toISOString(),
      state: 'closed',
    }));
    await context.route('**/api/past-sessions**', (r) =>
      r.fulfill({ json: { folder: '/repo', entries } }),
    );
    await serve(context, catalogFor(f));
    await page.setViewportSize({ width: 900, height: 420 });
    await page.goto('/#capability=test');
    await page.getByRole('button', { name: 'Saved sessions (10)' }).click();
    const menu = page.locator('.session-saved-menu');
    const overflow = await menu.evaluate(
      (el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto',
    );
    expect(overflow).toBe(true);
    await expect(page.getByText('Conversation 9')).toBeAttached();
  });
  test('a late past-sessions response for another folder is dropped', async ({ page, context }) => {
    const f = await sessionFixture(context);
    const held: Array<() => void> = [];
    await context.route('**/api/past-sessions**', async (r) => {
      const folder = new URL(r.request().url()).searchParams.get('folder');
      if (folder === '/repo') await new Promise<void>((res) => held.push(res));
      return r.fulfill({
        json: {
          folder,
          entries:
            folder === '/repo'
              ? [
                  {
                    agent: 'claude',
                    sessionRef: 'a1',
                    title: 'From A',
                    lastActiveAt: new Date().toISOString(),
                    state: 'closed',
                  },
                ]
              : [],
        },
      });
    });
    await serve(context, catalogFor(f, { B: { worktreePath: '/wt/feature' } }));
    await page.goto('/#capability=test');
    // The main checkout is shown first and its listing hangs; switch to the worktree, then let that answer arrive.
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await page
      .getByRole('navigation', { name: 'Sessions' })
      .getByRole('button', { name: 'feature, 1 open' })
      .click();
    await expect(page.getByRole('button', { name: 'Saved sessions (0)' })).toBeDisabled();
    for (const release of held) release();
    await page.waitForTimeout(300);
    await expect(page.getByRole('button', { name: 'Saved sessions (0)' })).toBeDisabled();
    await expect(page.getByText('From A')).toHaveCount(0);
  });
});
test('a stale failed session lookup does not show an error after a later choice', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  const catalog = catalogFor(f);
  catalog.entries.push({
    ...catalog.entries[1]!,
    key: 'C',
    sessionId: 'C',
    sessionTitle: 'Session C',
    target: { ...catalog.entries[1]!.target, sessionRef: 'C' },
  });
  await serve(context, catalog);
  await page.goto('/#capability=test');
  const tabs = page.getByRole('tablist', { name: 'Sessions in repo' });
  await expect(tabs.getByRole('tab', { name: /Session C/ })).toBeVisible();
  const held: Array<() => void> = [];
  await context.route('**/api/sessions', async (route) => {
    await new Promise<void>((resolve) => held.push(resolve));
    await route.fulfill({ status: 500, json: { error: 'Lookup exploded' } });
  });
  await tabs.getByRole('tab', { name: /Session C/ }).click();
  await expect.poll(() => held.length).toBeGreaterThan(0);
  await tabs.getByRole('tab', { name: /Session B/ }).click();
  await expect(tabs.getByRole('tab', { name: /Session B/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  for (const release of held) release();
  await page.waitForTimeout(400);
  await expect(page.getByText('Lookup exploded')).toHaveCount(0);
});
test('a launch that is still starting shows an unselectable Starting tab instead of the empty state', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  const catalog = catalogFor(f, {
    A: { open: false, activity: 'disconnected' },
    B: { open: false, activity: 'disconnected' },
  });
  const base = catalog.entries[0]!;
  catalog.entries.push({
    key: 'launch:L1',
    target: { agent: 'codex', sessionRef: 'launch:L1', projectId: base.target.projectId },
    projectKey: base.projectKey,
    projectName: base.projectName,
    worktreePath: '/repo',
    open: true,
    activity: 'connecting',
    availability: 'unavailable',
    launchId: 'L1',
    launchState: 'starting',
    reason: 'Starting…',
  });
  await serve(context, catalog);
  await page.goto('/#capability=test');
  const tabs = page.getByRole('tablist', { name: 'Sessions in repo' });
  const starting = tabs.getByRole('tab', { name: /Starting…/ });
  await expect(starting).toBeVisible();
  await expect(starting).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText('No open sessions in this folder.')).toHaveCount(0);
});

test.describe('remove from history', () => {
  async function deleteRoute(
    context: any,
    f: Awaited<ReturnType<typeof sessionFixture>>,
    deleted: string[],
    failFor?: string,
  ) {
    await context.route('**/api/sessions/*', async (route: any) => {
      const request = route.request();
      if (request.method() !== 'DELETE') return route.fallback();
      const id = decodeURIComponent(new URL(request.url()).pathname.split('/')[3]!);
      if (id === failFor)
        return route.fulfill({
          status: 409,
          json: {
            error: 'Session is open; close it before removing it from history',
            code: 'session-open',
          },
        });
      deleted.push(id);
      const at = f.records.findIndex((r) => r.id === id);
      if (at >= 0) f.records.splice(at, 1);
      return route.fulfill({ json: { removed: true } });
    });
  }
  test('right-clicking a saved session offers a confirmed removal that leaves the transcript wording clear', async ({
    page,
    context,
  }) => {
    const f = await sessionFixture(context);
    const catalog = catalogFor(f, { B: { open: false, activity: 'disconnected' } });
    await serve(context, catalog);
    await routePastSessions(
      context,
      pastFromCatalog(() => catalog),
    );
    const deleted: string[] = [];
    await deleteRoute(context, f, deleted);
    await page.goto('/#capability=test');
    await page.getByRole('button', { name: 'Saved sessions (1)' }).click();
    await page.getByRole('menuitem', { name: /Session B/ }).click({ button: 'right' });
    const actions = page.getByRole('menu', { name: 'Session actions' });
    // A closed conversation offers Reopen first, then removal.
    await expect(actions.getByRole('menuitem', { name: 'Reopen' })).toBeFocused();
    // Only the Saved sessions list scrolls; other menus sharing its look do not.
    await expect(actions).toHaveCSS('overflow-y', 'visible');
    await expect(page.locator('.session-past-menu')).toHaveCSS('overflow-y', 'auto');
    await page.keyboard.press('ArrowDown');
    const action = actions.getByRole('menuitem', { name: 'Remove from history…' });
    await expect(action).toBeFocused();
    await action.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Remove from history' });
    await expect(dialog).toContainText("agent's own transcript");
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(deleted).toEqual([]);
    await page.getByRole('button', { name: 'Saved sessions (1)' }).click();
    await page.getByRole('menuitem', { name: /Session B/ }).press('Shift+F10');
    await page.getByRole('menuitem', { name: 'Remove from history…' }).press('Enter');
    await dialog.getByRole('button', { name: 'Remove from history', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(deleted).toEqual(['B']);
  });
  test('open tabs do not offer removal; a server refusal is shown in the dialog', async ({
    page,
    context,
  }) => {
    const f = await sessionFixture(context);
    const catalog = catalogFor(f, { B: { open: false, activity: 'disconnected' } });
    await serve(context, catalog);
    await routePastSessions(
      context,
      pastFromCatalog(() => catalog),
    );
    const deleted: string[] = [];
    await deleteRoute(context, f, deleted, 'B');
    await page.goto('/#capability=test');
    await page.getByRole('tab', { name: /Session A/ }).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Remove from history…' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Saved sessions (1)' }).click();
    await page.getByRole('menuitem', { name: /Session B/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Remove from history…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove from history' });
    await dialog.getByRole('button', { name: 'Remove from history', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Session is open');
    await expect(dialog).toBeVisible();
  });
  test('a failed reopen shows the reason and the command to run by hand', async ({
    page,
    context,
  }) => {
    const f = await sessionFixture(context);
    await routePastSessions(context, () => [
      { agent: 'codex', sessionRef: 'T1', title: 'Thread one', state: 'closed' as const },
    ]);
    await context.route('**/api/launches/resume', (r) =>
      r.fulfill({
        status: 400,
        json: { error: 'Codex exited as soon as Gloss reopened the session.' },
      }),
    );
    await serve(context, catalogFor(f));
    await page.goto('/#capability=test');
    await page.getByRole('button', { name: 'Saved sessions (1)' }).click();
    await page.getByRole('button', { name: 'Reopen Thread one' }).click();
    await expect(
      page.getByText('Codex exited as soon as Gloss reopened the session.'),
    ).toBeVisible();
    await expect(page.locator('code', { hasText: "cd '/repo' && codex resume T1" })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
    // A failed reopen keeps the menu open beside the reason.
    await expect(page.getByRole('menu')).toBeVisible();
  });
  test('a reopened session whose agent exits before connecting shows the reason and the command', async ({
    page,
    context,
  }) => {
    const f = await sessionFixture(context);
    await routePastSessions(context, () => [
      { agent: 'codex', sessionRef: 'T1', title: 'Thread one', state: 'closed' as const },
    ]);
    const reason =
      "Reopening failed; the agent exited. Run it yourself: cd '/repo' && codex resume T1";
    const launch = {
      id: 'R1',
      agent: 'codex',
      folder: '/repo',
      panePid: 1,
      state: 'starting',
      createdAt: 0,
      sessionRef: 'T1',
      resumed: true,
    };
    let ended = false;
    await context.route('**/api/launches/resume', (r) => {
      ended = true;
      return r.fulfill({ json: launch });
    });
    await context.route('**/api/launches', (r) =>
      r.fulfill({ json: ended ? [{ ...launch, state: 'ended', reason }] : [] }),
    );
    await serve(context, catalogFor(f));
    await page.goto('/#capability=test');
    await page.getByRole('button', { name: 'Saved sessions (1)' }).click();
    await page.getByRole('button', { name: 'Reopen Thread one' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'the agent exited' });
    await expect(alert).toContainText('Could not reopen Thread one: the agent exited.');
    await expect(alert.locator('code', { hasText: "cd '/repo' && codex resume T1" })).toBeVisible();
  });
  test('a conversation without Gloss history is hidden after confirmation, and a failed reopen says how to resume', async ({
    page,
    context,
  }) => {
    const f = await sessionFixture(context);
    let entries = [
      { agent: 'claude', sessionRef: 'c-9', title: 'Outside work', state: 'closed' as const },
    ];
    await routePastSessions(context, () => entries);
    const hidden: unknown[] = [];
    await context.route('**/api/past-sessions/hide', (r) => {
      hidden.push(r.request().postDataJSON());
      entries = [];
      return r.fulfill({ json: { hidden: true } });
    });
    await context.route('**/api/launches/resume', (r) =>
      r.fulfill({ status: 400, json: { error: 'Conversation is open outside Gloss' } }),
    );
    await serve(context, catalogFor(f));
    await page.goto('/#capability=test');
    await page.getByRole('button', { name: 'Saved sessions (1)' }).click();
    await page.getByRole('button', { name: 'Reopen Outside work' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Could not reopen Outside work: Conversation is open outside Gloss',
    );
    await expect(
      page.locator('code', { hasText: "cd '/repo' && claude --resume c-9" }),
    ).toBeVisible();
    // The row has no Gloss session to select, but its context menu still works from the keyboard.
    await page.getByRole('menuitem', { name: /Outside work/ }).press('Shift+F10');
    await page.getByRole('menuitem', { name: 'Remove from history…' }).press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Remove from history' });
    await expect(dialog).toContainText('Gloss keeps no history for this conversation.');
    await dialog.getByRole('button', { name: 'Remove from history', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(hidden).toEqual([{ agent: 'claude', sessionRef: 'c-9' }]);
    await expect(page.getByRole('button', { name: 'Saved sessions (0)' })).toBeDisabled();
  });
  test('a Gloss session row that is not saved here offers no removal and never the hide dialog', async ({
    page,
    context,
  }) => {
    const f = await sessionFixture(context);
    await routePastSessions(context, () => [
      { agent: 'codex', sessionRef: 'Z', panelSessionId: 'Z', title: 'Elsewhere', state: 'closed' },
    ]);
    await serve(context, catalogFor(f));
    await page.goto('/#capability=test');
    await page.getByRole('button', { name: 'Saved sessions (1)' }).click();
    await page.getByRole('menuitem', { name: /Elsewhere/ }).click({ button: 'right' });
    const actions = page.getByRole('menu', { name: 'Session actions' });
    await expect(actions.getByRole('menuitem', { name: 'Reopen' })).toBeVisible();
    await expect(actions.getByRole('menuitem', { name: 'Remove from history…' })).toHaveCount(0);
  });
  test('folder context menu removes all closed sessions after one confirmation', async ({
    page,
    context,
  }) => {
    const f = await sessionFixture(context);
    await serve(
      context,
      catalogFor(f, {
        A: { open: false, activity: 'disconnected' },
        B: { open: false, activity: 'disconnected' },
      }),
    );
    const deleted: string[] = [];
    await deleteRoute(context, f, deleted);
    await page.goto('/#capability=test');
    const sidebar = page.getByRole('navigation', { name: 'Sessions' });
    await sidebar.getByRole('button', { name: 'repo, 0 open' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Remove closed sessions from history… (2)' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove from history' });
    await expect(dialog).toContainText('Remove 2 closed sessions in repo');
    await dialog.getByRole('button', { name: 'Remove from history', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(deleted.sort()).toEqual(['A', 'B']);
  });
});

test('tabs show one red needs-you dot for approvals and unseen responses', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  await page.addInitScript(() => {
    document.hasFocus = () => false;
  });
  await context.route('**/api/session-catalog/seen', (r) =>
    r.fulfill({ json: { result: 'unchanged' } }),
  );
  await serve(
    context,
    catalogFor(f, {
      A: { attention: 'response', latestResponseSequence: 4 },
      B: { activity: 'approval-required', attention: 'approval' },
    }),
  );
  await page.goto('/#capability=test');
  const tabs = page.getByRole('tablist', { name: 'Sessions in repo' });
  await expect(tabs.getByRole('tab', { name: /Session A/ }).getByLabel('New response')).toHaveClass(
    /needs-you/,
  );
  await expect(
    tabs.getByRole('tab', { name: /Session B/ }).getByLabel('Approval required'),
  ).toHaveClass(/needs-you/);
  await expect(page.locator('.session-header')).toContainText('New response');
});
