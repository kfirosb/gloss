import { mockSession } from './session-fixture.js';
import { expect, test } from '@playwright/test';
test('release preserves edited text and history across reload without resending', async ({
  page,
}) => {
  const target = { agent: 'claude', sessionRef: 's', projectId: 'p' };
  const snapshot: any = {
    id: 'recovery',
    target,
    codingState: 'idle',
    codingMessages: [],
    discussion: [],
    deliveries: [],
    language: 'he',
    languageSessionId: 'l',
    languageModel: 'm',
    sourceRevision: 1,
  };
  const calls: any[] = [];
  let sequence = 1;
  await mockSession(page, () => snapshot);
  await page.route('**/api/sessions/*/claude-channel', (route) =>
    route.fulfill({ json: { state: 'connected' } }),
  );
  await page.route('**/api/sessions/*/actions', async (route) => {
    const a = route.request().postDataJSON();
    calls.push(a);
    if (a.type === 'send-composer') {
      snapshot.composerDraft = { id: `composer-${a.requestId}` };
      snapshot.deliveries.push({
        id: 'receipt',
        draftId: snapshot.composerDraft.id,
        revision: 1,
        target,
        englishText: 'English',
        state: 'unconfirmed',
      });
    }
    if (a.type === 'release-composer') delete snapshot.composerDraft;
    await route.fulfill({ json: { sessionId: snapshot.id, sequence: ++sequence, snapshot } });
  });
  await page.goto('/#capability=test');
  const composer = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await composer.fill('Original');
  await page.getByRole('button', { name: 'Send to Terminal in English', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Release composer', exact: true })).toBeVisible();
  await composer.fill('Preserve edited draft');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Release composer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Release composer', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(composer).toHaveValue('Preserve edited draft');
  expect(snapshot.deliveries).toHaveLength(1);
  expect(snapshot.deliveries[0].state).toBe('unconfirmed');
  expect(calls.filter((a) => a.type === 'send-composer')).toHaveLength(1);
});
for (const [width, height] of [
  [1280, 800],
  [390, 600],
  [900, 450],
]) {
  test(`composer translation and selection management at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width: width!, height: height! });
    const target = { agent: 'codex', sessionRef: 's', projectId: 'p' };
    const draft = {
      id: 'existing',
      revision: 1,
      target,
      sourceRevision: 1,
      language: 'he',
      localizedText: 'Existing prepared review',
      englishText: 'Hidden English',
      selectedDiscussion: [0],
    };
    let snapshot: any = {
      id: 'tools',
      target,
      codingState: 'idle',
      codingMessages: [],
      discussion: [
        { role: 'user', text: 'First selected message' },
        { role: 'assistant', text: 'Second selected message' },
        { role: 'user', text: 'Latest message' },
      ],
      currentDraft: draft,
      deliveries: [],
      language: 'he',
      languageSessionId: 'l',
      languageModel: 'm',
      sourceRevision: 1,
    };
    const calls: any[] = [];
    let outcome = 'queued';
    let sequence = 1;
    await mockSession(page, () => snapshot);
    await page.route('**/api/sessions/*/events', (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        body: 'data: ' + JSON.stringify({ sessionId: snapshot.id, sequence, snapshot }) + '\n\n',
      }),
    );
    await page.route('**/api/sessions/*/actions', async (route) => {
      const action = route.request().postDataJSON();
      calls.push(action);
      expect(['send-composer', 'check-composer']).toContain(action.type);
      snapshot = {
        ...snapshot,
        deliveries: [
          {
            id: 'receipt',
            draftId: `composer-${action.requestId}`,
            revision: 1,
            target,
            englishText: 'Only current text',
            state: outcome,
          },
        ],
      };
      await route.fulfill({ json: { sessionId: snapshot.id, sequence: ++sequence, snapshot } });
    });
    await page.goto('/#capability=test');
    await page.getByRole('button', { name: 'History Language Assistant', exact: true }).click();
    for (const i of [1, 0])
      await page.locator(`[data-discussion-index="${i}"] .select-answer`).click();
    await page.getByRole('button', { name: '2 selected', exact: true }).click();
    const selected = page.getByRole('dialog', { name: 'Selected messages', exact: true });
    expect(
      await selected
        .locator('[data-selected-index]')
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-selected-index'))),
    ).toEqual(['0', '1']);
    await selected.getByRole('button', { name: 'Deselect message 1' }).click();
    await expect(
      page.getByRole('button', { name: '1 selected', exact: true, includeHidden: true }),
    ).toHaveCount(1);
    await selected.getByRole('button', { name: 'Clear all selected' }).click();
    await expect(selected).toContainText('No messages selected.');
    await selected.getByRole('button', { name: 'Close Selected messages' }).click();
    await expect(page.getByRole('button', { name: '0 selected', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Resume review' }).click();
    const review = page.getByRole('dialog', { name: 'Review instruction', exact: true });
    await expect(review).toContainText('Existing prepared review');
    await review.getByRole('button', { name: 'Close review' }).click();
    const composer = page.getByRole('textbox', { name: 'Discuss with language assistant' });
    await composer.fill('Only composer text');
    const send = page.getByRole('button', { name: 'Send to Terminal in English', exact: true });
    expect(
      await send.evaluate((e) => {
        const r = e.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
      }),
    ).toBe(true);
    await send.click();
    await expect(composer).toHaveValue('Only composer text');
    expect(calls[0]).toMatchObject({ type: 'send-composer', text: 'Only composer text' });
    await expect(page.getByRole('dialog', { name: 'English translation' })).toHaveCount(0);
    await expect(send).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Check composer delivery' })).toHaveCount(0);
    await expect(page.locator('.composer-actions')).not.toContainText(/Ready|Queued/);
    await page.reload();
    await expect(composer).toHaveValue('Only composer text');
    outcome = 'sent';
    await expect(composer).toHaveValue('', { timeout: 7000 });
    expect(calls.filter((c) => c.type === 'send-composer')).toHaveLength(1);
    expect(
      calls.some((c) => c.type === 'check-composer' && c.requestId === calls[0].requestId),
    ).toBe(true);
    await page.getByRole('button', { name: 'Resume review' }).click();
    await expect(review).toContainText('Existing prepared review');
  });
}
for (const state of ['failed', 'unconfirmed', 'blocked']) {
  test(`composer text and selections survive ${state}`, async ({ page }) => {
    let calls = 0;
    const target = { agent: 'codex', sessionRef: 's', projectId: 'p' };
    const snapshot: any = {
      id: 'preserve',
      target,
      codingState: state === 'blocked' ? 'working' : 'idle',
      codingMessages: [],
      discussion: [{ role: 'user', text: 'Keep selected' }],
      deliveries: [],
      language: 'he',
      languageSessionId: 'l',
      languageModel: 'm',
      sourceRevision: 1,
    };
    await mockSession(page, () => snapshot);
    await page.route('**/api/sessions/*/events', (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        body: 'data: ' + JSON.stringify({ sessionId: snapshot.id, sequence: 1, snapshot }) + '\n\n',
      }),
    );
    await page.route('**/api/sessions/*/actions', async (route) => {
      const a = route.request().postDataJSON();
      calls++;
      snapshot.deliveries = [
        {
          id: 'receipt',
          draftId: `composer-${a.requestId}`,
          revision: 1,
          target,
          englishText: 'English',
          state,
        },
      ];
      await route.fulfill({ json: { sessionId: snapshot.id, sequence: 2, snapshot } });
    });
    await page.goto('/#capability=test');
    await page.getByRole('button', { name: 'Add to answer', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Discuss with language assistant' });
    await composer.fill('Preserve this text');
    const send = page.getByRole('button', { name: 'Send to Terminal in English', exact: true });
    if (state === 'blocked') await expect(send).toBeDisabled();
    else await send.click();
    await expect(composer).toHaveValue('Preserve this text');
    await expect(page.getByRole('button', { name: '1 selected', exact: true })).toBeVisible();
    expect(calls).toBe(state === 'blocked' ? 0 : 1);
  });
}
