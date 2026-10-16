import { expect, test, type Page } from '@playwright/test';
async function boot(page: Page, sessions = ['A', 'B']) {
  await page.evaluate(async (sessions) => {
    // @ts-expect-error Vite browser module URL
    const { workspaceFor } = await import('/src/ui/use-workspace.ts');
    const controllers: Record<string, any> = {};
    // The routed server stays at revision zero: edits are deliberately unsaved.
    for (const id of sessions) {
      const controller = workspaceFor(id);
      await controller.hydrate(
        {
          id,
          codingState: 'idle',
          codingMessages: [],
          discussion: [],
          deliveries: [],
          language: 'he',
          languageSessionId: '',
          languageModel: 'default',
          sourceRevision: 0,
        },
        'A',
      );
      controllers[id] = controller;
    }
    (window as any).workspaces = controllers;
  }, sessions);
}
async function text(page: Page, id: string) {
  return page.evaluate((id) => (window as any).workspaces[id].record.data.composer, id);
}
test('opener tabs and repeated reloads retain independent active and inactive recovery', async ({
  page,
  context,
}) => {
  await context.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/workspace') && route.request().method() === 'GET') {
      const { defaultWorkspace } = await import('../../src/core/session-contracts.js');
      return route.fulfill({
        json: { sessionId: path.split('/')[3], revision: 0, data: defaultWorkspace() },
      });
    }
    return route.fulfill({ status: 503, json: { error: 'Offline fixture' } });
  });
  await page.goto('/');
  await boot(page);
  await page.evaluate(() => {
    for (const id of ['A', 'B'])
      (window as any).workspaces[id].update((d: any) => {
        d.composer = 'first ' + id;
      });
  });
  const opened = context.waitForEvent('page');
  await page.evaluate(() => window.open('/', '_blank'));
  const second = await opened;
  await second.waitForLoadState();
  await boot(second);
  expect(await text(second, 'A')).toBe('');
  await second.evaluate(() => {
    for (const id of ['A', 'B'])
      (window as any).workspaces[id].update((d: any) => {
        d.composer = 'second ' + id;
      });
  });
  for (let i = 0; i < 2; i++) {
    await page.reload();
    await boot(page, ['A']);
    expect(await text(page, 'A')).toBe('first A');

    await second.reload();
    await boot(second, ['A']);
    expect(await text(second, 'A')).toBe('second A');
  }
  // B was inactive throughout both reloads, and must remain recoverable.
  await boot(page);
  await boot(second);
  expect(await text(page, 'B')).toBe('first B');
  expect(await text(second, 'B')).toBe('second B');
});
