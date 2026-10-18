import { mockSession } from './session-fixture.js';
import { expect, test } from '@playwright/test';
import type { ConversationSnapshot } from '../../src/core/contracts.js';
test('reset preserves composer and selections, survives failure, and allows a fresh preparation', async ({
  page,
}) => {
  const target = { agent: 'codex', sessionRef: 's', projectId: 'p' };
  let sequence = 1;
  let fail = true;
  let snapshot: any = {
    id: 'reset-test',
    target,
    codingState: 'idle',
    codingMessages: [],
    discussion: [{ role: 'user', text: 'Selected request' }],
    currentDraft: {
      id: 'old',
      revision: 1,
      target,
      sourceRevision: 1,
      language: 'he',
      localizedText: 'Old prepared answer',
      englishText: 'Old instruction',
      selectedDiscussion: [0],
    },
    deliveries: [
      {
        id: 'pending',
        draftId: 'old',
        revision: 1,
        target,
        englishText: 'Old instruction',
        state: 'queued',
      },
    ],
    language: 'he',
    languageSessionId: 'l',
    languageModel: 'm',
    sourceRevision: 1,
  };
  await mockSession(page, () => snapshot);
  await page.route('**/api/sessions/*/events', (r) =>
    r.fulfill({
      contentType: 'text/event-stream',
      body: 'data: ' + JSON.stringify({ sessionId: snapshot.id, sequence, snapshot }) + '\n\n',
    }),
  );
  await page.route('**/api/sessions/*/actions', async (r) => {
    const a = r.request().postDataJSON();
    if (a.type === 'reset-instruction') {
      if (fail) {
        await r.fulfill({ status: 503, json: { error: 'Temporary reset failure' } });
        return;
      }
      delete snapshot.currentDraft;
    } else {
      expect(a.type).toBe('prepare');
      expect(a.indices).toEqual([0]);
      expect(a.expected).toBeUndefined();
      snapshot = {
        ...snapshot,
        currentDraft: {
          id: 'fresh',
          revision: 1,
          target,
          sourceRevision: 1,
          language: 'he',
          localizedText: 'Fresh prepared answer',
          englishText: 'Fresh instruction',
          selectedDiscussion: [0],
        },
      };
    }
    await r.fulfill({
      json: {
        sessionId: snapshot.id,
        sequence: ++sequence,
        snapshot,
        review: snapshot.currentDraft,
      },
    });
  });
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'Add to answer', exact: true }).click();
  const composer = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await composer.fill('Preserve composer');
  await page.getByRole('button', { name: 'Resume review', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review instruction', exact: true });
  await review.getByRole('button', { name: 'Reset instruction', exact: true }).click();
  const reset = page.getByRole('dialog', { name: 'Reset prepared instruction', exact: true });
  await expect(reset).toContainText('does not cancel');
  await reset.getByRole('button', { name: 'Keep instruction' }).click();
  await expect(review).toContainText('Old prepared answer');
  await review.getByRole('button', { name: 'Reset instruction', exact: true }).click();
  await reset.getByRole('button', { name: 'Confirm reset' }).click();
  await expect(reset.getByRole('alert')).toHaveText('Temporary reset failure');
  fail = false;
  await reset.getByRole('button', { name: 'Confirm reset' }).click();
  await expect(review).toHaveCount(0);
  await expect(reset).not.toBeVisible();
  await expect(composer).toHaveValue('Preserve composer');
  await expect(page.getByRole('button', { name: '1 selected', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Resume review', exact: true })).toHaveCount(0);
  await expect(composer).toHaveValue('Preserve composer');
  await page.getByRole('button', { name: 'Prepare instruction', exact: true }).click();
  await expect(review).toContainText('Fresh prepared answer');
  await expect(review).not.toContainText('Old prepared answer');
});
