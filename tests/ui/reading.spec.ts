import { mockSession } from './session-fixture.js';
import { expect, test } from '@playwright/test';

test('panes resize, expand and retain safe readable Markdown', async ({ page, context }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as unknown as { copiedCode: string }).copiedCode = text;
        },
      },
    });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const markdown =
    '# Heading\n\n**Bold** and ==highlight==\n\n- First\n- Second\n\n> Quoted text\n\n[Docs](https://example.com)\n\n```js\n' +
    'const longLine = "' +
    'x'.repeat(500) +
    '";\n```\n\n<script>alert(1)</script>\n[Bad](javascript:alert(1))';
  const target = { agent: 'codex', sessionRef: 's', projectId: 'p' };
  const snapshot = {
    id: 'reading',
    target,
    codingState: 'idle',
    codingMessages: [
      {
        sourceId: 'm',
        revision: 1,
        role: 'assistant',
        text: markdown,
        translatedText: markdown,
        translationStatus: 'complete',
        complete: true,
      },
    ],
    discussion: [{ role: 'assistant', text: markdown }],
    currentDraft: {
      id: 'd',
      revision: 1,
      target,
      sourceRevision: 1,
      language: 'he',
      localizedText: markdown,
      englishText: markdown,
    },
    deliveries: [],
    language: 'he',
    languageSessionId: 'l',
    languageModel: 'm',
    sourceRevision: 1,
  };
  await mockSession(page, () => snapshot);
  await page.route('**/api/sessions/*/events', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: 'data: ' + JSON.stringify({ sessionId: snapshot.id, sequence: 1, snapshot }) + '\n\n',
    }),
  );
  await page.goto('/#capability=test');
  await expect(page.locator('.pane-live .rich-text h1')).toHaveText('Heading');
  await expect(page.locator('.pane-live mark')).toHaveText('highlight');
  await expect(page.locator('.pane-live .rich-text strong')).toHaveText('Bold');
  await expect(page.locator('.pane-live blockquote')).toContainText('Quoted');
  await expect(page.locator('.pane-live .rich-text li')).toHaveCount(2);
  await expect(page.locator('.pane-live script')).toHaveCount(0);
  await expect(page.locator('.pane-live a').last()).not.toHaveAttribute('href', /javascript:/);
  await expect(
    page.locator('.pane-live .code-block pre').evaluate((el) => el.scrollWidth > el.clientWidth),
  ).resolves.toBe(true);
  for (const title of ['Live Conversation', 'Language Assistant']) {
    const slider = page.getByRole('separator', { name: `Resize ${title}`, exact: true });
    await slider.focus();
    await slider.press('Home');
    await slider.press(title === 'Live Conversation' ? 'ArrowLeft' : 'ArrowDown');
    await expect(slider).toHaveAttribute('aria-valuenow', '15');
    await page.getByRole('button', { name: `Expand ${title}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `${title} expanded` });
    await expect(dialog).toBeVisible();
    expect((await dialog.boundingBox())!.height).toBeGreaterThan(800);
    await expect(dialog.locator('h1')).toHaveText('Heading');
    await dialog.getByRole('button', { name: 'Copy code', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => (window as unknown as { copiedCode: string }).copiedCode),
    ).toContain('const longLine =');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: `Expand ${title}`, exact: true })).toBeFocused();
  }
  await page.reload();
  for (const title of ['Live Conversation', 'Language Assistant'])
    await expect(
      page.getByRole('separator', { name: `Resize ${title}`, exact: true }),
    ).toHaveAttribute('aria-valuenow', '15');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
