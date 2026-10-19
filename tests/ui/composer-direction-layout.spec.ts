import { test, expect, type Page } from '@playwright/test';
import { defaultWorkspace } from '../../src/core/session-contracts.js';
import { mockSession, basicSnapshot } from './session-fixture.js';
const LRM = '‎';
async function seed(
  page: Page,
  data: Partial<ReturnType<typeof defaultWorkspace>>,
  snapshot = basicSnapshot(),
) {
  await mockSession(page, () => snapshot);
  await page.route('**/api/sessions/*/events', (r) =>
    r.fulfill({ contentType: 'text/event-stream', body: '' }),
  );
  const saved = { sessionId: snapshot.id, revision: 1, data: { ...defaultWorkspace(), ...data } };
  await page.route('**/api/sessions/*/workspace', (r) => {
    if (r.request().method() === 'PUT') {
      saved.revision++;
      saved.data = r.request().postDataJSON().data;
    }
    return r.fulfill({ json: saved });
  });
  await page.route('**/api/sessions/*/files/*/metadata', (r) =>
    r.fulfill({
      json: {
        id: 'file-1',
        name: 'reference.txt',
        mime: 'text/plain',
        size: 20,
        kind: 'file',
        index: 1,
        sessionId: snapshot.id,
        path: '/project/reference.txt',
        originalPath: '/project/reference.txt',
        worktreePath: '/project',
        source: 'worktree',
      },
    }),
  );
}
// English opening and closing characters reveal the paragraph direction.
const readsLeftToRight = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const text = element.firstChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 1);
      const first = range.getBoundingClientRect();
      const length = text.textContent!.length;
      range.setStart(text, length - 1);
      range.setEnd(text, length);
      const last = range.getBoundingClientRect();
      return last.left > first.left;
    });

for (const [width, height] of [
  [1280, 800],
  [1564, 784],
  [900, 450],
] as const)
  for (const mode of ['split', 'bottom'] as const)
    test(`composer file card and toolbar controls do not overlap and remain reachable at ${width}x${height} ${mode}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      const snapshot = {
        ...basicSnapshot(),
        capabilities: {
          history: true,
          liveMessages: true,
          attachExisting: true,
          imageAttachments: true,
          fileReferences: true,
          sendWhileBusy: true,
          acknowledgement: 'queued',
        },
      };
      await seed(
        page,
        {
          composer: `${LRM}@File 1 `,
          attachmentIds: ['file-1'],
          layout: { ...defaultWorkspace().layout, mode },
        },
        snapshot,
      );
      await page.goto('/#capability=test');
      const card = page.locator('.pane-composer .composer .attachment-card');
      await expect(card).toContainText('reference.txt');
      const controls = ['Attach files', 'Discuss first', 'Send to Terminal in English'];
      for (const name of controls) {
        const button = page.getByRole('button', { name, exact: true });
        await expect(button).toBeVisible();
        await expect(button).toBeEnabled();
        const [cardBox, buttonBox] = await Promise.all([card.boundingBox(), button.boundingBox()]);
        expect(cardBox).not.toBeNull();
        expect(buttonBox).not.toBeNull();
        // The toolbar wraps beside or above cards; its display:contents wrapper has no box.
        expect(
          cardBox!.x + cardBox!.width <= buttonBox!.x ||
            buttonBox!.x + buttonBox!.width <= cardBox!.x ||
            cardBox!.y + cardBox!.height <= buttonBox!.y ||
            buttonBox!.y + buttonBox!.height <= cardBox!.y,
          `${name} must not overlap the attachment card`,
        ).toBe(true);
        await button.click({ trial: true });
        expect(
          await button.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return element.contains(
              document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
            );
          }),
          `${name} must have an unobstructed center hit target`,
        ).toBe(true);
      }
      await card.getByRole('button', { name: 'Remove File 1', exact: true }).click();
      await expect(card).toHaveCount(0);
    });

test('English notices and dialog copy read left-to-right inside the Hebrew app', async ({
  page,
}) => {
  const snapshot = {
    ...basicSnapshot(),
    codingState: 'disconnected',
    currentDraft: {
      id: 'd',
      revision: 1,
      target: basicSnapshot().target,
      sourceRevision: 0,
      language: 'he',
      localizedText: 'טיוטה',
      englishText: 'Draft',
    },
  };
  await seed(
    page,
    { review: { draftId: 'd', revision: 1, localizedText: 'טיוטה' } as never },
    snapshot as never,
  );
  await page.goto('/#capability=test');
  await expect(page.locator('main > .notice')).toHaveText(
    /^This saved session is unavailable\..*\.$/,
  );
  expect(await readsLeftToRight(page, 'main > .notice')).toBe(true);
  await page.getByRole('button', { name: 'Resume review', exact: true }).click();
  expect(await readsLeftToRight(page, '.instruction-review[open] .review-hint')).toBe(true);
  await page
    .getByRole('dialog', { name: 'Review instruction' })
    .getByRole('button', { name: 'Reset instruction', exact: true })
    .click();
  expect(
    await readsLeftToRight(
      page,
      'dialog[aria-label="Reset prepared instruction"] .review-body > p',
    ),
  ).toBe(true);
});

test('inserted references display left-to-right and Discuss first sends them without the direction mark', async ({
  page,
}) => {
  const snapshot = basicSnapshot();
  await seed(page, { composer: 'תסתכל על @ref' });
  await page.route('**/files/search?*', (r) =>
    r.fulfill({ json: [{ name: 'reference.txt', relativePath: 'reference.txt' }] }),
  );
  await page.route('**/files/preview?*', (r) =>
    r.fulfill({
      json: {
        name: 'reference.txt',
        relativePath: 'reference.txt',
        state: 'text',
        text: 'safe',
        size: 4,
      },
    }),
  );
  await page.route('**/files/reference', (r) =>
    r.fulfill({
      json: {
        id: 'file-1',
        name: 'reference.txt',
        mime: 'text/plain',
        size: 4,
        kind: 'file',
        index: 1,
        sessionId: snapshot.id,
        path: '/project/reference.txt',
        originalPath: '/project/reference.txt',
        worktreePath: '/project',
        source: 'worktree',
      },
    }),
  );
  const actions: { type: string; text?: string }[] = [];
  await page.route('**/api/sessions/*/actions', (r) => {
    actions.push(r.request().postDataJSON());
    return r.fulfill({ json: { sessionId: snapshot.id, sequence: 1, snapshot } });
  });
  await page.goto('/#capability=test');
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.click();
  await input.press('End');
  await page.getByRole('option', { name: /reference\.txt/ }).click();
  await page
    .getByRole('dialog', { name: 'File preview' })
    .getByRole('button', { name: 'Attach file', exact: true })
    .click();
  await expect(input).toHaveValue(`תסתכל על ${LRM}@File 1 `);
  await page
    .getByRole('dialog', { name: 'File preview' })
    .getByRole('button', { name: 'Close file preview', exact: true })
    .click();
  await page.getByRole('button', { name: 'Discuss first', exact: true }).click();
  await expect
    .poll(() => actions.find((action) => action.type === 'discuss')?.text)
    .toBe('תסתכל על @File 1 ');
});

test('panel move menu closes with Escape and an outside click', async ({ page }) => {
  await seed(page, {});
  await page.goto('/#capability=test');
  const handle = page.getByRole('button', { name: 'Move Live Conversation', exact: true });
  const menu = page.locator('.panel-move-menu');
  await handle.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(handle).toBeFocused();
  await handle.click();
  await expect(menu).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(menu).toHaveCount(0);
});
