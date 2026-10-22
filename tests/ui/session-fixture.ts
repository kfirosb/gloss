import { expect, type Page } from '@playwright/test';
import { defaultWorkspace, type WorkspaceRecord } from '../../src/core/session-contracts.js';
/** The Assistant opens compact by default; these regression suites exercise the full view, so they start from an explicit
 * 'full' choice for their sessions (only when the page has no saved display preferences yet). */
export async function preferFullAssistant(
  target: Page | import('@playwright/test').BrowserContext,
  ids: string[],
) {
  await target.addInitScript((ids: string[]) => {
    try {
      const key = 'gloss:display:v1';
      if (!localStorage.getItem(key))
        localStorage.setItem(
          key,
          JSON.stringify({
            version: 1,
            collapsed: false,
            assistantModes: Object.fromEntries(ids.map((id) => [id, 'full'])),
            lastByFolder: {},
            tabOrder: {},
          }),
        );
    } catch {
      /* storage denied: the app's default applies */
    }
  }, ids);
}
/** Connected folders, worktrees, sidebar settings and About: empty defaults a spec can override with later routes. */
export async function mockSidebarDefaults(
  target: Page | import('@playwright/test').BrowserContext,
) {
  await target.route('**/api/folders', (route) =>
    route.fulfill(
      route.request().method() === 'GET'
        ? { json: [] }
        : { status: 404, json: { error: 'Not mocked' } },
    ),
  );
  await target.route('**/api/folders/search?*', (route) =>
    route.fulfill({ json: { hits: [], timedOut: false, unavailable: false } }),
  );
  await target.route('**/api/projects/*/worktrees', (route) =>
    route.fulfill({ json: { hasCommits: true, worktrees: [] } }),
  );
  await target.route('**/api/settings/sidebar', (route) =>
    route.fulfill({
      json:
        route.request().method() === 'PUT'
          ? route.request().postDataJSON()
          : { order: [], hidden: [], collapsed: [], worktreeLocation: {} },
    }),
  );
  await target.route('**/api/dictation', (route) =>
    route.fulfill({
      json: {
        available: false,
        reason: 'engine-missing',
        model: { present: false },
        engine: 'stopped',
      },
    }),
  );
  await target.route('**/api/about', (route) =>
    route.fulfill({
      json: {
        name: 'gloss',
        version: '0.0.0-test',
        platform: 'darwin',
        arch: 'arm64',
      },
    }),
  );
}
/** Modern scoped API fixture shared by the single-session regression suites. */
export async function mockSession(page: Page, snapshot: () => any) {
  await page.route('**/api/session-catalog**', (route) =>
    route.fulfill({ status: 503, json: { error: 'Discovery unavailable in fixture' } }),
  );
  await mockSidebarDefaults(page);
  await preferFullAssistant(page, [snapshot().id]);
  const workspaces = new Map<string, WorkspaceRecord>();
  await page.route('**/api/sessions', (route) => {
    const value = snapshot();
    return route.fulfill({
      json: [
        {
          id: value.id,
          target: value.target ?? { agent: 'codex', sessionRef: value.id, projectId: '/project' },
          canonicalRoot: value.target?.projectId ?? '/project',
          projectName: 'Project',
          enabled: true,
        },
      ],
    });
  });
  await page.route('**/api/**/snapshot', (route) =>
    route.fulfill({ json: { sessionId: snapshot().id, sequence: 0, snapshot: snapshot() } }),
  );
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ json: { sequence: 0, snapshot: snapshot() } }),
  );
  await page.route('**/api/sessions/*/workspace', (route) => {
    const id = snapshot().id;
    const saved = workspaces.get(id) ?? { sessionId: id, revision: 0, data: defaultWorkspace() };
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      if (body.expectedRevision !== saved.revision)
        return route.fulfill({ status: 409, json: { code: 'workspace-conflict', current: saved } });
      saved.revision++;
      saved.data = body.data;
      workspaces.set(id, saved);
    }
    return route.fulfill({ json: saved });
  });
  await page.route('**/api/sessions/*/files/*/metadata', (route) =>
    route.fulfill({
      json: {
        id: new URL(route.request().url()).pathname.split('/')[5],
        name: 'Screenshot.png',
        mime: 'image/png',
        size: 68,
        kind: 'image',
        index:
          Number(new URL(route.request().url()).pathname.split('/')[5]?.split('-').at(-1)) || 1,
        sessionId: snapshot().id,
        path: '/tmp/image.png',
        worktreePath: '/project',
        source: 'upload',
      },
    }),
  );
}
export const basicSnapshot = () => ({
  id: 'basic',
  target: { agent: 'codex', sessionRef: 'basic', projectId: '/project' },
  codingState: 'idle',
  codingMessages: [],
  discussion: [],
  deliveries: [],
  language: 'he',
  languageSessionId: '',
  languageModel: 'default',
  sourceRevision: 0,
});

/** The selection is tab-local, so sessionStorage is the one signal available with or without a catalog. */
export const selectedSessionId = (page: Page) =>
  page.evaluate(() => sessionStorage.getItem('selected-session'));
export async function expectSelected(page: Page, id: string) {
  await expect.poll(() => selectedSessionId(page)).toBe(id);
  // With discovery a tab exists for the session; assert the tab state too. The 503-catalog fixtures have none.
  const tab = page.locator(`[role=tab][data-session-id=${JSON.stringify(id)}]`);
  if (await tab.count()) await expect(tab).toHaveAttribute('aria-selected', 'true');
}
/** Reaches a session through its tab, the folder's Saved menu, or by visiting each folder. */
export async function selectSession(page: Page, id: string) {
  const tab = page.locator(`[role=tab][data-session-id=${JSON.stringify(id)}]`);
  const item = page.locator(`[role=menuitem][data-session-id=${JSON.stringify(id)}]`);
  const saved = page.getByRole('button', { name: /^Saved sessions \(\d+\)$/ });
  async function here() {
    if (await tab.count()) {
      await tab.click();
      return true;
    }
    if (await saved.count()) {
      await saved.click();
      if (await item.count()) {
        await item.click();
        return true;
      }
      await page.keyboard.press('Escape');
    }
    return false;
  }
  async function done() {
    await expectSelected(page, id);
  }
  if (await here()) {
    await done();
    return;
  }
  const expand = page.getByRole('button', { name: 'Expand sessions' });
  const count = await (async () => {
    if (await expand.isVisible()) await expand.click();
    return page.locator('[data-folder-key]').count();
  })();
  for (let i = 0; i < count; i++) {
    if (await expand.isVisible()) await expand.click();
    await page.locator('[data-folder-key]').nth(i).click();
    if (await here()) {
      await done();
      return;
    }
  }
  throw new Error('Session ' + id + ' not reachable from tabs, Saved menu or folders');
}
