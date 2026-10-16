import { test, expect, type Page } from '@playwright/test';
import { mockSession, basicSnapshot } from './session-fixture.js';

const HOUR = 3600_000;
const entry = {
  key: 'U-panel',
  sessionId: 'U-panel',
  target: { agent: 'claude', sessionRef: 's1', projectId: '/project' },
  projectKey: '/project',
  projectName: 'project',
  worktreePath: '/project',
  open: true,
  activity: 'idle',
  availability: 'available',
};
async function withUsage(page: Page, usage: Record<string, unknown>) {
  const snap = { ...basicSnapshot(), id: 'U-panel', target: entry.target };
  await mockSession(page, () => snap);
  const catalog = {
    epoch: 'e',
    sequence: 1,
    discovery: { state: 'healthy' },
    entries: [entry],
    usage,
  };
  await page.unroute('**/api/session-catalog**');
  await page.route('**/api/session-catalog', (r) => r.fulfill({ json: catalog }));
  await page.route('**/api/session-catalog/events', (r) =>
    r.fulfill({
      contentType: 'text/event-stream',
      body: 'data: ' + JSON.stringify(catalog) + '\n\n',
    }),
  );
  await page.route('**/events', (r) =>
    r.request().url().includes('session-catalog')
      ? r.fallback()
      : r.fulfill({ contentType: 'text/event-stream', body: '' }),
  );
  const refreshes: unknown[] = [];
  await page.route('**/api/usage/refresh', (r) => {
    refreshes.push(r.request().postDataJSON());
    return r.fulfill({ json: usage });
  });
  await page.route('**/api/sessions/U-panel/usage', (r) =>
    r.fulfill({
      json: {
        provider: 'claude',
        model: 'haiku',
        usage: usage.claude ?? null,
        spend: {
          session: { usd: 0.004, inputTokens: 900, outputTokens: 80 },
          today: { usd: 0.09, inputTokens: 1, outputTokens: 1 },
          allTime: { usd: 0.31, inputTokens: 1, outputTokens: 1 },
        },
      },
    }),
  );
  return { refreshes };
}

test('the header shows usage left, and the popover shows both windows, refresh and what Gloss spent', async ({
  page,
}) => {
  const now = Date.now();
  const { refreshes } = await withUsage(page, {
    claude: {
      provider: 'claude',
      observedAt: now,
      fiveHour: { usedFraction: 0.37, resetsAt: now + 2.7 * HOUR },
      sevenDay: { usedFraction: 0.43, resetsAt: now + 100 * HOUR },
    },
  });
  await page.goto('/#capability=test');
  const pill = page.getByRole('button', { name: /^Claude Code usage:/ });
  await expect(pill).toHaveText('5h 63% left · week 57% left');
  await expect(pill).toHaveClass(/healthy/);
  await pill.click();
  const popover = page.getByRole('dialog', { name: 'Claude Code usage' });
  await expect(popover).toContainText('5-hour window');
  await expect(popover).toContainText('Renews in 2h 4');
  await expect(popover).toContainText('$0.004 this session');
  await expect(popover).toContainText('$0.31');
  await expect(popover).toContainText('haiku');
  await expect(popover).toContainText('not billed');
  await expect(popover).toContainText('Language Assistant chat');
  await popover.getByRole('button', { name: 'Refresh' }).click();
  await expect.poll(() => refreshes).toEqual([{ provider: 'claude' }]);
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
  await expect(page.getByRole('dialog', { name: /used up/ })).toHaveCount(0);
});

test('an exhausted 5-hour window turns the pill red and opens the break once', async ({ page }) => {
  const now = Date.now();
  await withUsage(page, {
    claude: {
      provider: 'claude',
      observedAt: now,
      fiveHour: { usedFraction: 1, resetsAt: now + 2.7 * HOUR },
      sevenDay: { usedFraction: 0.43, resetsAt: now + 100 * HOUR },
    },
  });
  await page.goto('/#capability=test');
  await expect(page.getByRole('button', { name: /^Claude Code usage:/ })).toHaveClass(/out/);
  await expect(page.getByRole('button', { name: /^Claude Code usage:/ })).toContainText(
    '5h quota renews in 2h 4',
  );
  const dialog = page.getByRole('dialog', { name: '5-hour window used up' });
  await expect(dialog).toContainText('Time for a break');
  await expect(dialog).toContainText('Your Claude Code quota renews in 2h 4');
  await expect(dialog.getByRole('link', { name: 'Upgrade plan' })).toHaveAttribute(
    'href',
    'https://claude.ai/upgrade',
  );
  const before = await dialog.locator('.quota-idea p').textContent();
  await dialog.getByRole('button', { name: 'Another idea' }).click();
  await expect(dialog.locator('.quota-idea p')).not.toHaveText(before!);
  await dialog.getByRole('button', { name: 'Dismiss' }).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(page.getByRole('button', { name: /^Claude Code usage:/ })).toHaveClass(/out/);
  await expect(page.getByRole('dialog', { name: '5-hour window used up' })).toBeHidden();
});

test('an exhausted week wins over the 5-hour window and suggests a real break', async ({
  page,
}) => {
  const now = Date.now();
  await withUsage(page, {
    claude: {
      provider: 'claude',
      observedAt: now,
      fiveHour: { usedFraction: 1, resetsAt: now + 2 * HOUR },
      sevenDay: { usedFraction: 1, resetsAt: now + 100 * HOUR },
    },
  });
  await page.goto('/#capability=test');
  const dialog = page.getByRole('dialog', { name: 'Weekly quota used up' });
  await expect(dialog).toContainText('This is a real break');
  await expect(dialog).toContainText(/weekly quota renews in 4d [34]h/);
  await expect(page.getByRole('dialog', { name: '5-hour window used up' })).toHaveCount(0);
});

test('without data the pill reads usage —', async ({ page }) => {
  await withUsage(page, {});
  await page.goto('/#capability=test');
  await expect(page.getByRole('button', { name: /^Claude Code usage:/ })).toHaveText('usage —');
});

test('Codex spend shows an estimated dollar figure with the dated price it used', async ({
  page,
}) => {
  const now = Date.now();
  const snap = {
    ...basicSnapshot(),
    id: 'C-panel',
    target: { agent: 'codex', sessionRef: 'c1', projectId: '/project' },
  };
  await mockSession(page, () => snap);
  const usage = {
    codex: {
      provider: 'codex',
      observedAt: now,
      fiveHour: { usedFraction: 0.16, resetsAt: now + HOUR },
      sevenDay: { usedFraction: 0.03, resetsAt: now + 100 * HOUR },
    },
  };
  const catalog = {
    epoch: 'e',
    sequence: 1,
    discovery: { state: 'healthy' },
    entries: [{ ...entry, key: 'C-panel', sessionId: 'C-panel', target: snap.target }],
    usage,
  };
  await page.unroute('**/api/session-catalog**');
  await page.route('**/api/session-catalog', (r) => r.fulfill({ json: catalog }));
  await page.route('**/api/session-catalog/events', (r) =>
    r.fulfill({
      contentType: 'text/event-stream',
      body: 'data: ' + JSON.stringify(catalog) + '\n\n',
    }),
  );
  await page.route('**/events', (r) =>
    r.request().url().includes('session-catalog')
      ? r.fallback()
      : r.fulfill({ contentType: 'text/event-stream', body: '' }),
  );
  await page.route('**/api/sessions/C-panel/usage', (r) =>
    r.fulfill({
      json: {
        provider: 'codex',
        model: 'gpt-5.6-sol',
        usage: usage.codex,
        prices: { input: 4, cachedInput: 0.4, output: 20, asOf: '2026-10-14' },
        spend: {
          session: { usd: 0.0231, inputTokens: 16812, outputTokens: 5 },
          today: { usd: 0.31, inputTokens: 1, outputTokens: 1 },
          allTime: null,
        },
      },
    }),
  );
  await page.goto('/#capability=test');
  const pill = page.getByRole('button', { name: /^Codex usage:/ });
  await expect(pill).toHaveText('5h 84% left · week 97% left');
  await pill.click();
  const popover = page.getByRole('dialog', { name: 'Codex usage' });
  await expect(popover).toContainText('≈ $0.02 this session');
  await expect(popover).toContainText('16.8k / 5 tokens');
  await expect(popover).toContainText('≈ $0.31');
  await expect(popover).toContainText('estimated at OpenAI API prices as of Oct 14, 2026');
  await expect(popover).toContainText(
    '$4.00 input, $0.40 cached input, $20.00 output per million tokens',
  );
});
