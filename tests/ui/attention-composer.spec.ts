import { expect, test } from '@playwright/test';
import { basicSnapshot, mockSession } from './session-fixture.js';

async function fixture(page: import('@playwright/test').Page, deliveryState: string) {
  const snapshot: any = { ...basicSnapshot(), target: { agent: 'claude', sessionRef: '11111111-1111-4111-8111-111111111111', projectId: '/project' }, capabilities: { sendWhileBusy: true, fileReferences: true } };
  let sequence = 0; let replied = false;
  await mockSession(page, () => snapshot);
  // The event stream ends at once; the client reconnects after ~1 s, and once `replied` is set the next connection carries the answered delivery.
  await page.route('**/api/sessions/*/events', route => {
    if (!replied) return route.fulfill({ contentType: 'text/event-stream', body: '' });
    for (const d of snapshot.deliveries) if (d.state === 'queued') d.state = 'sent';
    return route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ sessionId: snapshot.id, sequence: ++sequence, snapshot }) + '\n\n' });
  });
  await page.route('**/api/sessions/*/claude-channel', route => route.fulfill({ json: { state: 'connected' } }));
  await page.route('**/api/sessions/*/actions', route => {
    const action = route.request().postDataJSON();
    if (action.type === 'send-composer') snapshot.deliveries.push({ id: action.requestId, draftId: 'composer-' + action.requestId, revision: 1, state: deliveryState, transport: action.transport, ...(deliveryState === 'failed' ? { reason: 'channel not connected' } : {}) });
    return route.fulfill({ json: { sessionId: snapshot.id, sequence: ++sequence, snapshot } });
  });
  await page.goto('/#capability=test');
  return { snapshot, reply() { replied = true; } };
}

test('waiting shows a spinner strip and a ring; a reply flips it to Response received', async ({ page }) => {
  const f = await fixture(page, 'queued');
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.fill('שלום');
  await page.getByRole('button', { name: 'Send to Terminal in English', exact: true }).click();
  const strip = page.locator('.pane-composer .status-strip');
  await expect(strip).toHaveAttribute('data-state', 'waiting');
  await expect(strip).toContainText('Waiting for Claude’s response');
  await expect(strip.locator('.attn-spinner')).toHaveCount(1);
  await expect(page.locator('form.composer')).toHaveClass(/attn-ring/);
  await expect(page.getByRole('button', { name: 'Check delivery', exact: true })).toHaveCount(0);
  f.reply();
  await expect(strip).toHaveAttribute('data-state', 'received', { timeout: 10000 });
  await expect(strip).toContainText('Response received');
  await expect(page.locator('form.composer')).not.toHaveClass(/attn-ring/);
  await expect(strip).toHaveAttribute('data-fading', 'true', { timeout: 6000 });
});

test('a failed send stays red with its reason', async ({ page }) => {
  await fixture(page, 'failed');
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.fill('שלום');
  await page.getByRole('button', { name: 'Send to Terminal in English', exact: true }).click();
  const strip = page.locator('.pane-composer .status-strip');
  await expect(strip).toHaveAttribute('data-state', 'failed');
  await expect(strip).toContainText('Failed: channel not connected');
  await page.waitForTimeout(4500);
  await expect(strip).not.toHaveAttribute('data-fading', 'true');
});
