import { mockSession, basicSnapshot } from './session-fixture.js';
import { expect, test } from '@playwright/test';
test('discussion composer is separate from coding delivery', async ({ page }) => {
  await mockSession(page, basicSnapshot);
  await page.goto('/#capability=test');
  const composer = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await composer.fill('הסבר את השינוי');
  await page.getByRole('button', { name: 'Discuss first', exact: true }).click();
  await expect(page.getByTestId('coding-delivery')).toHaveCount(0);
  await expect(page.getByText('Draft · not sent')).toHaveCount(0);
});
test('shift enter keeps a multiline Hebrew draft in the composer', async ({ page }) => {
  await mockSession(page, basicSnapshot);
  await page.goto('/#capability=test');
  const composer = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await composer.fill('שורה ראשונה');
  await composer.press('Shift+Enter');
  await composer.type('שורה שנייה');
  await expect(composer).toHaveValue('שורה ראשונה\nשורה שנייה');
});

test('latest translated reply stays visible above a long following user message', async ({
  page,
}) => {
  const snapshot = {
    id: 'test',
    codingState: 'working',
    codingMessages: [
      {
        sourceId: 'reply',
        revision: 1,
        role: 'assistant',
        text: 'Final reply',
        complete: true,
        translatedText: '\u05d4\u05d7\u05d9\u05d1\u05d5\u05e8 \u05e2\u05d5\u05d1\u05d3',
        translationStatus: 'complete',
      },
      {
        sourceId: 'followup',
        revision: 2,
        role: 'user',
        text: 'Long request',
        complete: true,
        translatedText: 'A long following request.\n'.repeat(70),
        translationStatus: 'complete',
      },
    ],
    discussion: [],
    deliveries: [],
    language: 'he',
    languageSessionId: 'l',
    languageModel: 'm',
    sourceRevision: 2,
  };
  await mockSession(page, () => snapshot);
  await page.route('**/api/sessions/*/events', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: 'data: ' + JSON.stringify({ sessionId: snapshot.id, sequence: 1, snapshot }) + '\n\n',
    }),
  );
  await page.goto('/#capability=test');
  const reply = page.locator('[data-source-id="reply"] .rich-text > p');
  await expect(reply).toContainText('\u05d4\u05d7\u05d9\u05d1\u05d5\u05e8');
  await expect
    .poll(() =>
      reply.evaluate((el) => {
        // The on-demand summary controls can mount after Web Crypto resolves.
        // A replaced text node is transient, not a completed visibility assertion.
        const container = el.closest('.feed');
        if (!container) return false;
        const box = el.getBoundingClientRect();
        const feed = container.getBoundingClientRect();
        return box.top >= feed.top && box.bottom <= feed.bottom;
      }),
    )
    .toBe(true);
  await expect(page.getByTestId('coding-delivery')).toHaveCount(0);
});

for (const [width, height] of [
  [1280, 800],
  [390, 600],
  [900, 450],
]) {
  test(`discussion controls stay accessible with long content at ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: width!, height: height! });
    const snapshot = {
      id: 'layout',
      target: { agent: 'codex', sessionRef: 'session', projectId: 'project' },
      codingState: 'working',
      codingMessages: [
        {
          sourceId: 'latest',
          revision: 1,
          role: 'assistant',
          text: 'Source text',
          complete: true,
          translatedText: 'Long source reply\n'.repeat(80),
          translationStatus: 'complete',
        },
      ],
      discussion: Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        text: 'Discussion turn\n'.repeat(8),
      })),
      currentDraft: {
        id: 'draft',
        revision: 1,
        target: { agent: 'codex', sessionRef: 'session', projectId: 'project' },
        sourceRevision: 1,
        language: 'he',
        localizedText: 'Long prepared instruction\n'.repeat(80),
        englishText: 'Long English instruction\n'.repeat(80),
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
    await page.goto('/#capability=layout');
    await page.getByRole('button', { name: 'Resume review' }).waitFor();
    for (const selector of ['.feed', '.discussion'])
      await page.locator(selector).evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
    const geometry = await page.evaluate(() => {
      const visible = (selector: string) => {
        const r = document.querySelector(selector)!.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
      };
      const c = document.querySelector('.composer')!.getBoundingClientRect(),
        f = document.querySelector('.feed')!.getBoundingClientRect();
      const b = document.querySelector('.preparation-controls')!.getBoundingClientRect();
      return {
        composer: visible('.composer'),
        send: visible('.preparation-controls'),
        discussion: visible('.discussion'),
        feed: visible('.feed'),
        noOverlap: c.left >= f.right || c.right <= f.left || c.top >= f.bottom || c.bottom <= f.top,
        controlsAboveComposer: b.bottom <= c.top,
        noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth,
      };
    });
    expect(Object.values(geometry).every(Boolean), JSON.stringify(geometry)).toBe(true);
    await page
      .getByRole('textbox', { name: 'Discuss with language assistant' })
      .fill('Draft remains usable');
  });
}
