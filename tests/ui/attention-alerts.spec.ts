import { expect, test } from '@playwright/test';
import { sessionFixture } from './multi-session-fixture.js';
import type { CatalogSnapshot } from '../../src/core/session-catalog.js';

type Fixture = Awaited<ReturnType<typeof sessionFixture>>;
function catalogFor(f: Fixture, sequence: number, overrides: Record<string, Partial<CatalogSnapshot['entries'][number]>> = {}): CatalogSnapshot {
  return { epoch: 'alerts', sequence, discovery: { state: 'healthy' }, entries: f.records.map(r => ({ key: r.id, sessionId: r.id, target: { ...r.target, agent: 'codex' as const }, projectKey: '/repo/.git', projectName: 'repo', sessionTitle: `Session ${r.id}`, worktreePath: '/repo', open: true, activity: 'idle' as const, availability: 'available' as const, latestResponseSequence: 1, ...overrides[r.id] })) };
}
async function serve(context: any, first: CatalogSnapshot, next: CatalogSnapshot) {
  await context.route('**/api/session-catalog', (r: any) => r.fulfill({ json: first }));
  await context.route('**/api/session-catalog/events', async (r: any) => { await new Promise(res => setTimeout(res, 600)); return r.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify(next) + '\n\n' }); });
  await context.route('**/api/session-catalog/seen', (r: any) => r.fulfill({ json: { result: 'updated' } }));
}
const bridge = () => { (window as any).__alerts = []; (window as any).languageAssistant = { pickFolder: async () => null, setAttentionCount() {}, alert(p: unknown) { (window as any).__alerts.push(p); } }; document.hasFocus = () => true; };

test('a reply on another session shows a banner, plays one sound, and Open selects it', async ({ page, context }) => {
  const f = await sessionFixture(context);
  await page.addInitScript(bridge);
  await serve(context, catalogFor(f, 1), catalogFor(f, 2, { B: { attention: 'response', latestResponseSequence: 9 } }));
  await page.goto('/#capability=test');
  const banner = page.getByRole('status').filter({ hasText: 'New reply' });
  await expect(banner).toContainText('Session B');
  await expect.poll(() => page.evaluate(() => (window as any).__alerts)).toEqual([{ sound: 'Glass', bounce: true }]);
  await banner.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tab', { name: /Session B/ })).toHaveAttribute('aria-selected', 'true');
  await expect(banner).toHaveCount(0);
});

test('a reply on the shown session while focused shows nothing', async ({ page, context }) => {
  const f = await sessionFixture(context);
  await page.addInitScript(bridge);
  await serve(context, catalogFor(f, 1), catalogFor(f, 2, { A: { attention: 'response', latestResponseSequence: 9 } }));
  await page.goto('/#capability=test');
  await expect(page.getByRole('tab', { name: /Session A/ })).toHaveAttribute('aria-selected', 'true');
  await page.waitForTimeout(1200);
  await expect(page.getByRole('status').filter({ hasText: 'New reply' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__alerts)).toEqual([]);
});

test('an approval request says Approval needed, and switching both settings off silences it', async ({ page, context }) => {
  const f = await sessionFixture(context);
  await page.addInitScript(bridge);
  await serve(context, catalogFor(f, 1), catalogFor(f, 2, { B: { attention: 'approval', activity: 'approval-required' } }));
  await page.goto('/#capability=test');
  await expect(page.getByRole('status').filter({ hasText: 'Approval needed' })).toContainText('Session B');
  await page.evaluate(() => localStorage.setItem('language-assistant:alerts:v1', JSON.stringify({ version: 1, message: false, sound: false, soundName: 'Glass' })));
  await page.reload();
  await expect(page.getByRole('tab', { name: /Session A/ })).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(page.getByRole('status').filter({ hasText: 'Approval needed' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__alerts)).toEqual([]);
});
