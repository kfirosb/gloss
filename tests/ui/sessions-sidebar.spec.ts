import { test, expect } from '@playwright/test';
import { sessionFixture } from './multi-session-fixture.js';
import { expectSelected, pastFromCatalog, routePastSessions } from './session-fixture.js';
import type { CatalogSnapshot } from '../../src/core/session-catalog.js';

// Playwright treats aria-disabled controls as not actionable, so clicks on them are forced.
const tab = (page: import('@playwright/test').Page, key: string) =>
  page.locator(`[role=tab][data-session-key="${key}"]`);

// Catches identity and the unavailable reason becoming unreachable when a tab cannot be chosen.
for (const width of [1280, 390])
  for (const kind of ['unavailable', 'unregistered'] as const)
    test(`inspect unselected ${kind} session without retargeting at ${width}`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width, height: 700 });
      const f = await sessionFixture(context);
      const catalog: CatalogSnapshot = {
        epoch: 'inspect',
        sequence: 1,
        discovery: { state: 'healthy' },
        entries: f.records.map((r) => ({
          key: r.id,
          sessionId: r.id,
          target: { ...r.target, agent: 'codex' },
          projectKey: '/repo',
          projectName: 'Project',
          sessionTitle: `Session ${r.id}`,
          worktreePath: '/worktrees/shared',
          branch: `feature/${r.id}`,
          open: true,
          activity: 'idle',
          availability: 'available',
        })),
      };
      const inspected = catalog.entries[1]!;
      if (kind === 'unavailable') {
        inspected.availability = 'unavailable';
        inspected.reason = 'Native transport unavailable';
      } else {
        delete inspected.sessionId;
        inspected.key = 'unregistered';
        inspected.target = { ...inspected.target, sessionRef: 'native-unregistered' };
        inspected.availability = 'unavailable';
        inspected.reason = 'Native session is not registered';
      }
      await context.route('**/api/session-catalog', (r) => r.fulfill({ json: catalog }));
      await context.route('**/api/session-catalog/events', (r) =>
        r.fulfill({
          contentType: 'text/event-stream',
          body: 'data: ' + JSON.stringify(catalog) + '\n\n',
        }),
      );
      await page.goto('/#capability=test');
      const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
      await input.fill('Keep selected A draft');
      const other = tab(page, kind === 'unavailable' ? 'B' : 'unregistered');
      await expect(other).toHaveAttribute('aria-disabled', 'true');
      const identity = [
        /Project: \/project\/B/,
        /Worktree: \/worktrees\/shared/,
        /Branch: feature\/B/,
        kind === 'unavailable' ? /Codex session: B/ : /Codex session: native-unregistered/,
        kind === 'unavailable'
          ? /Native transport unavailable/
          : /Native session is not registered/,
      ];
      for (const part of identity) {
        await expect(other).toHaveAttribute('title', part);
        await expect(other).toHaveAccessibleDescription(part);
      }
      await other.click({ force: true });
      await expectSelected(page, 'A');
      await expect(tab(page, 'A')).toHaveAttribute('aria-selected', 'true');
      await expect(other).not.toHaveAttribute('aria-selected', 'true');
      await expect(input).toHaveValue('Keep selected A draft');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (width < 760) await page.getByRole('button', { name: 'Expand sessions' }).click();
      const sidebar = page.getByRole('navigation', { name: 'Sessions' });
      await sidebar.getByRole('button', { name: 'Session details', exact: true }).click();
      await expect(sidebar.locator('.session-details')).toContainText('Codex session: A');
      await expect(sidebar.locator('.session-details')).toContainText(
        'Worktree: /worktrees/shared',
      );
      await expect(sidebar.locator('.session-details')).toContainText('Branch: feature/A');
    });

// Catches metadata leaking into ordinary tabs, clipped status, ambiguous duplicate
// identities, and loss of click-accessible technical details.
for (const width of [1280, 390])
  test(`compact tabs preserve identity and details at ${width}`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 700 });
    const f = await sessionFixture(context);
    const catalog: CatalogSnapshot = {
      epoch: 'compact',
      sequence: 1,
      discovery: { state: 'healthy' },
      entries: f.records.map((r) => ({
        key: r.id,
        sessionId: r.id,
        target: { ...r.target, agent: 'codex', sessionRef: `native-session-${r.id}` },
        projectKey: '/repo',
        projectName: 'Project',
        worktreePath: '/repo/shared-workspace',
        sessionTitle: 'Same native title',
        open: true,
        activity: 'idle',
        availability: 'available',
      })),
    };
    catalog.entries[0]!.branch = 'feature/sidebar';
    for (const [i, r] of f.records.entries()) r.target = { ...catalog.entries[i]!.target };
    await context.route('**/api/session-catalog', (r) => r.fulfill({ json: catalog }));
    await context.route('**/api/session-catalog/events', (r) =>
      r.fulfill({
        contentType: 'text/event-stream',
        body: 'data: ' + JSON.stringify(catalog) + '\n\n',
      }),
    );
    await page.goto('/#capability=test');
    const row = tab(page, 'A');
    await expect(row).toBeVisible();
    await expect(row).not.toContainText('/repo/');
    await expect(row).not.toContainText('native-session-');
    await expect(row).not.toContainText('Selected');
    await expect(row).toHaveAccessibleDescription(
      /Codex.*native-session-A.*\/repo\/shared-workspace/,
    );
    await expect(row.getByRole('img', { name: 'Codex', exact: true })).toBeVisible();
    const twin = tab(page, 'B');
    await expect(twin).toHaveAccessibleDescription(
      /Codex.*native-session-B.*\/repo\/shared-workspace/,
    );
    await expect(twin).toHaveAccessibleName('Codex Same native title Idle');
    catalog.entries[1]!.target.agent = 'claude';
    catalog.sequence++;
    await expect(twin.getByRole('img', { name: 'Claude Code', exact: true })).toBeVisible();
    const title = await row.locator('.session-tab-title').boundingBox();
    const dot = await row.getByLabel('Idle', { exact: true }).boundingBox();
    const box = (await row.boundingBox())!;
    expect(dot!.y).toBeGreaterThanOrEqual(box.y);
    expect(dot!.y + dot!.height).toBeLessThanOrEqual(box.y + box.height);
    expect(Math.abs(title!.y + title!.height / 2 - (dot!.y + dot!.height / 2))).toBeLessThan(6);
    expect(box.height).toBeLessThanOrEqual(58);
    if (width < 760) await page.getByRole('button', { name: 'Expand sessions' }).click();
    const sidebar = page.getByRole('navigation', { name: 'Sessions' });
    await sidebar.getByRole('button', { name: 'Session details', exact: true }).click();
    await expect(sidebar.locator('.session-details')).toContainText('/repo/shared-workspace');
    await expect(sidebar.locator('.session-details')).toContainText('native-session-A');
    await expect(sidebar.locator('.session-details')).toContainText('Branch: feature/sidebar');
    if (width < 760) await page.keyboard.press('Escape');
    catalog.entries[0]!.activity = 'working';
    catalog.sequence++;
    await expect(row.getByRole('img', { name: 'Working', exact: true })).toBeVisible();
    catalog.entries[0]!.activity = 'approval-required';
    catalog.sequence++;
    await expect(row.getByRole('img', { name: 'Approval required', exact: true })).toBeVisible();
    catalog.entries[0]!.activity = 'idle';
    catalog.entries[0]!.availability = 'unavailable';
    catalog.entries[0]!.reason = 'Native transport unavailable; reconnect required';
    catalog.sequence++;
    await expect(row).toHaveAttribute('aria-disabled', 'true');
    await expect(row.getByRole('img', { name: 'Idle · Unavailable', exact: true })).toBeVisible();
    await expect(row).toHaveAccessibleDescription(
      /Native transport unavailable; reconnect required/,
    );
    expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    // A discovered destination whose record is not ready must leave its error visible.
    catalog.entries.push({
      ...catalog.entries[1]!,
      key: 'pending',
      sessionId: 'pending',
      target: { ...catalog.entries[1]!.target, sessionRef: 'pending' },
    });
    catalog.sequence++;
    await tab(page, 'pending').click();
    await expect(page.getByRole('alert')).toContainText('Session is not available yet');
    await expect(page.getByRole('button', { name: 'Retry connection' })).toHaveCount(0);
    await expect(row).toHaveAttribute('aria-selected', 'true');
  });
for (const [width, height] of [
  [1280, 800],
  [390, 700],
  [900, 450],
])
  test(`permanent navigation and collapsed rail preserve drafts at ${width}`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: width!, height: height! });
    await sessionFixture(context);
    await page.goto('/#capability=test');
    const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
    await input.fill('Keep draft');
    const sidebar = page.getByRole('navigation', { name: 'Sessions' });
    await expect(sidebar).toBeVisible();
    if (width! < 760) await page.getByRole('button', { name: 'Expand sessions' }).click();
    await page.getByRole('button', { name: 'Collapse sessions' }).click();
    await expect(input).toHaveValue('Keep draft');
    await sidebar.getByRole('button', { name: 'Open A folders: /project/A', exact: true }).click();
    await expect(sidebar.locator('[data-folder-key="/project/A"]')).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(input).toHaveValue('Keep draft');
    await page.keyboard.press('Escape');
    if (width! < 760)
      await expect(page.getByRole('button', { name: 'Expand sessions' })).toBeVisible();
    else await page.getByRole('button', { name: 'Collapse sessions' }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const expandRail = page.getByRole('button', { name: 'Expand sessions' });
    if (await expandRail.isVisible()) await expandRail.click();
    await sidebar.locator('[data-folder-key="/project/B"]').click();
    if (await expandRail.isVisible()) await expandRail.click();
    await expect(sidebar.locator('[data-folder-key="/project/B"]')).toHaveAttribute(
      'aria-current',
      'true',
    );
  });
test('selected closed session remains reachable in Saved', async ({ page, context }) => {
  const f = await sessionFixture(context);
  const catalog = {
    epoch: 'sidebar',
    sequence: 1,
    discovery: { state: 'healthy' },
    entries: f.records.map((r) => ({
      key: r.id,
      sessionId: r.id,
      target: r.target,
      projectKey: '/repo',
      projectName: 'Project',
      worktreePath: r.target.projectId,
      sessionTitle: 'Same title',
      open: true,
      activity: 'idle',
      availability: 'available',
    })),
  };
  await context.route('**/api/session-catalog', (r) => r.fulfill({ json: catalog }));
  await context.route('**/api/session-catalog/events', (r) =>
    r.fulfill({
      contentType: 'text/event-stream',
      body: 'data: ' + JSON.stringify(catalog) + '\n\n',
    }),
  );
  await routePastSessions(
    context,
    pastFromCatalog(() => catalog),
  );
  await page.goto('/#capability=test');
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.fill('Draft A');
  await expect(tab(page, 'A')).toHaveAttribute('aria-selected', 'true');
  catalog.entries[0]!.open = false;
  catalog.entries[0]!.activity = 'disconnected';
  catalog.sequence++;
  await expect(tab(page, 'A')).toHaveCount(0);
  await page.getByRole('button', { name: 'Saved sessions (1)' }).click();
  await expect(page.getByRole('menuitem', { name: /Same title/ })).toBeVisible();
  await expect(page.locator('.session-header')).toContainText('Disconnected');
  await expectSelected(page, 'A');
  await expect(input).toHaveValue('Draft A');
});

async function folderFixture(
  context: import('@playwright/test').BrowserContext,
  mutate: (e: CatalogSnapshot['entries']) => void,
) {
  const f = await sessionFixture(context);
  const entries: CatalogSnapshot['entries'] = f.records.map((r) => ({
    key: r.id,
    sessionId: r.id,
    target: { ...r.target, agent: 'codex' as const },
    projectKey: r.target.projectId + '/.git',
    projectName: 'Proj ' + r.id,
    worktreePath: r.target.projectId,
    open: true,
    activity: 'idle',
    availability: 'available',
  }));
  mutate(entries);
  const catalog: CatalogSnapshot = {
    epoch: 'folders',
    sequence: 1,
    discovery: { state: 'healthy' },
    entries,
  };
  await context.route('**/api/session-catalog', (r) => r.fulfill({ json: catalog }));
  await context.route('**/api/session-catalog/events', (r) =>
    r.fulfill({
      contentType: 'text/event-stream',
      body: 'data: ' + JSON.stringify(catalog) + '\n\n',
    }),
  );
  return f;
}
test('existing folders stay listed at 0 open; only missing folders are hidden', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await folderFixture(context, (e) => {
    e[1]!.open = false;
    e[1]!.activity = 'disconnected';
    e.push({
      ...e[0]!,
      key: 'G',
      sessionId: undefined as any,
      target: { ...e[0]!.target, sessionRef: 'G', projectId: '/project/gone' },
      projectKey: '/project/gone/.git',
      projectName: 'Gone',
      worktreePath: '/project/gone',
      open: false,
      activity: 'disconnected',
      folderMissing: true,
    });
  });
  await page.goto('/#capability=test');
  const sidebar = page.getByRole('navigation', { name: 'Sessions' });
  await expect(sidebar.locator('[data-folder-key="/project/A"]')).toBeVisible();
  await expect(sidebar.locator('[data-folder-key="/project/B"]')).toBeVisible();
  await expect(sidebar.locator('[data-folder-key="/project/B"]')).toHaveAccessibleName('B, 0 open');
  await expect(sidebar.locator('[data-folder-key="/project/gone"]')).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: /Other folders/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Collapse sessions' }).click();
  await expect(
    sidebar.getByRole('button', { name: 'Open Proj A folders: /project/A', exact: true }),
  ).toBeVisible();
});
test('a selected saved-only folder stays listed', async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await folderFixture(context, (e) => {
    e[0]!.open = false;
    e[0]!.activity = 'disconnected';
    e[1]!.open = false;
    e[1]!.activity = 'disconnected';
  });
  await page.goto('/#capability=test');
  const sidebar = page.getByRole('navigation', { name: 'Sessions' });
  await expectSelected(page, 'A');
  await expect(sidebar.locator('[data-folder-key="/project/A"]')).toBeVisible();
  await expect(sidebar.locator('[data-folder-key="/project/B"]')).toBeVisible();
});
