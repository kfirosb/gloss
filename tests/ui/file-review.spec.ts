import { test, expect } from '@playwright/test';
import { mockSession, basicSnapshot } from './session-fixture.js';
test('file review provides a cached TL;DR and translation with original available', async ({
  page,
}) => {
  const text = '[Open plan](/project/docs/long-plan.md)';
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
        name: 'long-plan.md',
        relativePath: 'docs/long-plan.md',
        state: 'text',
        text: '# Original plan\n\nLong content',
        size: 29,
        version: 'v1',
      },
    }),
  );
  await page.route('**/files/review-status?*', (r) =>
    r.fulfill({ json: { summary: true, translation: false } }),
  );
  const modes: string[] = [];
  await page.route('**/files/review', (r) => {
    const body = r.request().postDataJSON();
    modes.push(body.mode);
    expect(body).toMatchObject({ path: 'docs/long-plan.md', version: 'v1' });
    return r.fulfill({
      json: {
        path: body.path,
        mode: body.mode,
        text: body.mode === 'summary' ? 'תקציר התוכנית' : 'תרגום מלא של התוכנית',
      },
    });
  });
  await page.goto('/#capability=test');
  await page.getByRole('link', { name: 'Open plan' }).click();
  const dialog = page.getByRole('dialog', { name: 'Files' });
  const summaryChip = dialog.getByRole('button', { name: 'TL;DR', exact: true });
  const translateChip = dialog.getByRole('button', { name: 'Translate', exact: true });
  await expect(summaryChip).toHaveAttribute('data-saved', 'true');
  await expect(summaryChip).toHaveAttribute('title', 'Saved summary — shows instantly');
  await expect(translateChip).not.toHaveAttribute('data-saved', 'true');
  await summaryChip.click();
  await expect(dialog.getByLabel('File summary')).toContainText('תקציר התוכנית');
  await expect(dialog.getByRole('heading', { name: 'Original plan' })).toBeHidden();
  await dialog.getByRole('button', { name: 'Translate', exact: true }).click();
  await expect(dialog.getByLabel('File translation')).toContainText('תרגום מלא של התוכנית');
  await expect(translateChip).toHaveAttribute('data-saved', 'true');
  await dialog.getByRole('button', { name: 'Show original', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Original plan' })).toBeVisible();
  await dialog.getByRole('button', { name: 'TL;DR', exact: true }).click();
  await expect(dialog.getByLabel('File summary')).toBeVisible();
  expect(modes).toEqual(['summary', 'translation']);
  await dialog.screenshot({ path: '/tmp/file-review-summary.png' });
  await dialog.getByRole('button', { name: 'Close files' }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  const row = page.locator('.revealed-file .file-tree-row');
  expect((await row.boundingBox())!.height).toBeLessThanOrEqual(32);
  await expect(page.locator('.revealed-file > small').last()).toHaveText('docs');
  await page.locator('.revealed-file').screenshot({ path: '/tmp/file-review-card.png' });
});

test('review errors preserve the original and let the user retry', async ({ page }) => {
  await mockSession(page, basicSnapshot);
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route('**/files/search?*', (r) =>
    r.fulfill({ json: [{ name: 'plan.md', relativePath: 'plan.md' }] }),
  );
  await page.route('**/files/preview?*', (r) =>
    r.fulfill({
      json: {
        name: 'plan.md',
        relativePath: 'plan.md',
        state: 'text',
        text: '# Original plan',
        size: 15,
      },
    }),
  );
  let calls = 0;
  await page.route('**/files/review', (r) =>
    ++calls === 1
      ? r.fulfill({ status: 400, json: { error: 'Try again' } })
      : r.fulfill({ json: { path: 'plan.md', mode: 'summary', text: 'תקציר' } }),
  );
  await page.goto('/#capability=test');
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.fill('@plan');
  await expect(page.locator('.file-picker [role=option]')).toHaveCount(1);
  await input.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Files' }).locator('.files-window-preview');
  await dialog.getByRole('button', { name: 'TL;DR', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Try again');
  await expect(dialog.getByRole('heading', { name: 'Original plan' })).toBeVisible();
  await dialog.getByRole('button', { name: 'TL;DR', exact: true }).click();
  await expect(dialog.getByLabel('File summary')).toContainText('תקציר');
});
