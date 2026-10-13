import { mockSession } from './session-fixture.js';
import { expect, test } from '@playwright/test';
for (const state of ['sent', 'queued', 'failed', 'unconfirmed', 'blocked']) {
  test(`Direct review delivery for ${state}`, async ({ page }) => {
    const target = { agent: 'codex', sessionRef: 's', projectId: 'p' };
    const draft = { id: 'd', revision: 1, target, sourceRevision: 1, language: 'he', localizedText: 'Reviewed draft', englishText: 'Reviewed English instruction' };
    let snapshot: Record<string, unknown> = { id: 'c', target, codingState: state === 'blocked' ? 'working' : 'idle', codingMessages: [], discussion: [], currentDraft: draft, deliveries: [], language: 'he', languageSessionId: 'l', languageModel: 'm', sourceRevision: 1 };
    let sequence = 1;
  await mockSession(page, () => snapshot);
    await page.route('**/api/sessions/*/events', route => route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ sessionId: snapshot.id, sequence, snapshot }) + '\n\n' }));
    await page.route('**/api/sessions/*/actions', async route => {
      expect(route.request().postDataJSON().type).toBe('send-review');
      snapshot = { ...snapshot, deliveries: [{ id: 'receipt', draftId: 'd', revision: 1, target, englishText: draft.englishText, state }] };
      if (state === 'sent') delete snapshot.currentDraft;
      await route.fulfill({ json: { sessionId: snapshot.id, sequence: ++sequence, snapshot } });
    });
    await page.goto('/#capability=test');
    const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
    await input.fill('Input associated with this draft');
    await page.getByRole('button', { name: 'Resume review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review instruction', exact: true });
    const send = page.getByTestId('coding-delivery');
    if (state === 'blocked') await expect(send).toBeDisabled(); else await send.click();
    if (state === 'sent') {
      await expect(dialog).toHaveCount(0);
      await expect(input).toHaveValue('');
    } else {
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Reviewed draft');
      await expect(dialog).not.toContainText('Reviewed English instruction');
      await expect(input).toHaveValue('Input associated with this draft');
    }
  });
}
