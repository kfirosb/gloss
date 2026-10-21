import { test, expect, type BrowserContext } from '@playwright/test';
import { sessionFixture } from './multi-session-fixture.js';
import type { CatalogEntry, CatalogSnapshot } from '../../src/core/session-catalog.js';

type Fixture = Awaited<ReturnType<typeof sessionFixture>>;
// A open in /repo; B saved (closed) in the /wt/feature worktree, which therefore has nothing open.
const entriesFor = (f: Fixture): CatalogEntry[] =>
  f.records.map((r) => ({
    key: r.id,
    sessionId: r.id,
    target: { ...r.target, agent: 'codex' as const },
    projectKey: '/repo/.git',
    projectName: 'repo',
    sessionTitle: `Session ${r.id}`,
    worktreePath: r.id === 'A' ? '/repo' : '/wt/feature',
    open: r.id === 'A',
    activity: r.id === 'A' ? ('idle' as const) : ('disconnected' as const),
    availability: 'available' as const,
  }));
// The catalog is read on every request, so a change shows on the stream's next reconnect.
async function serve(context: BrowserContext, catalog: () => CatalogSnapshot) {
  await context.route('**/api/session-catalog', (r) => r.fulfill({ json: catalog() }));
  await context.route('**/api/session-catalog/events', (r) =>
    r.fulfill({
      contentType: 'text/event-stream',
      body: 'data: ' + JSON.stringify(catalog()) + '\n\n',
    }),
  );
}
async function openFeatureFolder(page: import('@playwright/test').Page) {
  await page.goto('/#capability=test');
  await page
    .getByRole('navigation', { name: 'Sessions' })
    .getByRole('button', { name: 'feature, 0 open' })
    .click();
}

test('a folder without open sessions shows the empty state and its + opens New session', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  const catalog: CatalogSnapshot = {
    epoch: 'empty',
    sequence: 1,
    discovery: { state: 'healthy' },
    entries: entriesFor(f),
  };
  await serve(context, () => catalog);
  const launched: unknown[] = [];
  await context.route('**/api/launches', (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    launched.push(r.request().postDataJSON());
    // No panel yet: the catalog lists the launch as starting from now on.
    catalog.sequence = 2;
    catalog.entries = [
      ...entriesFor(f),
      {
        key: 'launch:L9',
        target: { agent: 'claude', sessionRef: 'launch:L9', projectId: '/wt/feature' },
        projectKey: '/repo/.git',
        projectName: 'repo',
        worktreePath: '/wt/feature',
        open: true,
        activity: 'connecting',
        availability: 'unavailable',
        launchId: 'L9',
        launchState: 'starting',
      },
    ];
    return r.fulfill({ json: { id: 'L9', state: 'starting', createdAt: 0 } });
  });
  await openFeatureFolder(page);
  const empty = page.getByRole('region', { name: 'Start a session' });
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('runs Claude Code or Codex in this folder');
  await expect(empty).toContainText('Or resume one from Saved sessions above.');
  // The tabs row agrees, and the Saved sessions menu the copy points at is there.
  await expect(page.getByText('No open sessions in this folder.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Saved sessions (1)' })).toBeVisible();

  const start = empty.getByRole('button', { name: 'Start a session in feature' });
  await start.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New session' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Folder')).toHaveValue('/wt/feature');
  await dialog.getByRole('button', { name: 'Open session' }).click();
  await expect(dialog).toBeHidden();
  expect(launched).toEqual([{ agent: 'claude', folder: '/wt/feature' }]);
  // While the launch is pending the empty state stays hidden and the Starting tab takes its place.
  await expect(empty).toBeHidden();
  await expect(page.getByRole('tab', { name: /Starting…/ })).toBeVisible();
  await expect(page.getByText('No open sessions in this folder.')).toHaveCount(0);
});

test('a launch that returns its panel replaces the empty state with the workspace', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  const catalog: CatalogSnapshot = {
    epoch: 'empty-panel',
    sequence: 1,
    discovery: { state: 'healthy' },
    entries: entriesFor(f),
  };
  await serve(context, () => catalog);
  await context.route('**/api/launches', (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    catalog.sequence = 2;
    catalog.entries = entriesFor(f).map((e) =>
      e.key === 'B' ? { ...e, open: true, activity: 'idle', launchId: 'L7' } : e,
    );
    return r.fulfill({ json: { id: 'L7', panelSessionId: 'B', state: 'running', createdAt: 0 } });
  });
  await openFeatureFolder(page);
  const empty = page.getByRole('region', { name: 'Start a session' });
  await expect(empty).toBeVisible();
  await empty.getByRole('button', { name: 'Start a session in feature' }).click();
  await page
    .getByRole('dialog', { name: 'New session' })
    .getByRole('button', { name: 'Open session' })
    .click();
  await expect(empty).toBeHidden();
  await expect(page.locator('.session-header')).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Discuss with language assistant' }),
  ).toBeVisible();
});

test('a worktree with no sessions at all leaves out the resume line and fits a small window', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  const catalog: CatalogSnapshot = {
    epoch: 'empty-fresh',
    sequence: 1,
    discovery: { state: 'healthy' },
    entries: entriesFor(f).filter((e) => e.key === 'A'),
  };
  await serve(context, () => catalog);
  await context.route('**/api/folders', (r) =>
    r.fulfill({
      json: [
        {
          path: '/repo',
          projectKey: '/repo/.git',
          kind: 'main',
          createdByApp: false,
          connectedAt: 1,
          projectName: 'repo',
          branch: 'main',
          missing: false,
        },
      ],
    }),
  );
  const worktree = (path: string, branch: string, main: boolean) => ({
    path,
    branch,
    main,
    detached: false,
    locked: false,
    prunable: false,
  });
  await context.route(`**/api/projects/${encodeURIComponent('/repo/.git')}/worktrees`, (r) =>
    r.fulfill({
      json: {
        hasCommits: true,
        worktrees: [
          worktree('/repo', 'main', true),
          worktree('/repo/.worktrees/fresh', 'fresh', false),
        ],
      },
    }),
  );
  await page.goto('/#capability=test');
  await page
    .getByRole('navigation', { name: 'Sessions' })
    .getByRole('button', { name: 'fresh, 0 open' })
    .click();
  const empty = page.getByRole('region', { name: 'Start a session' });
  await expect(empty).toBeVisible();
  await expect(empty).not.toContainText('Saved sessions');
  await expect(page.getByRole('button', { name: /^Saved sessions/ })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 420 });
  const start = empty.getByRole('button', { name: 'Start a session in fresh' });
  await start.scrollIntoViewIfNeeded();
  await expect(start).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
