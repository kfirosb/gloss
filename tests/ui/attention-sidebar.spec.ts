import { expect, test } from '@playwright/test';
import { sessionFixture } from './multi-session-fixture.js';
import type { CatalogSnapshot } from '../../src/core/session-catalog.js';

function catalogFor(f: Awaited<ReturnType<typeof sessionFixture>>, overrides: Record<string, Partial<CatalogSnapshot['entries'][number]>> = {}): CatalogSnapshot {
  return { epoch: 'sidebar', sequence: 1, discovery: { state: 'healthy' }, entries: f.records.map(r => ({ key: r.id, sessionId: r.id, target: { ...r.target, agent: 'codex' as const }, projectKey: '/repo/.git', projectName: 'repo', sessionTitle: `Session ${r.id}`, worktreePath: '/repo', open: true, activity: 'idle' as const, availability: 'available' as const, ...overrides[r.id] })) };
}
async function serve(context: any, catalog: CatalogSnapshot) {
  await context.route('**/api/session-catalog', (r: any) => r.fulfill({ json: catalog }));
  await context.route('**/api/session-catalog/events', (r: any) => r.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify(catalog) + '\n\n' }));
  await context.route('**/api/session-catalog/seen', (r: any) => r.fulfill({ json: { result: 'unchanged' } }));
}

test('folder row shows a working spinner and a red count with a breakdown label', async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const f = await sessionFixture(context);
  await page.addInitScript(() => { document.hasFocus = () => false; });
  await serve(context, catalogFor(f, { A: { activity: 'working' }, B: { activity: 'approval-required', attention: 'approval' } }));
  await page.goto('/#capability=test');
  const sidebar = page.getByRole('navigation', { name: 'Sessions' });
  const row = sidebar.locator('.project-folder[data-folder-key="/repo"]');
  await expect(row.getByRole('img', { name: 'Working' })).toBeVisible();
  await expect(row).toHaveAccessibleName('repo, 2 open, working, 1 session waiting: 1 approval');
  await expect(row.locator('.folder-count')).toHaveText('2');
  await expect(row.getByRole('img', { name: '1 session waiting: 1 approval' })).toHaveText('1');
  await expect(sidebar.locator('.project-toggle').getByRole('img', { name: '1 session waiting: 1 approval' })).toBeVisible();
});

test('two waiting sessions count as 2 on the folder, the project and the icon rail', async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const f = await sessionFixture(context);
  await page.addInitScript(() => { document.hasFocus = () => false; });
  await serve(context, catalogFor(f, { A: { attention: 'response', latestResponseSequence: 2 }, B: { activity: 'approval-required', attention: 'approval' } }));
  await page.goto('/#capability=test');
  const sidebar = page.getByRole('navigation', { name: 'Sessions' });
  const label = '2 sessions waiting: 1 response, 1 approval';
  await expect(sidebar.locator('.project-folder[data-folder-key="/repo"]').getByRole('img', { name: label })).toHaveText('2');
  await expect(sidebar.locator('.project-toggle').getByRole('img', { name: label })).toHaveText('2');
  await expect(sidebar.locator('.project-folder .attn-spinner')).toHaveCount(0);
  await expect(sidebar.locator('.project-toggle')).toHaveAccessibleName(/, 2 sessions waiting: 1 response, 1 approval$/);
  await page.getByRole('button', { name: 'Collapse sessions' }).click();
  await expect(sidebar.locator('.session-rail button').first().getByRole('img', { name: label })).toHaveText('2');
  await expect(sidebar.locator('.session-rail button').first()).toHaveAccessibleName(/, 2 sessions waiting: 1 response, 1 approval$/);
});

test('nothing waiting shows no badge and keeps the grey count', async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const f = await sessionFixture(context);
  await serve(context, catalogFor(f));
  await page.goto('/#capability=test');
  const sidebar = page.getByRole('navigation', { name: 'Sessions' });
  await expect(sidebar.locator('.project-folder[data-folder-key="/repo"] .folder-count')).toHaveText('2');
  await expect(sidebar.locator('.attn-badge')).toHaveCount(0);
});
