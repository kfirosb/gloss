import { test, expect, type Page } from '@playwright/test';
import { defaultWorkspace } from '../../src/core/session-contracts.js';
import { mockSession, basicSnapshot, selectedSessionId } from './session-fixture.js';

interface Frame {
  type: string;
  data?: string;
  cols?: number;
  lines?: number;
}
const entryFor = (over: Record<string, unknown> = {}) => ({
  key: 'L-panel',
  sessionId: 'L-panel',
  target: { agent: 'claude', sessionRef: 's1', projectId: '/project' },
  projectKey: '/project',
  projectName: 'project',
  worktreePath: '/project',
  open: true,
  activity: 'idle',
  availability: 'available',
  launchId: 'L1',
  launchState: 'running',
  ...over,
});
const snapshot = () => ({
  ...basicSnapshot(),
  id: 'L-panel',
  target: { agent: 'claude', sessionRef: 's1', projectId: '/project' },
  codingMessages: [
    {
      sourceId: 'reply-1',
      revision: 1,
      role: 'assistant',
      text: 'English original',
      translatedText: 'תשובה מתורגמת',
      translationStatus: 'complete',
      complete: true,
    },
  ],
});
async function withLaunch(
  page: Page,
  activity = 'idle',
  popup = 'auto',
  extra: Record<string, unknown>[] = [],
  entryOver: Record<string, unknown> = {},
) {
  await mockSession(page, snapshot);
  const catalog = {
    epoch: 'e',
    sequence: 1,
    discovery: { state: 'healthy' },
    entries: [entryFor({ activity, ...entryOver }), ...extra],
  };
  // Each reconnect serves the current catalog, so a test can change the activity mid-run.
  const setActivity = (value: string) => {
    catalog.sequence++;
    catalog.entries[0] = entryFor({ ...entryOver, activity: value });
  };
  await page.unroute('**/api/session-catalog**');
  await page.route('**/api/session-catalog', (r) => r.fulfill({ json: catalog }));
  await page.route('**/api/session-catalog/events', (r) =>
    r.fulfill({
      contentType: 'text/event-stream',
      body: 'data: ' + JSON.stringify(catalog) + '\n\n',
    }),
  );
  await page.route('**/api/settings/launch', (r) =>
    r.fulfill({ json: { extraArgs: { claude: [], codex: [] }, popup, terminalView: 'popup' } }),
  );
  const tickets: string[] = [];
  const received: Frame[] = [];
  await page.route('**/api/launches/*/terminal-ticket', (r) => {
    tickets.push('x');
    return r.fulfill({ json: { ticket: 'tk', expiresAt: Date.now() + 30000 } });
  });
  let sockets = 0;
  await page.routeWebSocket(/\/api\/launches\/L\d\/terminal\?ticket=tk/, (ws) => {
    sockets++;
    ws.send('Allow this command? (y/n)');
    ws.onMessage((m) => {
      received.push(JSON.parse(String(m)) as Frame);
    });
  });
  await page.route('**/events', (r) =>
    r.request().url().includes('session-catalog')
      ? r.fallback()
      : r.fulfill({ contentType: 'text/event-stream', body: '' }),
  );
  return { tickets, received, setActivity, sockets: () => sockets };
}
const typed = (received: Frame[]) =>
  received
    .filter((m) => m.type === 'input')
    .map((m) => m.data)
    .join('');
const switcher = (page: Page) => page.getByRole('radiogroup', { name: 'Live Conversation view' });
const view = (page: Page, name: string) => switcher(page).getByRole('radio', { name });
const terminal = (page: Page) => page.locator('.pane-live .live-terminal');
const storedView = (page: Page) =>
  page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('language-assistant:display:v1') ?? '{}') as {
      liveViews?: Record<string, { view: string }>;
    };
    return saved.liveViews?.['L-panel']?.view;
  });
const feed = (page: Page) => page.getByRole('region', { name: 'Live Hebrew conversation' });
/** The notice next to the docked panel's view switch (the expanded panel renders its own copy). */
const notice = (page: Page) => page.locator('.pane-live > .pane-toolbar .live-attention-notice');
const expand = (page: Page) =>
  page.getByRole('button', { name: 'Expand Live Conversation' }).click();

test('Terminal view streams output and sends keystrokes', async ({ page }) => {
  const { received } = await withLaunch(page);
  await page.goto('/#capability=test');
  await view(page, 'Terminal').click();
  await expect(view(page, 'Terminal')).toHaveAttribute('aria-checked', 'true');
  await expect(terminal(page).locator('.xterm')).toContainText('Allow this command?');
  await expect(feed(page)).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: /Terminal:/ })).toHaveCount(0);
  await expect.poll(() => received.some((m) => m.type === 'resize' && m.cols! > 0)).toBe(true);
  await expect(terminal(page).locator('.xterm-helper-textarea')).toBeFocused();
  await page.keyboard.type('y');
  await expect.poll(() => typed(received)).toBe('y');
});
test('Split shows terminal and conversation; dragging the divider persists after reload', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await withLaunch(page);
  await page.goto('/#capability=test');
  await view(page, 'Split').click();
  await expect(terminal(page).locator('.xterm')).toContainText('Allow this command?');
  await expect(feed(page)).toBeVisible();
  const t = (await terminal(page).boundingBox())!;
  const f = (await feed(page).boundingBox())!;
  expect(t.x).toBeLessThan(f.x); // terminal on the left
  const divider = page.getByRole('separator', { name: 'Resize terminal' });
  const box = (await divider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  expect((await terminal(page).boundingBox())!.width).toBeGreaterThan(t.width + 40);
  const value = await divider.getAttribute('aria-valuenow');
  expect(value).not.toBe('50');
  await page.reload();
  await expect(view(page, 'Split')).toHaveAttribute('aria-checked', 'true');
  await expect(divider).toHaveAttribute('aria-valuenow', value!);
});
test('switching Split → Terminal → Expand → Restore keeps one terminal connection', async ({
  page,
}) => {
  const { tickets, sockets } = await withLaunch(page);
  await page.goto('/#capability=test');
  await view(page, 'Split').click();
  await expect(terminal(page).locator('.xterm')).toContainText('Allow this command?');
  // Development StrictMode mounts effects twice, so count from the first live connection.
  const connected = tickets.length;
  await view(page, 'Terminal').click();
  await page.getByRole('button', { name: 'Expand Live Conversation' }).click();
  const dialog = page.getByRole('dialog', { name: 'Live Conversation expanded' });
  await expect(dialog.locator('.live-terminal .xterm')).toContainText('Allow this command?');
  await expect(
    dialog.getByRole('radiogroup', { name: 'Live Conversation view' }).getByRole('radio', {
      name: 'Terminal',
    }),
  ).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('button', { name: 'Restore' }).click();
  await view(page, 'Split').click();
  await expect(terminal(page).locator('.xterm')).toContainText('Allow this command?');
  expect(tickets.length).toBe(connected);
  expect(sockets()).toBe(1);
});
test('Original shows the source text', async ({ page }) => {
  await withLaunch(page);
  await page.goto('/#capability=test');
  const reply = feed(page).locator('.message.assistant');
  await expect(reply).toContainText('תשובה מתורגמת');
  await view(page, 'Original').click();
  await expect(reply).toHaveAttribute('data-translation-status', 'original');
  await expect(reply).toContainText('English original');
  await view(page, 'Split').click();
  // The conversation side remembers the last of Translated / Original.
  const side = page.getByRole('radiogroup', { name: 'Conversation side' });
  await expect(side.getByRole('radio', { name: 'Original' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(reply).toHaveAttribute('data-translation-status', 'original');
  await side.getByRole('radio', { name: 'Translated' }).click();
  await expect(reply).toHaveAttribute('data-translation-status', 'complete');
});
test('approval switches to Split with a red outline and restores Translated when it ends', async ({
  page,
}) => {
  const { setActivity } = await withLaunch(page, 'approval-required', 'auto');
  await page.addInitScript(() => {
    const key = 'language-assistant:display:v1';
    const saved = JSON.parse(localStorage.getItem(key) ?? '{"version":1}') as object;
    const liveViews = { 'L-panel': { view: 'translated', conversation: 'translated', split: 50 } };
    localStorage.setItem(key, JSON.stringify({ ...saved, liveViews }));
  });
  await page.goto('/#capability=test');
  await expect(view(page, 'Split')).toHaveAttribute('aria-checked', 'true');
  await expect(terminal(page)).toHaveClass(/attn-ring/);
  await expect(view(page, 'Terminal').locator('.live-view-dot')).toBeVisible();
  await expect(terminal(page).locator('.xterm-helper-textarea')).not.toBeFocused();
  // Only the user's choices are remembered: the approval's Split is not saved.
  expect(await storedView(page)).toBe('translated');
  setActivity('idle');
  await expect(view(page, 'Translated')).toHaveAttribute('aria-checked', 'true', {
    timeout: 6000,
  });
  await expect(terminal(page)).toHaveCount(0);
});
test('choosing a view during approval prevents the restore', async ({ page }) => {
  const { setActivity } = await withLaunch(page, 'approval-required', 'auto');
  await page.goto('/#capability=test');
  await expect(view(page, 'Split')).toHaveAttribute('aria-checked', 'true');
  await view(page, 'Terminal').click();
  setActivity('idle');
  await expect(view(page, 'Terminal').locator('.live-view-dot')).toHaveCount(0, {
    timeout: 6000,
  });
  await expect(view(page, 'Terminal')).toHaveAttribute('aria-checked', 'true');
});
test('dot-only shows the dot and never switches', async ({ page }) => {
  await withLaunch(page, 'approval-required', 'dot-only');
  await page.goto('/#capability=test');
  await expect(view(page, 'Terminal').locator('.live-view-dot')).toBeVisible();
  await page.waitForTimeout(2500);
  await expect(view(page, 'Translated')).toHaveAttribute('aria-checked', 'true');
  await expect(terminal(page)).toHaveCount(0);
});
test('auto mode switches on approval, but not while typing', async ({ page }) => {
  await withLaunch(page, 'approval-required', 'auto');
  await page.goto('/#capability=test');
  const box = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await box.pressSequentially('typing now', { delay: 200 });
  await expect(view(page, 'Translated')).toHaveAttribute('aria-checked', 'true');
  await expect(view(page, 'Split')).toHaveAttribute('aria-checked', 'true', { timeout: 4000 });
  await expect(box).toBeFocused();
});
test('⌘` and Ctrl+` toggle the terminal, also while the terminal has focus', async ({ page }) => {
  const { received } = await withLaunch(page);
  await page.goto('/#capability=test');
  await view(page, 'Original').click();
  await page.keyboard.press('Meta+Backquote');
  await expect(view(page, 'Split')).toHaveAttribute('aria-checked', 'true');
  await view(page, 'Terminal').click();
  await terminal(page).locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Meta+Backquote');
  await expect(view(page, 'Original')).toHaveAttribute('aria-checked', 'true');
  await expect(terminal(page)).toHaveCount(0);
  // Ctrl+` too, since macOS may keep ⌘` for itself.
  await page.keyboard.press('Control+Backquote');
  await expect(view(page, 'Split')).toHaveAttribute('aria-checked', 'true');
  await terminal(page).locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Backquote');
  await expect(view(page, 'Original')).toHaveAttribute('aria-checked', 'true');
  expect(typed(received)).toBe('');
});
test('History in Terminal view switches to Split with history on', async ({ page }) => {
  await withLaunch(page);
  await page.goto('/#capability=test');
  await view(page, 'Terminal').click();
  await page.getByRole('button', { name: 'History Live Conversation' }).click();
  await expect(view(page, 'Split')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('button', { name: 'History Live Conversation' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(feed(page)).toBeVisible();
});
test('sessions without a launch get disabled Split and Terminal with the tooltip', async ({
  page,
}) => {
  await mockSession(page, () => basicSnapshot());
  await page.goto('/#capability=test');
  await expect(view(page, 'Translated')).toBeEnabled();
  await expect(view(page, 'Original')).toBeEnabled();
  for (const name of ['Split', 'Terminal']) {
    await expect(view(page, name)).toBeDisabled();
    await expect(view(page, name)).toHaveAttribute(
      'title',
      'Gloss can show the terminal only for sessions it started',
    );
  }
  await page.keyboard.press('Meta+Backquote');
  await expect(view(page, 'Translated')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('button', { name: 'Show terminal' })).toHaveCount(0);
});
test('a remembered terminal view without a launch shows its conversation side', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'language-assistant:display:v1',
      JSON.stringify({
        version: 1,
        liveViews: { basic: { view: 'terminal', conversation: 'original', split: 50 } },
      }),
    ),
  );
  await mockSession(page, () => basicSnapshot());
  await page.goto('/#capability=test');
  await expect(view(page, 'Original')).toHaveAttribute('aria-checked', 'true');
});
test('the attention notice shows next to the switch', async ({ page }) => {
  await withLaunch(page, 'idle', 'auto', [], {
    attentionNotice: 'Cannot tell if this session needs you',
  });
  await page.goto('/#capability=test');
  await expect(
    page.locator('.pane-live > .pane-toolbar').getByText('Cannot tell if this session needs you'),
  ).toBeVisible();
});
test('the view is remembered per session', async ({ page }) => {
  await withLaunch(page, 'idle', 'auto', [
    entryFor({ key: 'other', sessionId: 'other', launchId: 'L2', sessionTitle: 'Billing fix' }),
  ]);
  const record = (id: string) => ({
    id,
    target: entryFor().target,
    canonicalRoot: '/project',
    projectName: 'project',
    enabled: true,
  });
  await page.route('**/api/sessions', (r) =>
    r.fulfill({ json: [record('L-panel'), record('other')] }),
  );
  const idOf = (url: string) => new URL(url).pathname.split('/')[3]!;
  await page.route('**/api/sessions/*/snapshot', (r) => {
    const id = idOf(r.request().url());
    return r.fulfill({ json: { sessionId: id, sequence: 0, snapshot: { ...snapshot(), id } } });
  });
  await page.route('**/api/sessions/*/workspace', (r) =>
    r.fulfill({
      json: { sessionId: idOf(r.request().url()), revision: 0, data: defaultWorkspace() },
    }),
  );
  await page.goto('/#capability=test');
  await view(page, 'Terminal').click();
  await page.getByRole('tab', { name: /Billing fix/ }).click();
  await expect.poll(() => selectedSessionId(page)).toBe('other');
  await expect(view(page, 'Translated')).toHaveAttribute('aria-checked', 'true');
  await view(page, 'Original').click();
  await page.getByRole('tab').filter({ hasNotText: 'Billing fix' }).first().click();
  await expect.poll(() => selectedSessionId(page)).toBe('L-panel');
  await expect(view(page, 'Terminal')).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('tab', { name: /Billing fix/ }).click();
  await expect(view(page, 'Original')).toHaveAttribute('aria-checked', 'true');
});
test('the Hebrew line translates and types the result into the terminal', async ({ page }) => {
  const { received } = await withLaunch(page);
  await page.route('**/api/sessions/*/actions', (r) => {
    const action = r.request().postDataJSON() as { type: string };
    if (action.type !== 'translate-composer') return r.fallback();
    return r.fulfill({
      // A trailing line break must not press Enter twice.
      json: {
        sessionId: 'L-panel',
        sequence: 1,
        snapshot: snapshot(),
        translation: 'yes please\n',
      },
    });
  });
  await page.goto('/#capability=test');
  await view(page, 'Terminal').click();
  await expect.poll(() => received.some((m) => m.type === 'resize')).toBe(true);
  await expand(page);
  const line = page.getByRole('textbox', { name: 'Write to the terminal' });
  await line.fill('כן בבקשה');
  await line.press('Enter');
  await expect.poll(() => typed(received)).toBe('yes please\r');
  await expect(line).toHaveValue('');
  await expect(line).toBeFocused();
});
test('the mouse wheel scrolls the terminal instead of typing arrow keys', async ({ page }) => {
  const { received } = await withLaunch(page);
  await page.goto('/#capability=test');
  await view(page, 'Terminal').click();
  const screen = terminal(page).locator('.xterm-screen');
  await expect
    .poll(() => received.some((m) => m.type === 'resize' && (m.cols ?? 0) > 0))
    .toBe(true);
  const box = await screen.boundingBox();
  if (!box) throw new Error('terminal screen not laid out');
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.wheel(0, -300);
  await page.mouse.wheel(0, 300);
  const scrolls = () => received.filter((m) => m.type === 'scroll');
  await expect.poll(() => scrolls().some((m) => (m.lines ?? 0) > 0)).toBe(true);
  expect(scrolls()[0]).toMatchObject({ col: 1, row: 1 });
  expect(scrolls()[0]?.lines).toBeLessThan(0);
  expect(received.filter((m) => m.type === 'input')).toEqual([]);
});
test('the Hebrew line shows only in the expanded pane', async ({ page }) => {
  await withLaunch(page);
  await page.goto('/#capability=test');
  await view(page, 'Split').click();
  const line = page.getByRole('textbox', { name: 'Write to the terminal' });
  await expect(terminal(page).locator('.xterm')).toBeVisible();
  await expect(line).toBeHidden();
  await expand(page);
  await expect(line).toBeVisible();
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(line).toBeHidden();
});
test('a failed translation keeps the Hebrew line text and sends nothing', async ({ page }) => {
  const { received } = await withLaunch(page);
  await page.route('**/api/sessions/*/actions', (r) =>
    r.fulfill({ status: 500, json: { error: 'Translation service down' } }),
  );
  await page.goto('/#capability=test');
  await view(page, 'Terminal').click();
  await expect.poll(() => received.some((m) => m.type === 'resize')).toBe(true);
  await expand(page);
  const line = page.getByRole('textbox', { name: 'Write to the terminal' });
  await line.fill('כן בבקשה');
  await line.press('Enter');
  await expect(terminal(page).getByRole('alert')).toBeVisible();
  await expect(line).toHaveValue('כן בבקשה');
  expect(typed(received)).toBe('');
});
test('a translation of only control characters is not typed and keeps the text', async ({
  page,
}) => {
  const { received } = await withLaunch(page);
  await page.route('**/api/sessions/*/actions', (r) =>
    r.fulfill({
      json: { sessionId: 'L-panel', sequence: 1, snapshot: snapshot(), translation: '\r\n\u0007' },
    }),
  );
  await page.goto('/#capability=test');
  await view(page, 'Terminal').click();
  await expect.poll(() => received.some((m) => m.type === 'resize')).toBe(true);
  await expand(page);
  const line = page.getByRole('textbox', { name: 'Write to the terminal' });
  await line.fill('כן');
  await line.press('Enter');
  await expect(terminal(page).getByRole('alert')).toBeVisible();
  await expect(line).toHaveValue('כן');
  expect(typed(received)).toBe('');
});
test('the approval restore waits until the user leaves the terminal and stops typing', async ({
  page,
}) => {
  const { setActivity, received } = await withLaunch(page, 'approval-required', 'auto');
  await page.goto('/#capability=test');
  await expect(view(page, 'Split')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => received.some((m) => m.type === 'resize')).toBe(true);
  await terminal(page).locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('n');
  setActivity('idle');
  await expect(view(page, 'Terminal').locator('.live-view-dot')).toHaveCount(0, {
    timeout: 6000,
  });
  await page.waitForTimeout(2500);
  await expect(view(page, 'Split')).toHaveAttribute('aria-checked', 'true');
  // Unsent text in the Hebrew line holds the terminal too, even with the focus elsewhere.
  await expand(page);
  const line = page.getByRole('textbox', { name: 'Write to the terminal' });
  await line.fill('לא');
  await feed(page).click();
  await page.waitForTimeout(2500);
  await expect(view(page, 'Split').first()).toHaveAttribute('aria-checked', 'true');
  await line.fill('');
  await feed(page).click();
  await expect(view(page, 'Translated').first()).toHaveAttribute('aria-checked', 'true', {
    timeout: 4000,
  });
});
test('changing the conversation side during an approval keeps the restore', async ({ page }) => {
  const { setActivity } = await withLaunch(page, 'approval-required', 'auto');
  await page.goto('/#capability=test');
  await expect(view(page, 'Split')).toHaveAttribute('aria-checked', 'true');
  await page
    .getByRole('radiogroup', { name: 'Conversation side' })
    .getByRole('radio', { name: 'Original' })
    .click();
  expect(await storedView(page)).toBe('translated');
  setActivity('idle');
  await expect(view(page, 'Translated')).toHaveAttribute('aria-checked', 'true', {
    timeout: 6000,
  });
  await view(page, 'Split').click();
  await expect(
    page.getByRole('radiogroup', { name: 'Conversation side' }).getByRole('radio', {
      name: 'Original',
    }),
  ).toHaveAttribute('aria-checked', 'true');
});
test('a terminal Send the server declines shows the terminal in Split with the reason and keeps the text', async ({
  page,
}) => {
  await withLaunch(page);
  const target = { agent: 'claude', sessionRef: 's1', projectId: '/project' };
  await page.route('**/api/sessions/*/claude-route', (r) =>
    r.fulfill({ json: { transport: 'tmux' } }),
  );
  await page.route('**/api/sessions/*/claude-channel', (r) =>
    r.fulfill({ json: { state: 'setup-required' } }),
  );
  let sequence = 0;
  await page.route('**/api/sessions/*/actions', (r) => {
    const action: unknown = r.request().postDataJSON();
    const requestId =
      action && typeof action === 'object' && 'requestId' in action
        ? String(action.requestId)
        : 'x';
    return r.fulfill({
      json: {
        sessionId: 'L-panel',
        sequence: ++sequence,
        snapshot: {
          ...snapshot(),
          deliveries: [
            {
              id: 'd-' + requestId,
              draftId: 'composer-' + requestId,
              revision: 1,
              target,
              englishText: 'Hello',
              state: 'failed',
              reason: 'A dialog is open in the terminal',
              transport: 'tmux',
              openTerminal: true,
            },
          ],
        },
      },
    });
  });
  await page.goto('/#capability=test');
  await expect(view(page, 'Translated')).toHaveAttribute('aria-checked', 'true');
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.fill('שלום');
  const send = page.getByRole('button', { name: 'Send to Terminal in English', exact: true });
  await send.click();
  await expect(view(page, 'Split')).toHaveAttribute('aria-checked', 'true');
  await expect(terminal(page)).toBeVisible();
  // The strip already says why it was not sent; the notice only says what to do.
  await expect(page.locator('.status-strip')).toContainText(
    'Not sent: A dialog is open in the terminal',
  );
  await expect(notice(page)).toHaveText(
    'Your message is still in Gloss; press Send again when the terminal is ready.',
  );
  // The page is right-to-left (Hebrew); the English reason and notice read left to right, period last.
  const direction = (element: Element) => getComputedStyle(element).direction;
  expect(await page.locator('.app').evaluate(direction)).toBe('rtl');
  expect(await notice(page).evaluate(direction)).toBe('ltr');
  expect(
    await page
      .locator('.status-strip')
      .getByText('Not sent:', { exact: false })
      .evaluate(direction),
  ).toBe('ltr');
  await expect(input).toHaveValue('שלום');
  await expect(send).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Don’t send' })).toHaveCount(0);
  // Picking a view is the user's answer to the notice: it goes away.
  await view(page, 'Translated').click();
  await expect(notice(page)).toHaveCount(0);
});
test('a review Send shows the terminal only for its own newest delivery, not an older declined one', async ({
  page,
}) => {
  await withLaunch(page);
  const target = { agent: 'claude', sessionRef: 's1', projectId: '/project' };
  const draft = {
    id: 'review-draft',
    revision: 1,
    target,
    sourceRevision: 1,
    language: 'he',
    localizedText: 'הוראה מוכנה',
    englishText: 'Prepared instruction',
    selectedDiscussion: [0],
  };
  const declined = {
    id: 'd-1',
    draftId: draft.id,
    revision: 1,
    target,
    englishText: 'Prepared instruction',
    state: 'failed',
    reason: 'A dialog is open in the terminal',
    transport: 'tmux',
    // Still in the server's memory from the declined Send; a later Send's reply carries it too.
    openTerminal: true,
  };
  const delivered = {
    id: 'd-2',
    draftId: draft.id,
    revision: 2,
    target,
    englishText: 'Prepared instruction',
    state: 'sent',
    transport: 'tmux',
  };
  let deliveries: Record<string, unknown>[] = [];
  const current = () => ({
    ...snapshot(),
    discussion: [{ role: 'user', text: 'Selected request' }],
    currentDraft: draft,
    deliveries,
  });
  await page.route('**/api/**/snapshot', (r) =>
    r.fulfill({ json: { sessionId: 'L-panel', sequence: 0, snapshot: current() } }),
  );
  await page.route('**/api/sessions/*/claude-route', (r) =>
    r.fulfill({ json: { transport: 'tmux' } }),
  );
  await page.route('**/api/sessions/*/claude-channel', (r) =>
    r.fulfill({ json: { state: 'setup-required' } }),
  );
  let sequence = 0;
  let reviewSends = 0;
  await page.route('**/api/sessions/*/actions', (r) => {
    const action: unknown = r.request().postDataJSON();
    if (action && typeof action === 'object' && 'type' in action && action.type === 'send-review')
      deliveries = ++reviewSends === 1 ? [declined] : [declined, delivered];
    return r.fulfill({
      json: { sessionId: 'L-panel', sequence: ++sequence, snapshot: current() },
    });
  });
  await page.goto('/#capability=test');
  await expect(view(page, 'Translated')).toHaveAttribute('aria-checked', 'true');
  const review = page.getByRole('dialog', { name: 'Review instruction', exact: true });
  await page.getByRole('button', { name: 'Resume review', exact: true }).click();
  await review.getByRole('button', { name: 'Send to Terminal', exact: true }).click();
  await expect(view(page, 'Split')).toHaveAttribute('aria-checked', 'true');
  // No strip shows a review's delivery, so the notice says why.
  await expect(notice(page)).toHaveText(
    'Not sent: A dialog is open in the terminal. Your message is still in Gloss; press Send again when the terminal is ready.',
  );
  // The modal review would cover the terminal, so it closes; its text waits behind Resume review.
  await expect(review).toBeHidden();
  await expect(terminal(page)).toBeVisible();
  await view(page, 'Translated').click();
  await page.getByRole('button', { name: 'Resume review', exact: true }).click();
  await expect(review).toContainText('הוראה מוכנה');
  await expect(review.getByRole('status')).toContainText('Not sent');
  await review.getByRole('button', { name: 'Send to Terminal', exact: true }).click();
  await expect.poll(() => reviewSends).toBe(2);
  await expect(page.getByRole('button', { name: 'Resume review', exact: true })).toHaveCount(0);
  await expect(view(page, 'Translated')).toHaveAttribute('aria-checked', 'true');
  await expect(notice(page)).toHaveCount(0);
});
