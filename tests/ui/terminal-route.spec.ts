import { expect, test, type Page } from '@playwright/test';
import type { ConversationSnapshot, Delivery, DeliveryRoute } from '../../src/core/contracts.js';
import { recordOf, type JsonRecord } from '../../src/core/json-record.js';
import { mockSession } from './session-fixture.js';

const target = {
  agent: 'claude' as const,
  sessionRef: '11111111-1111-4111-8111-111111111111',
  projectId: '/project',
};
async function claudeSession(
  page: Page,
  route: DeliveryRoute,
  change: (snapshot: ConversationSnapshot) => void = () => {},
) {
  const snapshot: ConversationSnapshot = {
    id: 'basic',
    target,
    codingState: 'idle',
    codingMessages: [],
    discussion: [],
    deliveries: [],
    language: 'he',
    languageSessionId: '',
    languageModel: 'default',
    sourceRevision: 0,
    capabilities: {
      history: true,
      liveMessages: true,
      attachExisting: true,
      sendWhileBusy: false,
      channelSendWhileBusy: true,
      peerSendWhileBusy: true,
      tmuxSendWhileBusy: true,
      fileReferences: true,
      acknowledgement: 'accepted',
    },
  };
  change(snapshot);
  const actions: JsonRecord[] = [];
  let sequence = 0;
  await mockSession(page, () => snapshot);
  await page.route('**/api/sessions/*/events', (r) =>
    r.fulfill({ contentType: 'text/event-stream', body: '' }),
  );
  await page.route('**/api/sessions/*/claude-channel', (r) =>
    r.fulfill({ json: { state: 'setup-required' } }),
  );
  await page.route('**/api/sessions/*/claude-route', (r) => r.fulfill({ json: route }));
  await page.route('**/api/sessions/*/actions', (r) => {
    const action = recordOf(r.request().postDataJSON());
    if (action) actions.push(action);
    if (action?.type === 'send-composer' && typeof action.requestId === 'string') {
      const delivery: Delivery = {
        id: action.requestId,
        draftId: 'composer-' + action.requestId,
        revision: 1,
        target,
        englishText: 'Hello',
        state: 'held',
        reason: 'There is unsent text in the terminal',
        ...(route.transport ? { transport: route.transport } : {}),
      };
      snapshot.deliveries.push(delivery);
    }
    if (action?.type === 'release-composer')
      for (const delivery of snapshot.deliveries)
        if (delivery.state === 'held') {
          delivery.state = 'failed';
          delivery.reason = 'Not sent: released before Gloss typed it';
        }
    return r.fulfill({ json: { sessionId: snapshot.id, sequence: ++sequence, snapshot } });
  });
  await page.goto('/#capability=test');
  return { snapshot, actions };
}
const input = (page: Page) =>
  page.getByRole('textbox', { name: 'Discuss with language assistant' });
const send = (page: Page) =>
  page.getByRole('button', { name: 'Send to Terminal in English', exact: true });

test('a session Gloss opened sends through its terminal with one Send button', async ({ page }) => {
  const f = await claudeSession(page, { transport: 'tmux' });
  await expect(page.locator('.route-line > summary')).toHaveText('Terminal');
  await expect(page.locator('.claude-connection')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Send as peer/ })).toHaveCount(0);
  await input(page).fill('שלום');
  await send(page).click();
  await expect.poll(() => f.actions.some((a) => a.type === 'send-composer')).toBe(true);
  expect(f.actions.find((a) => a.type === 'send-composer')).not.toHaveProperty('transport');
  await page.locator('.route-line > summary').click();
  await expect(
    page.getByText('Gloss types your message into this session’s terminal'),
  ).toBeVisible();
});
test('a held message says why it waits, and Don’t send releases it without sending', async ({
  page,
}) => {
  const f = await claudeSession(page, { transport: 'tmux' });
  await input(page).fill('שלום');
  await send(page).click();
  await expect(page.locator('.status-strip')).toContainText(
    'Waiting for the terminal: There is unsent text in the terminal',
  );
  await expect(page.getByRole('button', { name: 'Check delivery' })).toHaveCount(0);
  // Send would only re-post the held message; Don’t send is the way out.
  await expect(send(page)).toBeDisabled();
  await input(page).press('Enter');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Don’t send', exact: true }).click();
  await expect.poll(() => f.actions.some((a) => a.type === 'release-composer')).toBe(true);
  await expect(input(page)).toHaveValue('שלום');
  expect(f.actions.filter((a) => a.type === 'send-composer')).toHaveLength(1);
  await expect(send(page)).toBeEnabled();
});
test('a dialog in the terminal labels the session and still lets a message wait for it', async ({
  page,
}) => {
  await claudeSession(page, { transport: 'tmux' }, (snapshot) => {
    snapshot.codingState = 'dialog-open';
  });
  await expect(page.locator('.session-header')).toContainText('A dialog is open in the terminal');
  await input(page).fill('שלום');
  await expect(send(page)).toBeEnabled();
});
test('the peer route explains itself where the Send as peer button used to be', async ({
  page,
}) => {
  await claudeSession(page, { transport: 'peer' });
  await page.route('**/api/sessions/*/claude-peer', (r) => r.fulfill({ json: { user: 'unset' } }));
  await expect(page.locator('.route-line > summary')).toHaveText('Peer — limited');
  await page.locator('.route-line > summary').click();
  await page.getByText('How to allow', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Allow for all sessions' })).toBeVisible();
  await expect(page.locator('.claude-connection')).toHaveCount(1);
});
test('without a route Send stays disabled and the route line says why', async ({ page }) => {
  await claudeSession(page, { transport: null, reason: 'Gloss can’t reach this session yet.' });
  await input(page).fill('שלום');
  await expect(send(page)).toBeDisabled();
  await expect(page.locator('.route-line')).toContainText('Gloss can’t reach this session yet.');
});
