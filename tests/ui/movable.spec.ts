import { mockSession, basicSnapshot } from './session-fixture.js';
import { expect, test } from '@playwright/test';
for (const [width, height] of [
  [1280, 800],
  [390, 700],
  [900, 450],
]) {
  test(`move all panels and preserve writing at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width: width!, height: height! });
    await mockSession(page, basicSnapshot);
    await page.goto('/#capability=test');
    const composer = page.getByRole('textbox', { name: 'Discuss with language assistant' });
    await composer.fill('Keep my draft while arranging panels');
    const source = page.getByRole('button', { name: 'Move Language Assistant', exact: true });
    const sourceBox = (await source.boundingBox())!;
    const targetBox = (await page.locator('[data-panel-id="live"]').boundingBox())!;
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
    await expect(page.locator('[data-panel-id="assistant"]')).toHaveAttribute('data-slot', '0');
    await expect(page.locator('[data-panel-id="live"]')).toHaveAttribute('data-slot', '1');
    await page
      .getByRole('button', { name: 'Move Chat with the Language Assistant', exact: true })
      .click();
    await page.getByRole('button', { name: 'Swap with Language Assistant', exact: true }).click();
    await expect(page.locator('[data-panel-id="composer"]')).toHaveAttribute('data-slot', '0');
    await expect(composer).toHaveValue('Keep my draft while arranging panels');
    for (const layout of ['columns', 'rows', 'split']) {
      await page.getByRole('combobox', { name: 'Panel layout' }).selectOption(layout);
      await expect(composer).toHaveValue('Keep my draft while arranging panels');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await page
      .getByRole('button', { name: 'Expand Chat with the Language Assistant', exact: true })
      .click();
    const expanded = page.getByRole('dialog', {
      name: 'Chat with the Language Assistant expanded',
      exact: true,
    });
    await expect(expanded).toBeVisible();
    await expect(expanded.getByRole('textbox')).toHaveValue('Keep my draft while arranging panels');
    expect((await expanded.boundingBox())!.height).toBeGreaterThan(height! - 60);
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.locator('[data-panel-id="composer"]')).toHaveAttribute('data-slot', '0');
    await expect(composer).toHaveValue('Keep my draft while arranging panels');
    await page.getByRole('button', { name: 'Reset layout', exact: true }).click();
    await expect(page.locator('[data-panel-id="composer"]')).toHaveAttribute('data-slot', '2');
    await expect(composer).toHaveValue('Keep my draft while arranging panels');
  });
}
for (const [width, height] of [
  [1280, 800],
  [390, 700],
  [900, 450],
]) {
  test(`chat spans bottom at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width: width!, height: height! });
    await mockSession(page, basicSnapshot);
    await page.goto('/#capability=test');
    const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
    await input.fill('Keep full-width draft');
    await page
      .getByRole('button', { name: 'Move Chat with the Language Assistant', exact: true })
      .click();
    await page.getByRole('button', { name: 'Swap with Live Conversation', exact: true }).click();
    await page.getByRole('combobox', { name: 'Panel layout' }).selectOption('bottom');
    await expect(page.locator('[data-panel-id="composer"]')).toHaveAttribute('data-slot', '2');
    const boxes = await page.evaluate(() => {
      const work = document.querySelector('.workspace')!.getBoundingClientRect();
      const chat = document.querySelector('[data-panel-id="composer"]')!.getBoundingClientRect();
      const live = document.querySelector('[data-panel-id="live"]')!.getBoundingClientRect();
      const assistant = document
        .querySelector('[data-panel-id="assistant"]')!
        .getBoundingClientRect();
      return {
        fullWidth: Math.abs(chat.width - work.width) < 2,
        below: chat.top >= Math.max(live.bottom, assistant.bottom),
        visible: chat.bottom <= innerHeight,
      };
    });
    expect(boxes).toEqual({ fullWidth: true, below: true, visible: true });
    const divider = page.getByRole('separator', { name: 'Resize Language Assistant' });
    await divider.focus();
    await divider.press('ArrowUp');
    await expect(input).toHaveValue('Keep full-width draft');
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Panel layout' })).toHaveValue('bottom');
    await expect(input).toHaveValue('Keep full-width draft');
  });
}
