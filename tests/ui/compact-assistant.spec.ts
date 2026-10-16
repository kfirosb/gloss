import { test, expect } from '@playwright/test';
import { sessionFixture } from './multi-session-fixture.js';
import { selectSession } from './session-fixture.js';
for (const [width, height] of [
  [1280, 800],
  [390, 700],
  [900, 450],
])
  test(`compact Assistant preserves layout and draft at ${width}`, async ({ page, context }) => {
    await page.setViewportSize({ width: width!, height: height! });
    await sessionFixture(context);
    await page.goto('/#capability=test');
    const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
    await input.fill('Keep this draft');
    await page.getByLabel('Panel layout').selectOption('rows');
    await page.getByRole('button', { name: 'Minimize Assistant', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Language discussion' })).toBeHidden();
    await expect(page.getByRole('region', { name: 'Live Hebrew conversation' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send to Terminal in English' })).toBeVisible();
    await page.reload();
    await expect(input).toHaveValue('Keep this draft');
    await expect(
      page.getByRole('button', { name: 'Show full Assistant', exact: true }),
    ).toBeVisible();
    await selectSession(page, 'B');
    await expect(page.getByRole('region', { name: 'Language discussion' })).toBeVisible();
    await selectSession(page, 'A');
    await expect(page.getByRole('region', { name: 'Language discussion' })).toBeHidden();
    await page.getByRole('button', { name: 'Show full Assistant', exact: true }).click();
    await expect(page.getByLabel('Panel layout')).toHaveValue('rows');
    await expect(input).toHaveValue('Keep this draft');
  });
test('compact Discuss first reopens discussion but Shift+Enter and terminal send keep mode', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  await page.goto('/#capability=test');
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.fill('Hello');
  await page.getByRole('button', { name: 'Minimize Assistant', exact: true }).click();
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('Hello\n');
  await expect(
    page.getByRole('button', { name: 'Show full Assistant', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Send to Terminal in English' }).click();
  await expect(input).toHaveValue('');
  await expect(
    page.getByRole('button', { name: 'Show full Assistant', exact: true }),
  ).toBeVisible();
  await input.fill('Discuss');
  await page.getByRole('button', { name: 'Discuss first', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Language discussion' })).toBeVisible();
  await expect
    .poll(() => f.calls.filter((a) => a.type === 'discuss'))
    .toEqual([{ sessionId: 'A', type: 'discuss', text: 'Discuss' }]);
  expect(f.calls.filter((a) => a.type === 'send-composer')).toHaveLength(1);
  await expect(input).toHaveValue('');
});
test('compact controls work when preference storage is denied', async ({ page, context }) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw Error('denied');
      },
    }),
  );
  await sessionFixture(context);
  await page.goto('/#capability=test');
  // Without storage the default (compact) applies; both controls still work in memory.
  await expect(page.getByRole('region', { name: 'Language discussion' })).toBeHidden();
  await page.getByRole('button', { name: 'Show full Assistant', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Language discussion' })).toBeVisible();
  await page.getByRole('button', { name: 'Minimize Assistant', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Language discussion' })).toBeHidden();
});
