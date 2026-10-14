import { expect, test } from '@playwright/test';
import { mockSession } from './session-fixture.js';

const target = { agent: 'codex', sessionRef: 's', projectId: 'p' };
const base = () => ({ id: 'panels', target, codingState: 'working', codingMessages: [] as any[], discussion: [] as any[], deliveries: [], language: 'he', languageSessionId: 'l', languageModel: 'm', sourceRevision: 1 });

for (const scenario of [
  { name: 'arriving', messages: [{ sourceId: 'm1', revision: 1, role: 'assistant', text: 'partial', complete: false }], text: 'Response arriving…', live: 'arriving' },
  { name: 'translating', messages: [{ sourceId: 'm1', revision: 1, role: 'assistant', text: 'done', complete: true, translationStatus: 'pending' }], text: 'Translating…', live: 'translating' },
]) test(`Live Conversation glows and labels while ${scenario.name}`, async ({ page }) => {
  const snapshot = { ...base(), codingMessages: scenario.messages };
  await mockSession(page, () => snapshot);
  await page.route('**/api/sessions/*/events', route => route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ sessionId: snapshot.id, sequence: 1, snapshot }) + '\n\n' }));
  await page.goto('/#capability=test');
  const pane = page.locator('.pane-live');
  await expect(pane).toHaveAttribute('data-live', scenario.live);
  await expect(pane).toHaveClass(/attn-ring/);
  await expect(pane.locator(':scope > .pane-toolbar .live-state')).toHaveText(scenario.text);
  await page.getByRole('button', { name: 'Expand Live Conversation', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Live Conversation expanded' }).locator('.live-state')).toHaveText(scenario.text);
  await page.keyboard.press('Escape');
});

test('a completed translated response shows no ring, and an incomplete discussion reply rings the Language Assistant', async ({ page }) => {
  const snapshot = { ...base(), codingState: 'idle', codingMessages: [{ sourceId: 'm1', revision: 1, role: 'assistant', text: 'done', complete: true, translatedText: 'סיום', translationStatus: 'complete' }], discussion: [{ role: 'assistant', text: '', complete: false }] };
  await mockSession(page, () => snapshot);
  await page.route('**/api/sessions/*/events', route => route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ sessionId: snapshot.id, sequence: 1, snapshot }) + '\n\n' }));
  await page.goto('/#capability=test');
  await expect(page.locator('.pane-live')).not.toHaveAttribute('data-live', /.+/);
  await expect(page.locator('.pane-live .live-state')).toHaveCount(0);
  await expect(page.locator('.pane-assistant')).toHaveAttribute('data-live', 'arriving');
  await expect(page.locator('.pane-assistant > .pane-toolbar .live-state')).toHaveText('Response arriving…');
});
