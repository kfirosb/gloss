import { test, expect } from '@playwright/test';
import { mockSession, basicSnapshot } from './session-fixture.js';

const inventory = { agent: 'codex', problems: [], entries: [
  { kind: 'mcp', name: 'playwright', scope: 'global', transport: 'stdio', target: 'npx' },
  { kind: 'skill', name: 'frontend-design', description: 'Build distinctive interfaces', scope: 'global' },
  { kind: 'skill', name: 'polish', description: 'Final design pass', scope: 'project' },
  { kind: 'skill', name: 'superpowers:brainstorming', description: 'Explore ideas', scope: 'plugin', plugin: 'superpowers' },
] };

for (const [width, height] of [[1280, 800], [390, 700]]) test(`skills and MCP picker at ${width}x${height}`, async ({ page }) => {
  await page.setViewportSize({ width: width!, height: height! });
  const snapshot = basicSnapshot(); await mockSession(page, () => snapshot);
  await page.route('**/api/sessions/*/events', r => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  let requests = 0;
  await page.route('**/api/sessions/*/inventory', r => { requests++; return r.fulfill({ json: inventory }); });
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

  await input.pressSequentially('$pl');
  const servers = page.getByRole('listbox', { name: 'MCP servers' });
  await expect(servers.getByRole('option')).toHaveCount(1);
  await expect(servers).toContainText('local command · npx');
  await input.press('Tab');
  await expect(input).toHaveValue('תבנה ‎/frontend-design ‎$playwright ');

  await input.fill('/zzz'); await expect(page.getByRole('status').filter({ hasText: 'No matching skills' })).toBeVisible();
  await input.press('Escape'); await expect(page.getByRole('listbox', { name: 'Skills' })).toHaveCount(0);
  for (const text of ['costs $5', 'a/b', '/front ']) { await input.fill(text); await expect(page.locator('.inventory-picker')).toHaveCount(0); }
  expect(requests).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
