import { expect, test } from '@playwright/test';
import { basicSnapshot, mockSession } from './session-fixture.js';

async function fixture(page: import('@playwright/test').Page, deliveryState: string | string[]) {
  let sends = 0;
  const snapshot: any = { ...basicSnapshot(), target: { agent: 'claude', sessionRef: '11111111-1111-4111-8111-111111111111', projectId: '/project' }, capabilities: { sendWhileBusy: true, fileReferences: true } };
  let sequence = 0; let replied = false; let failing = false;
  await mockSession(page, () => snapshot);
  // The event stream ends at once; the client reconnects after ~1 s, and once `replied` is set the next connection carries the answered delivery.
  await page.route('**/api/sessions/*/events', route => {
    if (!replied) return route.fulfill({ contentType: 'text/event-stream', body: '' });
    for (const d of snapshot.deliveries) if (d.state === 'queued') { d.state = failing ? 'failed' : 'sent'; if (failing) d.reason = 'channel dropped'; }
    return route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ sessionId: snapshot.id, sequence: ++sequence, snapshot }) + '\n\n' });
  });
  await page.route('**/api/sessions/*/claude-channel', route => route.fulfill({ json: { state: 'connected' } }));
  await page.route('**/api/sessions/*/actions', route => {
    const action = route.request().postDataJSON();
    if (action.type === 'send-composer') { const state = Array.isArray(deliveryState) ? deliveryState[Math.min(sends++, deliveryState.length - 1)]! : deliveryState; snapshot.deliveries.push({ id: action.requestId, draftId: 'composer-' + action.requestId, revision: 1, state, transport: action.transport, ...(state === 'failed' ? { reason: 'channel not connected' } : {}) }); }
    return route.fulfill({ json: { sessionId: snapshot.id, sequence: ++sequence, snapshot } });
  });
  await page.goto('/#capability=test');
  return { snapshot, reply() { replied = true; }, fail() { failing = true; replied = true; } };
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
  await page.waitForTimeout(1500);
  await expect(page.locator('.status-strip[data-state="delivered"]')).toHaveCount(0);
  await expect(strip).toHaveCount(0);
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

test('a queued channel delivery that fails on reconnect ends the waiting strip and never shows received', async ({ page }) => {
  const f = await fixture(page, 'queued');
  await page.getByRole('textbox', { name: 'Discuss with language assistant' }).fill('שלום');
  await page.getByRole('button', { name: 'Send to Terminal in English', exact: true }).click();
  const strip = page.locator('.pane-composer .status-strip');
  await expect(strip).toHaveAttribute('data-state', 'waiting');
  await page.evaluate(() => { (window as any).__states = []; new MutationObserver(() => { for (const e of document.querySelectorAll('.status-strip')) (window as any).__states.push(e.getAttribute('data-state')); }).observe(document.body, { subtree: true, childList: true, attributes: true }); });
  f.fail();
  // The composer attempt is released once the channel accepts the send, so a later failure has no composer delivery to show: the waiting strip just ends.
  await expect(strip).toHaveCount(0, { timeout: 10000 });
  expect(await page.evaluate(() => (window as any).__states)).not.toContain('received');
});

test('a newer failed send wins over a waiting reply, and the waiting line stays visible', async ({ page }) => {
  await fixture(page, ['queued', 'failed']);
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  const send = page.getByRole('button', { name: 'Send to Terminal in English', exact: true });
  const strip = page.locator('.pane-composer .status-strip');
  await input.fill('שלום');
  await send.click();
  await expect(strip).toHaveAttribute('data-state', 'waiting');
  await input.fill('עוד אחד');
  await send.click();
  await expect(strip).toHaveAttribute('data-state', 'failed');
  await expect(strip).toContainText('Failed: channel not connected');
  await expect(strip.locator('.status-strip-waiting')).toHaveText('Waiting for Claude’s response');
  await expect(page.locator('form.composer')).toHaveClass(/attn-ring/);
});
