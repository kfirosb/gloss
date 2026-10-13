import { expect, test } from '@playwright/test';
import { basicSnapshot, mockSession } from './session-fixture.js';

for (const shortcut of ['Alt+Enter', 'Shift+Enter']) {
  test(`${shortcut} inserts a line without sending`, async ({ page }) => {
    await mockSession(page, basicSnapshot);
    const actions: any[] = [];
    await page.route('**/api/sessions/*/actions', route => { actions.push(route.request().postDataJSON()); return route.fulfill({ json: { sessionId: 'basic', sequence: 1, snapshot: basicSnapshot() } }); });
    await page.goto('/#capability=test');
    const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
    await input.fill('First');
    await input.press(shortcut);
    await input.press('x');
    await expect(input).toHaveValue('First\nx');
    expect(actions).toEqual([]);
  });
}

test('Enter delivers to the agent and Discuss first opens discussion', async ({ page }) => {
  await mockSession(page, basicSnapshot);
  const actions: any[] = [];
  await page.route('**/api/sessions/*/actions', route => { actions.push(route.request().postDataJSON()); return route.fulfill({ json: { sessionId: 'basic', sequence: actions.length, snapshot: basicSnapshot() } }); });
  await page.goto('/#capability=test');
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  const attach = await page.getByRole('button', { name: 'Attach files', exact: true }).boundingBox();
  const discuss = await page.getByRole('button', { name: 'Discuss first', exact: true }).boundingBox();
  expect(attach).not.toBeNull();
  expect(discuss).not.toBeNull();
  expect(Math.abs(attach!.y - discuss!.y)).toBeLessThan(2);
  await page.locator('.composer').screenshot({ path: '/tmp/composer-controls.png' });
  await input.fill('Send this');
  await input.press('Enter');
  await expect.poll(() => actions[0]?.type).toBe('send-composer');
  expect(actions[0].text).toBe('Send this');
  await input.fill('Discuss this');
  await page.getByRole('button', { name: 'Discuss first', exact: true }).click();
  await expect.poll(() => actions[1]?.type).toBe('discuss');
  expect(actions[1].text).toBe('Discuss this');
});

test('Enter respects the busy agent guard', async ({ page }) => {
  await mockSession(page, () => ({ ...basicSnapshot(), codingState: 'working' }));
  const actions: any[] = [];
  await page.route('**/api/sessions/*/actions', route => { actions.push(route.request().postDataJSON()); return route.fulfill({ json: {} }); });
  await page.goto('/#capability=test');
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.fill('Keep this');
  await input.press('Enter');
  await expect(input).toHaveValue('Keep this');
  expect(actions).toEqual([]);
});
