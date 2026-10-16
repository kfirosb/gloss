import { test, expect } from '@playwright/test';
import { mockSession, basicSnapshot } from './session-fixture.js';

for (const href of ['/project/docs/plan.md:12', 'docs/plan.md', 'file:///project/docs/plan.md']) {
  test(`file link ${href} opens Files and popup without a tab`, async ({ page, context }) => {
    const text = `[תוכנית המימוש מוכנה](${href})`;
    await mockSession(page, () => ({
      ...basicSnapshot(),
      codingMessages: [
        {
          sourceId: 'reply',
          revision: 1,
          role: 'assistant',
          text,
          translatedText: text,
          translationStatus: 'complete',
          complete: true,
        },
      ],
    }));
    await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: '' }));
    await page.route('**/files/browse?*', (r) =>
      r.fulfill({ json: { entries: [], limited: false } }),
    );
    await page.route('**/files/preview?*', (r) => {
      expect(new URL(r.request().url()).searchParams.get('path')).toBe('docs/plan.md');
      return r.fulfill({
        json: {
          name: 'plan.md',
          relativePath: 'docs/plan.md',
          state: 'text',
          text: '# Implementation plan',
          size: 21,
        },
      });
    });
    await page.goto('/#capability=test');
    await page.getByRole('link', { name: 'תוכנית המימוש מוכנה' }).click();
    const dialog = page.getByRole('dialog', { name: 'File preview' });
    await expect(dialog.getByRole('heading', { name: 'Implementation plan' })).toBeVisible();
    expect(context.pages()).toHaveLength(1);
    await dialog.getByRole('button', { name: 'Close preview' }).click();
    await expect(
      page
        .getByRole('complementary', { name: 'Session files' })
        .getByRole('button', { name: 'Preview plan.md' }),
    ).toHaveAttribute('aria-current', 'true');
  });
}

for (const remote of [false, true])
  test(`HTML popup plays ${remote ? 'remote' : 'relative'} video without executing scripts`, async ({
    page,
  }) => {
    const text = '[Demo](/project/docs/demo.html)';
    await mockSession(page, () => ({
      ...basicSnapshot(),
      discussion: [{ role: 'assistant', text }],
    }));
    await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: '' }));
    await page.route('**/files/browse?*', (r) =>
      r.fulfill({ json: { entries: [], limited: false } }),
    );
    await page.route('**/files/preview?*', (r) =>
      r.fulfill({
        json: {
          name: 'demo.html',
          relativePath: 'docs/demo.html',
          state: 'text',
          text: `<h1>Video demo</h1><video muted><source src="${remote ? 'https://media.example.test/demo.webm' : 'clips/demo.webm'}" type="video/webm"></video><script>document.body.dataset.executed="yes"</script>`,
          size: 150,
        },
      }),
    );
    await page.route('**/files/media?*', (r) => {
      expect(new URL(r.request().url()).searchParams.get('path')).toBe('docs/clips/demo.webm');
      expect(r.request().headers().authorization).toBe('Bearer test');
      return r.fulfill({ path: 'tests/fixtures/preview-video.webm', contentType: 'video/webm' });
    });
    await page.route('https://media.example.test/demo.webm', (r) =>
      r.fulfill({ path: 'tests/fixtures/preview-video.webm', contentType: 'video/webm' }),
    );
    await page.goto('/#capability=test');
    await page.getByRole('link', { name: 'Demo', exact: true }).click();
    const frame = page.frameLocator('iframe[title="HTML preview"]');
    await expect(frame.getByRole('heading', { name: 'Video demo' })).toBeVisible();
    const video = frame.locator('video');
    await expect(video).toHaveAttribute('controls', '');
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
      .toBeGreaterThanOrEqual(2);
    await video.evaluate((v: HTMLVideoElement) => v.play());
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeGreaterThan(0);
    await expect(frame.locator('body')).not.toHaveAttribute('data-executed', 'yes');
  });
