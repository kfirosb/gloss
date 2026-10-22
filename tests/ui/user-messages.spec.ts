import { expect, test, type Page } from '@playwright/test';
import { basicSnapshot, mockSession } from './session-fixture.js';

const target = { agent: 'claude', sessionRef: 'basic', projectId: '/project' };
const settings = { write: 'he', send: 'en', reply: 'he', assist: 'he' };
const user = (sourceId: string, text: string, extra: Record<string, unknown> = {}) => ({
  sourceId,
  revision: Number(sourceId.replace(/\D/g, '')),
  role: 'user',
  text,
  complete: true,
  ...extra,
});
const snapshot = {
  ...basicSnapshot(),
  target,
  languageSettings: settings,
  codingMessages: [
    // Sent from Gloss's composer and confirmed by its transcript record.
    user('u1', 'Fix the failing test'),
    // Typed in the terminal: nothing to match.
    user('u2', 'Run the build'),
    // Saved while a translation was pending, before user messages stopped being translated.
    user('u3', 'Check the logs', { translationStatus: 'pending' }),
    {
      sourceId: 'a4',
      revision: 4,
      role: 'assistant',
      text: 'Done',
      translatedText: 'בוצע',
      translationStatus: 'complete',
      translationLanguage: 'he',
      complete: true,
    },
  ],
  deliveries: [
    {
      id: 'delivery-1',
      draftId: 'composer-request-1',
      revision: 1,
      target,
      englishText: 'Fix the failing test',
      state: 'sent',
      transport: 'tmux',
      nativeMessageId: 'transcript:u1',
      written: { language: 'he', text: 'תקן את הבדיקה שנכשלת' },
    },
  ],
};

async function openHistory(page: Page) {
  await mockSession(page, () => snapshot);
  await page.route('**/events', (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: '' }),
  );
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'History Live Conversation', exact: true }).click();
  await expect(page.locator('.feed [data-source-id]')).toHaveCount(4);
}
const message = (page: Page, id: string) => page.locator(`.feed article[data-source-id="${id}"]`);

test('a matched user message shows what the user wrote, with the sent English beside it', async ({
  page,
}) => {
  await openHistory(page);
  const own = message(page, 'u1');
  await expect(own).toHaveAttribute('data-translation-status', 'written');
  await expect(own.locator('small').first()).toHaveText('You · as you wrote it');
  const text = own.locator('.rich-text').first();
  await expect(text).toHaveText('תקן את הבדיקה שנכשלת');
  await expect(text).toHaveAttribute('dir', 'rtl');
  await expect(text).toHaveAttribute('lang', 'he');
  await own.locator('details summary', { hasText: 'Sent to the agent' }).click();
  await expect(own.locator('details pre')).toHaveText('Fix the failing test');
  await expect(own.getByRole('button', { name: 'Translate' })).toHaveCount(0);

  await page
    .getByRole('radiogroup', { name: 'Live Conversation view' })
    .getByRole('radio', { name: 'Original' })
    .click();
  await expect(own).toHaveAttribute('data-translation-status', 'original');
  await expect(own.locator('.rich-text').first()).toHaveText('Fix the failing test');
  await expect(own.locator('details')).toHaveCount(0);
});

test('unmatched user messages show as written to the agent, never as a translation', async ({
  page,
}) => {
  await openHistory(page);
  for (const [id, text] of [
    ['u2', 'Run the build'],
    ['u3', 'Check the logs'],
  ] as const) {
    const plain = message(page, id);
    await expect(plain).toHaveAttribute('data-translation-status', 'none');
    await expect(plain.locator('small').first()).toHaveText('Coding agent · original user message');
    await expect(plain.locator('.rich-text').first()).toHaveText(text);
    await expect(plain).not.toContainText('Translating…');
    await expect(plain.locator('details')).toHaveCount(0);
    await expect(plain.getByRole('button', { name: 'Translate' })).toHaveCount(0);
  }
  await expect(message(page, 'a4').locator('.rich-text').first()).toHaveText('בוצע');
});
