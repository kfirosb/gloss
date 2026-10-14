import { test, expect, type Page } from '@playwright/test';
import { mockSession, basicSnapshot } from './session-fixture.js';

const markdown = 'Run this:\n\n```sh\n$ npm test\n```\n\nAnd not this:\n\n```json\n{"a":1}\n```';
const sessionEntry = { key: 'S-panel', sessionId: 'S-panel', target: { agent: 'claude', sessionRef: 's1', projectId: '/project' }, projectKey: '/project', projectName: 'project', worktreePath: '/project', open: true, activity: 'idle', availability: 'available' };
const terminal = (over: Record<string, unknown> = {}) => ({ key: 'terminal:T1', launchId: 'T1', title: 'Terminal', busy: false, folder: '/project', projectKey: '/project', projectName: 'project', ...over });
async function withSession(page: Page, terminals: unknown[], terminalView = 'popup', opts: { typed?: boolean; output?: string; entries?: unknown[] } = {}) {
  const snap = { ...basicSnapshot(), id: 'S-panel', target: sessionEntry.target, codingMessages: [{ sourceId: 'm', revision: 1, role: 'assistant', text: markdown, translatedText: markdown, translationStatus: 'complete', complete: true }] };
  await mockSession(page, () => snap);
  let catalog = { epoch: 'e', sequence: 1, discovery: { state: 'healthy' }, entries: opts.entries ?? [sessionEntry], terminals };
  // Later catalogs reach the page when the events stream reconnects (it ends after each frame here).
  const setTerminals = (next: unknown[]) => { catalog = { ...catalog, sequence: catalog.sequence + 1, terminals: next }; };
  await page.unroute('**/api/session-catalog**');
  await page.route('**/api/session-catalog', r => r.fulfill({ json: catalog }));
  await page.route('**/api/session-catalog/events', r => r.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify(catalog) + '\n\n' }));
  const puts: any[] = [];
  await page.route('**/api/settings/launch', r => { if (r.request().method() === 'PUT') { puts.push(r.request().postDataJSON()); return r.fulfill({ json: { extraArgs: { claude: [], codex: [] }, popup: 'auto', terminalView: puts.at(-1).terminalView } }); } return r.fulfill({ json: { extraArgs: { claude: [], codex: [] }, popup: 'auto', terminalView } }); });
  const runs: any[] = [];
  await page.route('**/api/launches/run', r => { runs.push(r.request().postDataJSON()); return r.fulfill({ json: { launch: { id: 'T1', agent: 'shell', folder: '/project', title: 'Terminal', state: 'running', panePid: 3, createdAt: 0, busy: true }, reused: false, typed: opts.typed ?? true } }); });
  await page.route('**/api/launches/T1/terminal-ticket', r => r.fulfill({ json: { ticket: 'tk', expiresAt: Date.now() + 30000 } }));
  const received: any[] = [];
  await page.routeWebSocket(/\/api\/launches\/T1\/terminal\?ticket=tk/, ws => { ws.send(opts.output ?? 'project ❯ '); ws.onMessage(m => { received.push(JSON.parse(String(m))); }); });
  await page.route('**/events', r => r.request().url().includes('session-catalog') ? r.fallback() : r.fulfill({ contentType: 'text/event-stream', body: '' }));
  return { runs, puts, received, setTerminals };
}

test('Run appears only on shell blocks and opens the terminal popup with the typed command', async ({ page }) => {
  const { runs } = await withSession(page, []);
  await page.goto('/#capability=test');
  await expect(page.getByRole('button', { name: 'Run: npm test' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^Run:/ })).toHaveCount(1); // the JSON block has none
  await page.getByRole('button', { name: 'Run: npm test' }).click();
  await expect.poll(() => runs).toEqual([{ folder: '/project', command: 'npm test', originSessionId: 'S-panel' }]);
  const dialog = page.getByRole('dialog', { name: /Terminal:/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading')).toHaveText('Terminal · Project / project') // projectName comes from the mocked /api/sessions record;
  await expect(dialog.locator('.xterm')).toContainText('project ❯');
});
test('a terminal tab shows its state, opens the popup, and Expand switches to the workspace view', async ({ page }) => {
  const { puts } = await withSession(page, [terminal({ busy: true })]);
  await page.goto('/#capability=test');
  const tabs = page.getByRole('tablist', { name: 'Sessions in project' });
  const tab = tabs.getByRole('tab', { name: /Terminal/ });
  await expect(tab.getByLabel('Running')).toBeVisible();
  await tab.click();
  const dialog = page.getByRole('dialog', { name: /Terminal:/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Expand' }).click();
  await expect.poll(() => puts.map(p => p.terminalView)).toEqual(['workspace']);
  await expect(dialog).toBeHidden();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Shrink to popup' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send output to Claude' })).toBeDisabled();
  await page.getByRole('button', { name: 'Shrink to popup' }).click();
  await expect.poll(() => puts.map(p => p.terminalView)).toEqual(['workspace', 'popup']);
  await expect(dialog).toBeVisible();
});
test('with the workspace setting, clicking the tab shows the terminal in place of the conversation', async ({ page }) => {
  await withSession(page, [terminal()], 'workspace');
  await page.goto('/#capability=test');
  await page.getByRole('tablist', { name: 'Sessions in project' }).getByRole('tab', { name: /Terminal/ }).click();
  await expect(page.getByRole('button', { name: 'Shrink to popup' })).toBeVisible();
  await expect(page.getByText('At the prompt')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Discuss with language assistant' })).toHaveCount(0);
  await page.getByRole('tablist', { name: 'Sessions in project' }).getByRole('tab').first().click();
  await expect(page.getByRole('textbox', { name: 'Discuss with language assistant' })).toBeVisible();
});
test('a selected terminal in another folder survives a reload, and leaving its folder drops the terminal view', async ({ page }) => {
  const other = terminal({ folder: '/other', projectKey: '/other', projectName: 'other' });
  await withSession(page, [other], 'workspace');
  await page.addInitScript(() => { try { sessionStorage.setItem('selected-terminal', 'T1'); } catch { /* storage denied */ } });
  await page.goto('/#capability=test');
  const tabs = page.getByRole('tablist', { name: 'Sessions in other' });
  await expect(tabs).toBeVisible();
  await expect(tabs.getByRole('tab', { name: /Terminal/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Shrink to popup' })).toBeVisible();
  await page.locator('[data-folder-key]').filter({ hasText: 'project' }).first().click();
  await expect(page.getByRole('tablist', { name: 'Sessions in project' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Shrink to popup' })).toHaveCount(0);
});
test('Send output to Claude inserts exactly one fenced block in the composer', async ({ page }) => {
  await withSession(page, [terminal()], 'workspace', { output: 'OUTPUTWORD' });
  await page.goto('/#capability=test');
  await page.getByRole('tablist', { name: 'Sessions in project' }).getByRole('tab', { name: /Terminal/ }).click();
  const screen = page.locator('.terminal-workspace .xterm');
  await expect(screen).toContainText('OUTPUTWORD');
  const row = await screen.locator('.xterm-rows > div').first().boundingBox();
  await page.mouse.dblclick(row!.x + 20, row!.y + row!.height / 2); // a double click selects the word under it
  const send = page.getByRole('button', { name: 'Send output to Claude' });
  await expect(send).toBeEnabled();
  await send.click();
  const composer = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await expect(composer).toBeVisible();
  await expect(composer).toHaveValue(/```text\nOUTPUTWORD\n```/);
  await page.waitForTimeout(500);
  expect(((await composer.inputValue()).match(/```text/g) ?? []).length).toBe(1);
});
test('Run shows the not-ready notice in the popup', async ({ page }) => {
  const notice = 'The terminal may not have been ready. Check whether the command ran before running it again.';
  await withSession(page, [], 'popup', { typed: false });
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'Run: npm test' }).click();
  await expect(page.getByRole('dialog', { name: /Terminal:/ }).getByText(notice)).toBeVisible();
});
test('Run shows the not-ready notice in the workspace status line', async ({ page }) => {
  const notice = 'The terminal may not have been ready. Check whether the command ran before running it again.';
  await withSession(page, [terminal()], 'workspace', { typed: false }); // the run reuses the idle terminal already in the catalog
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'Run: npm test' }).click();
  await expect(page.locator('.terminal-workspace').getByText(notice)).toBeVisible();
});
test('a terminal popup closes when its shell exits', async ({ page }) => {
  const { setTerminals } = await withSession(page, [terminal()]);
  await page.goto('/#capability=test');
  await page.getByRole('tablist', { name: 'Sessions in project' }).getByRole('tab', { name: /Terminal/ }).click();
  const dialog = page.getByRole('dialog', { name: /Terminal:/ });
  await expect(dialog).toBeVisible();
  setTerminals([]);
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('tablist', { name: 'Sessions in project' }).getByRole('tab', { name: /Terminal/ })).toHaveCount(0);
});
test('the End terminal dialog lays out its English text left to right', async ({ page }) => {
  await withSession(page, [terminal()], 'workspace');
  await page.goto('/#capability=test');
  await page.getByRole('tablist', { name: 'Sessions in project' }).getByRole('tab', { name: /Terminal/ }).click();
  await page.getByRole('button', { name: 'End terminal…' }).click();
  const text = page.getByRole('dialog', { name: 'End terminal' }).getByText('Terminal and anything running in it will be closed.');
  await expect(text).toBeVisible();
  expect(await text.evaluate(el => getComputedStyle(el).direction)).toBe('ltr');
});
