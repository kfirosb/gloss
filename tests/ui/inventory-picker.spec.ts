import { test, expect } from '@playwright/test';
import { mockSession, basicSnapshot } from './session-fixture.js';

const inventory = {
  agent: 'codex',
  problems: [],
  entries: [
    { kind: 'mcp', name: 'playwright', scope: 'global', transport: 'stdio', target: 'npx' },
    {
      kind: 'skill',
      name: 'frontend-design',
      description: 'Build distinctive interfaces',
      scope: 'global',
    },
    { kind: 'skill', name: 'polish', description: 'Final design pass', scope: 'project' },
    {
      kind: 'skill',
      name: 'superpowers:brainstorming',
      description: 'Explore ideas',
      scope: 'plugin',
      plugin: 'superpowers',
    },
  ],
};

test('replacing a newline with Alt+Enter does not defer a caret move to the next edit', async ({
  page,
}) => {
  await mockSession(page, basicSnapshot);
  await page.route('**/api/sessions/*/events', (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: '' }),
  );
  await page.goto('/#capability=test');
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.fill('a\nb');
  await input.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(1, 2));
  await input.press('Alt+Enter');
  await expect(input).toHaveValue('a\nb');
  await input.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(3, 3));
  await input.pressSequentially('x');
  await expect(input).toHaveValue('a\nbx');
  expect(await input.evaluate((element) => (element as HTMLTextAreaElement).selectionStart)).toBe(
    4,
  );
});

test('an invocation insertion cannot move the cursor after a subsequent edit', async ({ page }) => {
  await mockSession(page, basicSnapshot);
  await page.route('**/api/sessions/*/events', (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: '' }),
  );
  await page.route('**/api/sessions/*/inventory', (route) => route.fulfill({ json: inventory }));
  await page.goto('/#capability=test');
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.fill('/front');
  await expect(page.getByRole('listbox', { name: 'Skills' }).getByRole('option')).toHaveCount(1);

  // Hold frame callbacks so the next edit deterministically precedes any delayed caret work.
  const frames = await page.evaluateHandle(() => {
    const original = window.requestAnimationFrame;
    const pending: FrameRequestCallback[] = [];
    window.requestAnimationFrame = (callback) => pending.push(callback);
    return {
      flush() {
        window.requestAnimationFrame = original;
        for (const callback of pending) callback(performance.now());
      },
    };
  });
  await input.press('Enter');
  await expect(input).toHaveValue('\u200E/frontend-design ');
  await input.fill('next edit');
  await input.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(0, 4));
  await frames.evaluate((state) => state.flush());
  expect(
    await input.evaluate((element) => {
      const field = element as HTMLTextAreaElement;
      return [field.selectionStart, field.selectionEnd];
    }),
  ).toEqual([0, 4]);
  await frames.dispose();
});

for (const [width, height] of [
  [1280, 800],
  [390, 700],
])
  test(`skills and MCP picker at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width: width!, height: height! });
    const snapshot = basicSnapshot();
    await mockSession(page, () => snapshot);
    await page.route('**/api/sessions/*/events', (r) =>
      r.fulfill({ contentType: 'text/event-stream', body: '' }),
    );
    const calls: { type: string }[] = [];
    await page.route('**/actions', (r) => {
      calls.push(r.request().postDataJSON());
      return r.fulfill({ json: { sessionId: snapshot.id, sequence: 2, snapshot } });
    });
    let requests = 0;
    await page.route('**/api/sessions/*/inventory', (r) => {
      requests++;
      return r.fulfill({ json: inventory });
    });
    await page.goto('/#capability=test');
    const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });

    await input.fill('תבנה /');
    const skills = page.getByRole('listbox', { name: 'Skills' });
    await expect(skills.getByRole('option')).toHaveCount(3);
    await expect(skills).toContainText('superpowers');
    await expect(skills).toContainText('Project');
    await input.pressSequentially('des');
    await expect(skills.getByRole('option')).toHaveText([/frontend-design/, /polish/]);
    await input.press('Enter');
    await expect(input).toHaveValue('תבנה ‎/frontend-design ');
    await expect(skills).toHaveCount(0);
    expect(await input.evaluate((e) => (e as HTMLTextAreaElement).selectionStart)).toBe(
      'תבנה \u200E/frontend-design '.length,
    );

    await input.pressSequentially('$pl');
    const servers = page.getByRole('listbox', { name: 'MCP servers' });
    await expect(servers.getByRole('option')).toHaveCount(1);
    await expect(servers).toContainText('local command · npx');
    await input.press('Tab');
    await expect(input).toHaveValue('תבנה ‎/frontend-design ‎$playwright ');

    await input.fill('/zzz');
    await expect(page.getByRole('status').filter({ hasText: 'No matching skills' })).toBeVisible();
    await input.press('Enter');
    await expect(page.getByRole('listbox', { name: 'Skills' })).toHaveCount(0);
    await expect(input).toHaveValue('/zzz');
    expect(calls.filter((c) => c.type === 'send-composer')).toHaveLength(0);
    await input.fill('');
    await input.fill('/zzz');
    await expect(page.getByRole('status').filter({ hasText: 'No matching skills' })).toBeVisible();
    await input.press('Escape');
    await expect(page.getByRole('listbox', { name: 'Skills' })).toHaveCount(0);
    for (const text of ['costs $5', 'a/b', '/front ']) {
      await input.fill(text);
      await expect(page.locator('.inventory-picker')).toHaveCount(0);
    }
    expect(requests).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
