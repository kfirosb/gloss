import { test, expect } from '@playwright/test';
import { sessionFixture } from './multi-session-fixture.js';
import { selectSession } from './session-fixture.js';
async function setup(context: Parameters<typeof sessionFixture>[0]) {
  const f = await sessionFixture(context);
  f.snapshots.A.codingMessages = [
    {
      sourceId: 'reply',
      role: 'assistant',
      revision: 1,
      text: 'Original source A',
      complete: true,
      translationStatus: 'complete',
      translatedText: 'התשובה המלאה',
    },
  ];
  f.snapshots.A.discussion = [
    { id: 'discussion-A', role: 'assistant', text: 'דיון מלא', complete: true },
  ];
  return f;
}
test('changing the assistant language discards a summary in the previous language', async ({
  page,
  context,
}) => {
  const f = await setup(context);
  await context.route('**/summaries', (route) =>
    route.fulfill({ json: { source: route.request().postDataJSON(), text: 'תקציר ישן' } }),
  );
  await page.goto('/#capability=test');
  const article = page.locator('[data-source-id="reply"]');
  await article.getByRole('button', { name: 'Summarize in Hebrew' }).click();
  await expect(article.getByText('תקציר ישן')).toBeVisible();
  await expect(article.locator('.response-summary > strong')).toHaveText('Summary');

  f.snapshots.A.languageSettings = { write: 'he', send: 'en', reply: 'he', assist: 'en' };
  f.sequences.A = (f.sequences.A ?? 0) + 1;
  await expect(article.getByRole('button', { name: 'Summarize in English' })).toBeVisible();
  await expect(article.getByText('תקציר ישן')).toBeHidden();
  await expect(article.getByText('התשובה המלאה')).toBeVisible();
});
test('summary is on demand reversible and keeps original source and actions unchanged', async ({
  page,
  context,
}) => {
  const f = await setup(context);
  let calls = 0;
  let release!: () => void;
  await context.route('**/summaries', async (route) => {
    calls++;
    await new Promise<void>((r) => {
      release = r;
    });
    await route.fulfill({ json: { source: route.request().postDataJSON(), text: 'תקציר קצר' } });
  });
  await page.goto('/#capability=test');
  const article = page.locator('[data-source-id="reply"]');
  expect(calls).toBe(0);
  await article.getByRole('button', { name: 'Summarize in Hebrew' }).click();
  await expect(article.getByText('התשובה המלאה')).toBeVisible();
  await expect.poll(() => calls).toBe(1);
  release();
  await expect(article.getByText('תקציר קצר')).toBeVisible();
  await expect(article.getByText('התשובה המלאה')).toBeHidden();
  await article.locator('summary').click();
  await expect(article.getByText('Original source A')).toBeVisible();
  await article.getByRole('button', { name: 'Show full response', exact: true }).click();
  await expect(article.getByText('התשובה המלאה')).toBeVisible();
  await article.getByRole('button', { name: 'Show summary', exact: true }).click();
  await expect(article.getByText('תקציר קצר')).toBeVisible();
  expect(calls).toBe(1);
  expect(f.calls).toEqual([]);
});
test('failures preserve full text and can be retried; incomplete and user messages have no summary', async ({
  page,
  context,
}) => {
  const f = await setup(context);
  f.snapshots.A.discussion = [
    { id: 'u', role: 'user', text: 'User' },
    { id: 'pending', role: 'assistant', text: 'Streaming', complete: false },
  ];
  let calls = 0;
  await context.route('**/summaries', (route) =>
    ++calls === 1
      ? route.fulfill({ status: 400, json: { error: 'Try later' } })
      : route.fulfill({ json: { source: route.request().postDataJSON(), text: 'תקציר' } }),
  );
  await page.goto('/#capability=test');
  await expect(page.getByRole('button', { name: 'Summarize in Hebrew' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Summarize in Hebrew' }).click();
  await expect(page.getByText('התשובה המלאה')).toBeVisible();
  await page.getByRole('button', { name: 'Retry summary' }).click();
  await expect(page.getByText('תקציר', { exact: true })).toBeVisible();
});
test('late summary cannot cross sessions or changed content with the same source ID', async ({
  page,
  context,
}) => {
  const f = await setup(context);
  let release!: () => void;
  let requested = false;
  await context.route('**/summaries', async (route) => {
    requested = true;
    await new Promise<void>((r) => {
      release = r;
    });
    await route.fulfill({ json: { source: route.request().postDataJSON(), text: 'Old summary' } });
  });
  await page.goto('/#capability=test');
  await page
    .locator('[data-source-id="reply"]')
    .getByRole('button', { name: 'Summarize in Hebrew' })
    .click();
  await expect.poll(() => requested).toBe(true);
  await selectSession(page, 'B');
  release();
  await expect(page.getByText('Old summary')).toBeHidden();
  f.snapshots.A.codingMessages[0].text = 'Changed source';
  f.snapshots.A.codingMessages[0].translatedText = 'תשובה חדשה';
  f.snapshots.A.codingMessages[0].revision = 2;
  f.sequences.A = 2;
  await selectSession(page, 'A');
  await expect(page.getByText('תשובה חדשה')).toBeVisible();
  await expect(page.getByText('Old summary')).toBeHidden();
});
