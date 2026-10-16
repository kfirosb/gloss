import { expect, test } from '@playwright/test';
import { sessionFixture } from './multi-session-fixture.js';
import type { CatalogSnapshot } from '../../src/core/session-catalog.js';

function catalogFor(
  f: Awaited<ReturnType<typeof sessionFixture>>,
  overrides: Record<string, Partial<CatalogSnapshot['entries'][number]>> = {},
): CatalogSnapshot {
  return {
    epoch: 'seen',
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

test('the selected, focused session is marked seen once per response sequence', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  await page.addInitScript(() => {
    document.hasFocus = () => true;
  });
  const seen: unknown[] = [];
  await context.route('**/api/session-catalog/seen', (r) => {
    seen.push(r.request().postDataJSON());
    return r.fulfill({ json: { result: 'updated' } });
  });
  await serve(
    context,
    catalogFor(f, {
      A: { attention: 'response', latestResponseSequence: 7 },
      B: { attention: 'response', latestResponseSequence: 3 },
    }),
  );
  await page.goto('/#capability=test');
  await expect.poll(() => seen).toEqual([{ sessionId: 'A', sequence: 7 }]);
  await page.getByRole('tab', { name: /Session B/ }).click();
  await expect
    .poll(() => seen)
    .toEqual([
      { sessionId: 'A', sequence: 7 },
      { sessionId: 'B', sequence: 3 },
    ]);
  await page.getByRole('tab', { name: /Session A/ }).click();
  await page.waitForTimeout(300);
  expect(seen).toHaveLength(2);
});

test('an unfocused window never marks seen; focus marks it', async ({ page, context }) => {
  const f = await sessionFixture(context);
  await page.addInitScript(() => {
    (window as any).__focused = false;
    document.hasFocus = () => (window as any).__focused;
  });
  const seen: unknown[] = [];
  await context.route('**/api/session-catalog/seen', (r) => {
    seen.push(r.request().postDataJSON());
    return r.fulfill({ json: { result: 'updated' } });
  });
  await serve(context, catalogFor(f, { A: { attention: 'response', latestResponseSequence: 7 } }));
  await page.goto('/#capability=test');
  await expect(page.getByRole('tab', { name: /Session A/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.waitForTimeout(300);
  expect(seen).toEqual([]);
  await page.evaluate(() => {
    (window as any).__focused = true;
    window.dispatchEvent(new Event('focus'));
  });
  await expect.poll(() => seen).toEqual([{ sessionId: 'A', sequence: 7 }]);
});

test('approval attention is never marked seen from the browser', async ({ page, context }) => {
  await page.addInitScript(() => {
    document.hasFocus = () => true;
  });
  const f = await sessionFixture(context);
  const seen: unknown[] = [];
  await context.route('**/api/session-catalog/seen', (r) => {
    seen.push(r.request().postDataJSON());
    return r.fulfill({ json: { result: 'updated' } });
  });
  await serve(
    context,
    catalogFor(f, {
      A: { activity: 'approval-required', attention: 'approval', latestResponseSequence: 7 },
    }),
  );
  await page.goto('/#capability=test');
  await expect(page.getByRole('tab', { name: /Session A/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.waitForTimeout(300);
  expect(seen).toEqual([]);
});
