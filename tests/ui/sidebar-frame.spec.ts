import { test, expect } from '@playwright/test';
import { sessionFixture } from './multi-session-fixture.js';
import type { CatalogSnapshot } from '../../src/core/session-catalog.js';
function catalogFor(f: any): CatalogSnapshot {
  return {
    epoch: 'sf',
    sequence: 1,
    discovery: { state: 'healthy' },
    entries: f.records.map((r: any, i: number) => ({
      key: r.id,
      sessionId: r.id,
      target: { ...r.target, agent: 'codex' },
      projectKey: `/repo${i}/.git`,
      projectName: `repo${i}`,
      sessionTitle: 'Session ' + r.id,
      worktreePath: `/repo${i}`,
      open: true,
      activity: 'idle',
      availability: 'available',
    })),
  };
}
async function serve(context: any, f: any) {
  const catalog = catalogFor(f);
  let settings: any = { order: [], hidden: [], collapsed: [], worktreeLocation: {} };
  await context.route('**/api/session-catalog', (r: any) => r.fulfill({ json: catalog }));
  await context.route('**/api/session-catalog/events', (r: any) =>
    r.fulfill({
      contentType: 'text/event-stream',
      body: 'data: ' + JSON.stringify(catalog) + '\n\n',
    }),
  );
  await context.route('**/api/folders', (r: any) => r.fulfill({ json: [] }));
  await context.route('**/api/projects/*/worktrees', (r: any) =>
    r.fulfill({ json: { hasCommits: true, worktrees: [] } }),
  );
  await context.route('**/api/settings/sidebar', (r: any) => {
    if (r.request().method() === 'PUT') settings = r.request().postDataJSON();
    return r.fulfill({ json: settings });
  });
  await context.route('**/api/about', (r: any) =>
    r.fulfill({
      json: { name: 'language-assistant', version: '9.8.7', platform: 'darwin', arch: 'arm64' },
    }),
  );
  return () => settings;
}
test('resizes by drag and keyboard, persists width', async ({ page, context }) => {
  const f = await sessionFixture(context);
  await serve(context, f);
  await page.goto('/#capability=test');
  const divider = page.getByRole('separator', { name: 'Sidebar width' });
  await divider.focus();
  await page.keyboard.press('End');
  await expect(divider).toHaveAttribute('aria-valuenow', '440');
  await page.keyboard.press('ArrowLeft');
  await expect(divider).toHaveAttribute('aria-valuenow', '420');
  const sidebarBox = await page.getByRole('navigation', { name: 'Sessions' }).boundingBox();
  expect(Math.round(sidebarBox!.width)).toBe(420);
  const box = (await divider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(300, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(divider).toHaveAttribute('aria-valuenow', '300');
  await page.reload();
  await expect(page.getByRole('separator', { name: 'Sidebar width' })).toHaveAttribute(
    'aria-valuenow',
    '300',
  );
});
test('reorders with the menu, collapses, hides and restores while keeping the selected project', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  const read = await serve(context, f);
  await page.goto('/#capability=test');
  const sidebar = page.getByRole('navigation', { name: 'Sessions' });
  await sidebar.getByRole('button', { name: 'repo1 actions' }).click();
  await page.getByRole('menuitem', { name: 'Move up' }).click();
  await expect.poll(() => read().order).toEqual(['/repo1/.git', '/repo0/.git']);
  await expect(sidebar.getByRole('group').first()).toHaveAttribute('aria-label', 'repo1');
  await sidebar.getByRole('button', { name: 'Collapse repo1' }).click();
  await expect(sidebar.getByRole('button', { name: /repo1, 1 open/ })).toBeHidden();
  await expect.poll(() => read().collapsed).toEqual(['/repo1/.git']);
  await sidebar.getByRole('button', { name: 'repo0 actions' }).click();
  await page.getByRole('menuitem', { name: 'Hide project' }).click();
  await expect(sidebar.getByRole('group', { name: 'repo0' })).toBeVisible(); // selected session's project stays
  await expect(
    sidebar
      .getByRole('status')
      .filter({ hasText: 'repo0 is hidden — shown while its session is open' }),
  ).toBeVisible();
  await sidebar.getByRole('button', { name: 'repo1 actions' }).click();
  await page.getByRole('menuitem', { name: 'Hide project' }).click();
  await expect(sidebar.getByRole('group', { name: 'repo1' })).toBeHidden();
  await sidebar.getByRole('button', { name: 'Hidden projects' }).click();
  await page
    .getByRole('dialog', { name: 'Hidden projects' })
    .getByRole('button', { name: 'Restore repo1' })
    .click();
  await expect(sidebar.getByRole('group', { name: 'repo1' })).toBeVisible();
});
test('reorders by dragging the grip onto another project', async ({ page, context }) => {
  const f = await sessionFixture(context);
  const read = await serve(context, f);
  await page.goto('/#capability=test');
  const sidebar = page.getByRole('navigation', { name: 'Sessions' });
  await expect(sidebar.getByRole('group').first()).toHaveAttribute('aria-label', 'repo0');
  await sidebar
    .getByRole('group', { name: 'repo1' })
    .locator('.grip')
    .dragTo(sidebar.getByRole('group', { name: 'repo0' }).locator('.project-head'));
  await expect.poll(() => read().order).toEqual(['/repo1/.git', '/repo0/.git']);
  await expect(sidebar.getByRole('group').first()).toHaveAttribute('aria-label', 'repo1');
});
test('compact is the default and an explicit full choice is kept', async ({ page, context }) => {
  const f = await sessionFixture(context);
  await serve(context, f);
  await page.addInitScript(() =>
    localStorage.setItem(
      'language-assistant:display:v1',
      JSON.stringify({
        version: 1,
        collapsed: false,
        assistantModes: { B: 'full' },
        lastByFolder: {},
        tabOrder: {},
      }),
    ),
  );
  await page.goto('/#capability=test');
  await expect(page.getByRole('button', { name: 'Show full Assistant' })).toBeVisible();
  // Session B lives in its own folder, so its tab is reached through that folder.
  await page
    .getByRole('navigation', { name: 'Sessions' })
    .getByRole('button', { name: /repo1, 1 open/ })
    .click();
  await page.getByRole('tab', { name: /Session B/ }).click();
  await expect(page.getByRole('button', { name: 'Minimize Assistant' })).toBeVisible();
});
test('a change made before the settings load is applied on top of the loaded settings', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  await serve(context, f);
  const loaded = {
    order: ['/repo1/.git', '/repo0/.git'],
    hidden: [],
    collapsed: ['/repo0/.git'],
    worktreeLocation: {},
  };
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const puts: any[] = [];
  await context.route('**/api/settings/sidebar', async (r: any) => {
    if (r.request().method() === 'PUT') {
      puts.push(r.request().postDataJSON());
      return r.fulfill({ json: r.request().postDataJSON() });
    }
    await held;
    return r.fulfill({ json: loaded });
  });
  await page.goto('/#capability=test');
  const sidebar = page.getByRole('navigation', { name: 'Sessions' });
  await sidebar.getByRole('button', { name: 'repo1 actions' }).click();
  await page.getByRole('menuitem', { name: 'Hide project' }).click();
  await expect(sidebar.getByRole('group', { name: 'repo1' })).toBeHidden();
  expect(puts).toEqual([]);
  release();
  await expect.poll(() => puts).toEqual([{ ...loaded, hidden: ['/repo1/.git'] }]);
  await expect(sidebar.getByRole('button', { name: 'Expand repo0' })).toBeVisible();
});
test('a failed settings write reverts and says so in the sidebar', async ({ page, context }) => {
  const f = await sessionFixture(context);
  await serve(context, f);
  await context.route('**/api/settings/sidebar', (r: any) =>
    r.request().method() === 'PUT'
      ? r.fulfill({ status: 500, json: { error: 'disk full' } })
      : r.fallback(),
  );
  await page.goto('/#capability=test');
  const sidebar = page.getByRole('navigation', { name: 'Sessions' });
  await expect(sidebar.getByRole('group', { name: 'repo1' })).toBeVisible();
  await sidebar.getByRole('button', { name: 'repo1 actions' }).click();
  await page.getByRole('menuitem', { name: 'Hide project' }).click();
  await expect(
    sidebar.getByRole('status').filter({ hasText: 'Could not save the sidebar layout: disk full' }),
  ).toBeVisible();
  await expect(sidebar.getByRole('group', { name: 'repo1' })).toBeVisible();
});
test('Forget errors show inside Hidden projects, and sidebar dialogs size to their content', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await sessionFixture(context);
  await serve(context, f);
  await context.route('**/api/folders', (r: any) =>
    r.fulfill({
      json: [
        {
          path: '/gone',
          projectKey: '/gone',
          kind: 'plain',
          createdByApp: false,
          connectedAt: 1,
          projectName: 'gone',
          missing: true,
        },
      ],
    }),
  );
  await context.route('**/api/folders?*', (r: any) =>
    r.fulfill({ status: 500, json: { error: 'Folder store is locked' } }),
  );
  await page.goto('/#capability=test');
  const sidebar = page.getByRole('navigation', { name: 'Sessions' });
  await sidebar.getByRole('button', { name: 'Hidden projects' }).click();
  const dialog = page.getByRole('dialog', { name: 'Hidden projects' });
  await expect(dialog.getByRole('button', { name: 'Show sessions of /gone' })).toHaveCount(0);
  expect((await dialog.boundingBox())!.height).toBeLessThan(500);
  await dialog.getByRole('button', { name: 'Forget /gone' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Folder store is locked');
  await dialog.getByRole('button', { name: 'Done' }).click();
  for (const [button, name] of [
    ['Connect folder', 'Connect a folder'],
    [/^About Gloss/, 'About Gloss'],
  ] as const) {
    await sidebar.getByRole('button', { name: button }).click();
    const opened = page.getByRole('dialog', { name });
    await expect(opened).toBeVisible();
    expect((await opened.boundingBox())!.height).toBeLessThan(500);
    await opened.getByRole('button', { name: `Close ${name}` }).click();
  }
});
