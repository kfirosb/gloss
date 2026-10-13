import { mockSession } from './session-fixture.js';
import { expect, test } from '@playwright/test';
test('latest views and per-section history preserve order without duplicate entries', async ({ page }) => {
  const target = { agent: 'codex', sessionRef: 'visible-session', projectId: '/example/project' };
  const messages = Array.from({ length: 12 }, (_, i) => ({ sourceId: `m${i}`, revision: i, role: 'assistant', text: `Original ${i}`, translatedText: `Reply ${i}`, translationStatus: 'complete', complete: true }));
  const deliveries = [0, 1, 2].map(i => ({ id: `receipt${i}`, draftId: `draft${i}`, revision: 1, target, englishText: `Instruction ${i}`, state: i === 2 ? 'queued' : 'sent' }));
  const snapshot = { id: 'c', target, codingState: 'working', codingMessages: [...messages].reverse().concat(messages[3]!), discussion: [{ role: 'user', text: 'Earlier question' }, { role: 'assistant', text: 'Earlier reply' }, { role: 'assistant', text: 'Latest reply' }], currentDraft: { id: 'draft2', revision: 1, target, sourceRevision: 1, language: 'he', localizedText: 'Current instruction', englishText: 'Instruction 2' }, deliveries, language: 'he', languageSessionId: 'l', languageModel: 'm', sourceRevision: 1, sourceGaps: ['Live replay starts in a bounded tail; older messages are available through history.'] };
  await mockSession(page, () => snapshot);
  await page.route('**/api/sessions/*/events', route => route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ sessionId: snapshot.id, sequence: 1, snapshot }) + '\n\n' }));
  await page.goto('/#capability=test');
  await expect(page.locator('.feed [data-source-id]')).toHaveCount(1);
  await expect(page.locator('.feed [data-source-id]')).toHaveAttribute('data-source-id', 'm11');
  await expect(page.locator('.discussion .message')).toHaveCount(1);
  await expect(page.locator('.discussion .message')).toContainText('Latest reply');
  await expect(page.locator('.queue-history')).toHaveCount(0);
  await expect(page.getByRole('navigation',{name:'Sessions'})).toHaveCount(1);
  await expect(page.locator('.pane-queue')).toHaveCount(0);
  await expect(page.locator('.pane-queue strong')).toHaveCount(0);
  await expect(page.getByText('History gap:', { exact: false })).toHaveCount(0);
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'History Live Conversation', exact: true }).click();
    await expect(page.locator('.feed [data-source-id]')).toHaveCount(12);
    expect(await page.locator('.feed [data-source-id]').evaluateAll(es => es.map(e => e.getAttribute('data-source-id')))).toEqual(messages.map(m => m.sourceId));
    await page.getByRole('button', { name: 'History Live Conversation', exact: true }).click();
    await expect(page.locator('.feed [data-source-id]')).toHaveCount(1);
  }
  await page.getByRole('button', { name: 'History Language Assistant', exact: true }).click();
  await expect(page.locator('.discussion .message')).toHaveCount(3);
  expect(await page.locator('.discussion .rich-text').allTextContents()).toEqual(['Earlier question', 'Earlier reply', 'Latest reply']);
  await expect(page.getByRole('button', { name: 'History Queue', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('draft-card')).toHaveCount(0);
});
