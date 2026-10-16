import { mockSession } from './session-fixture.js';
import { expect, test } from '@playwright/test';
test('direct Hebrew review, replacement confirmation, close and refresh, delayed Sent cleanup', async ({
  page,
}) => {
  const target = { agent: 'codex', sessionRef: 's', projectId: 'p' };
  let sequence = 1,
    serial = 0;
  let snapshot: any = {
    id: 'direct',
    target,
    codingState: 'idle',
    codingMessages: [],
    discussion: [
      { role: 'user', text: 'First request' },
      { role: 'assistant', text: 'Second request' },
    ],
    deliveries: [],
    language: 'he',
    languageSessionId: 'l',
    languageModel: 'm',
    sourceRevision: 1,
  };
  const selections: number[][] = [];
  await mockSession(page, () => snapshot);
  await page.route('**/api/sessions/*/events', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: 'data: ' + JSON.stringify({ sessionId: snapshot.id, sequence, snapshot }) + '\n\n',
    }),
  );
  await page.route('**/api/sessions/*/actions', async (route) => {
    const action = route.request().postDataJSON();
    if (action.type === 'prepare') {
      selections.push(action.indices);
      if (snapshot.currentDraft)
        expect(action.expected).toEqual({
          id: snapshot.currentDraft.id,
          revision: snapshot.currentDraft.revision,
        });
      snapshot = {
        ...snapshot,
        currentDraft: {
          id: `r${++serial}`,
          revision: 1,
          target,
          sourceRevision: 1,
          language: 'he',
          localizedText: '# \u05d1\u05e7\u05e9\u05d4\n\n- \u05e4\u05e8\u05d8\u05d9\u05dd',
          englishText: 'Hidden concise instruction',
          selectedDiscussion: action.indices,
        },
      };
      await route.fulfill({
        json: {
          sessionId: snapshot.id,
          sequence: ++sequence,
          snapshot,
          review: snapshot.currentDraft,
        },
      });
      return;
    }
    expect(action.type).toBe('send-review');
    expect(action.localizedText).toContain('Edited');
    snapshot = {
      ...snapshot,
      currentDraft: { ...snapshot.currentDraft, localizedText: action.localizedText },
      deliveries: [
        {
          id: 'receipt',
          draftId: snapshot.currentDraft.id,
          revision: 1,
          target,
          state: 'queued',
          englishText: 'Hidden concise instruction',
        },
      ],
    };
    await route.fulfill({ json: { sessionId: snapshot.id, sequence: ++sequence, snapshot } });
  });
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'History Language Assistant', exact: true }).click();
  for (const i of [1, 0])
    await page.locator(`[data-discussion-index="${i}"] .select-answer`).click();
  await page.getByRole('button', { name: 'Prepare instruction', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review instruction', exact: true });
  await expect(dialog).toBeVisible();
  expect(selections).toEqual([[0, 1]]);
  await expect(page.locator('.pane-queue')).toHaveCount(0);
  await expect(dialog).not.toContainText('Hidden concise instruction');
  await expect(page.getByRole('button', { name: /Approve and|Discard draft/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Edit instruction', exact: true }).click();
  await dialog.getByRole('textbox').fill('Edited Hebrew review');
  await dialog.getByRole('button', { name: 'Close review' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Resume review' }).click();
  await expect(dialog).toContainText('Edited Hebrew review');
  await dialog.getByRole('button', { name: 'Close review' }).click();
  await page.getByRole('button', { name: 'Prepare instruction', exact: true }).click();
  const replacement = page.getByRole('dialog', {
    name: 'An instruction is already prepared',
    exact: true,
  });
  await expect(replacement).toContainText('First request');
  await expect(replacement).toContainText('Second request');
  await expect(replacement).not.toContainText('Edited Hebrew review');
  await replacement.getByRole('button', { name: 'Keep existing instruction' }).click();
  await expect(dialog).toContainText('Edited Hebrew review');
  await dialog.getByRole('button', { name: 'Close review' }).click();
  expect(selections).toHaveLength(1);
  await page.getByRole('button', { name: 'Prepare instruction', exact: true }).click();
  await replacement.getByRole('button', { name: 'Replace instruction', exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(selections).toHaveLength(2);
  await dialog.getByRole('button', { name: 'Edit instruction', exact: true }).click();
  await dialog.getByRole('textbox').fill('Edited final review');
  await dialog.getByTestId('coding-delivery').click();
  await expect(dialog.getByRole('status')).toContainText('Queued');
  await expect(dialog.getByRole('textbox')).toHaveValue('Edited final review');
  await expect(dialog.getByTestId('coding-delivery')).toBeDisabled();
  snapshot = {
    ...snapshot,
    deliveries: snapshot.deliveries.map((d: any) => ({ ...d, state: 'sent' })),
  };
  delete snapshot.currentDraft;
  sequence++;
  await expect(dialog).toHaveCount(0, { timeout: 5000 });
  await expect(page.getByRole('button', { name: 'Resume review' })).toHaveCount(0);
  await expect(page.locator('.selected-message')).toHaveCount(0);
});
test('Prepare replacement shows current selections and displays the newly generated answer after refresh', async ({
  page,
}) => {
  const target = { agent: 'codex', sessionRef: 's', projectId: 'p' };
  let sequence = 1;
  let snapshot: any = {
    id: 'replace-current',
    target,
    codingState: 'idle',
    codingMessages: [],
    discussion: [
      { role: 'user', text: 'Old requirement' },
      { role: 'user', text: 'New requirement only' },
    ],
    currentDraft: {
      id: 'old',
      revision: 1,
      target,
      sourceRevision: 1,
      language: 'he',
      localizedText: 'Old prepared answer',
      englishText: 'Old agent instruction',
      selectedDiscussion: [0],
    },
    deliveries: [],
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
    expect(a.type).toBe('prepare');
    expect(a.indices).toEqual([1]);
    snapshot = {
      ...snapshot,
      currentDraft: {
        ...snapshot.currentDraft,
        id: 'new',
        localizedText: 'Fresh answer for the new requirement',
        englishText: 'New requirement only',
        selectedDiscussion: [1],
      },
    };
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
  await page.getByRole('button', { name: 'Prepare instruction', exact: true }).click();
  const replacement = page.getByRole('dialog', {
    name: 'An instruction is already prepared',
    exact: true,
  });
  await expect(replacement).toContainText('New requirement only');
  await expect(replacement).not.toContainText('Old prepared answer');
  await replacement.getByRole('button', { name: 'Replace instruction', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review instruction', exact: true });
  await expect(review).toContainText('Fresh answer for the new requirement');
  await expect(review).not.toContainText('Old prepared answer');
  await page.reload();
  await page.getByRole('button', { name: 'Resume review', exact: true }).click();
  await expect(review).toContainText('Fresh answer for the new requirement');
});
