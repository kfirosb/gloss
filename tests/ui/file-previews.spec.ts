import { test, expect } from '@playwright/test';
import { mockSession, basicSnapshot } from './session-fixture.js';
async function setup(page: import('@playwright/test').Page, name: string, text: string) {
  await mockSession(page, basicSnapshot);
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route('**/files/search?*', (r) => r.fulfill({ json: [{ name, relativePath: name }] }));
  await page.route('**/files/preview?*', (r) =>
    r.fulfill({ json: { name, relativePath: name, state: 'text', text, size: text.length } }),
  );
  await page.goto('/#capability=test');
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.fill('@file');
  await expect(page.locator('.file-picker [role=option]')).toHaveCount(1);
  await input.press('Enter');
  return page.getByRole('dialog', { name: 'Files' }).locator('.files-window-preview');
}
for (const [width, height] of [
  [1280, 800],
  [390, 700],
  [900, 450],
])
  test(`Markdown rendered/source preview at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width: width!, height: height! });
    const source =
      '# Project guide\n\n**Important**\n\n- First item\n- Second item\n\n> A quotation\n\n[Docs](https://example.com)\n\n```js\nconst ready = true;\n```';
    const dialog = await setup(page, 'README.md', source);
    await expect(dialog.getByRole('heading', { name: 'Project guide' })).toBeVisible();
    await expect(dialog.locator('strong')).toContainText(['README.md', 'Important']);
    await expect(dialog.getByRole('link', { name: 'Docs' })).toHaveAttribute(
      'href',
      'https://example.com',
    );
    await dialog.getByRole('tab', { name: 'Source', exact: true }).click();
    await expect(dialog.locator('.file-source')).toContainText('# Project guide');
    await expect(dialog.getByRole('heading', { name: 'Project guide' })).toHaveCount(0);
    await dialog.getByRole('tab', { name: 'Preview', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'Project guide' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Attach file', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
test('HTML renders static form content without scripts or external resource loads', async ({
  page,
}) => {
  let external = 0;
  await page.route('https://preview-test.invalid/**', (r) => {
    external++;
    return r.abort();
  });
  const html =
    '<style>h1{color:rgb(1, 2, 3)}</style><h1>HTML example</h1><script>document.body.dataset.executed="yes"</script><img src="https://preview-test.invalid/a"><meta http-equiv="refresh" content="0;url=https://preview-test.invalid/"><form action="https://preview-test.invalid/"><label>Name<input></label><button>Submit</button></form>';
  const dialog = await setup(page, 'demo.html', html);
  const frame = page.frameLocator('iframe[title="HTML preview"]');
  await expect(frame.getByRole('heading', { name: 'HTML example' })).toBeVisible();
  await expect(frame.getByRole('heading')).toHaveCSS('color', 'rgb(1, 2, 3)');
  await expect(frame.locator('body')).not.toHaveAttribute('data-executed', 'yes');
  await expect(dialog.locator('iframe')).toHaveAttribute('sandbox', 'allow-same-origin');
  await expect(frame.getByLabel('Name')).toBeVisible();
  await expect(frame.getByLabel('Name')).toBeDisabled();
  await expect(frame.getByRole('button', { name: 'Submit' })).toBeDisabled();
  await expect(frame.locator('script,meta[http-equiv="refresh"]')).toHaveCount(0);
  expect(external).toBe(0);
  await dialog.getByRole('tab', { name: 'Source', exact: true }).click();
  await expect(dialog.locator('.file-source')).toContainText('<h1>HTML example</h1>');
  await expect(dialog.locator('iframe')).toHaveCount(0);
});
test('code has highlighted tokens, line numbers and contained long lines', async ({ page }) => {
  const source = 'const ready = true;\n// comment\nconst long = "' + 'x'.repeat(3000) + '";';
  const dialog = await setup(page, 'app.ts', source);
  await expect(dialog.locator('.syntax-keyword').first()).toHaveText('const');
  await expect(dialog.locator('.source-line')).toHaveCount(3);
  await expect(dialog.locator('.line-number').last()).toHaveText('3');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(dialog.getByRole('button', { name: 'Attach file', exact: true })).toBeInViewport();
});
