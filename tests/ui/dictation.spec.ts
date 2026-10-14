import { expect, test } from '@playwright/test';
import { mockSession } from './session-fixture.js';
import { DICTATION_REASON_TEXT } from '../../src/core/dictation-contracts.js';
const base = () => ({ id: 'dict', target: { agent: 'codex', sessionRef: 's', projectId: 'p' }, codingState: 'idle', codingMessages: [], discussion: [], deliveries: [], language: 'he', languageSessionId: 'l', languageModel: 'm', sourceRevision: 1 });
test('mic button is disabled with a reason when the engine is not built', async ({ page }) => {
  const snapshot = base(); await mockSession(page, () => snapshot);
  await page.route('**/api/dictation', route => route.fulfill({ json: { available: false, reason: 'engine-missing', model: { present: false }, engine: 'stopped' } }));
  await page.goto('/#capability=test');
  const button = page.getByRole('button', { name: 'Dictation unavailable: ' + DICTATION_REASON_TEXT['engine-missing'] });
  await expect(button).toBeDisabled();
});
test('mic button is enabled and labelled with the write language when available', async ({ page }) => {
  const snapshot = base(); await mockSession(page, () => snapshot);
  await page.route('**/api/dictation', route => route.fulfill({ json: { available: true, model: { present: true, bytes: 1 }, engine: 'stopped' } }));
  await page.goto('/#capability=test');
  await expect(page.getByRole('button', { name: 'Dictate in Hebrew' })).toBeEnabled();
});
test('a status request failure leaves the button disabled rather than broken', async ({ page }) => {
  const snapshot = base(); await mockSession(page, () => snapshot);
  await page.route('**/api/dictation', route => route.fulfill({ status: 500, json: { error: 'x' } }));
  await page.goto('/#capability=test');
  await expect(page.getByRole('button', { name: /Dictation unavailable/ })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Discuss with language assistant' })).toBeEditable();
});
async function mockDictationPage(page: import('@playwright/test').Page, modelPresent = true) {
  const snapshot = base(); await mockSession(page, () => snapshot); const actions: any[] = [];
  await page.route('**/api/dictation', route => route.fulfill({ json: { available: true, model: modelPresent ? { present: true, bytes: 1 } : { present: false }, engine: modelPresent ? 'running' : 'stopped' } }));
  await page.route('**/api/sessions/*/events', route => route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ sessionId: snapshot.id, sequence: 1, snapshot }) + '\n\n' }));
  await page.route('**/api/sessions/*/actions', route => { actions.push(route.request().postDataJSON()); return route.fulfill({ json: { sessionId: snapshot.id, sequence: 2, snapshot } }); });
  // A synthetic tone stands in for the microphone; the server side is a scripted socket.
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { const ctx = new AudioContext(); const osc = ctx.createOscillator(); const dest = ctx.createMediaStreamDestination(); osc.connect(dest); osc.start(); return dest.stream; }; });
  return actions;
}
async function recordingFixture(page: import('@playwright/test').Page, answerStop = true) {
  const actions = await mockDictationPage(page); const stops: number[] = [];
  await page.routeWebSocket('**/api/dictation/audio**', ws => {
    expect(new URL(ws.url()).searchParams.get('language')).toBe('he');
    ws.send(JSON.stringify({ type: 'state', state: 'starting' })); ws.send(JSON.stringify({ type: 'state', state: 'recording' }));
    ws.send(JSON.stringify({ type: 'segment', sequence: 1, text: 'שלום' }));
    ws.onMessage(message => { if (typeof message !== 'string' || JSON.parse(message).type !== 'stop') return; stops.push(Date.now()); if (!answerStop) return;
      ws.send(JSON.stringify({ type: 'segment', sequence: 2, text: 'עולם' })); ws.send(JSON.stringify({ type: 'state', state: 'finished' })); void ws.close({ code: 1000, reason: 'finished' }); });
  });
  await page.goto('/#capability=test');
  return { actions, stops, composer: page.getByRole('textbox', { name: 'Discuss with language assistant' }) };
}
test('Enter while recording stops, waits for the last segment and then sends the full text', async ({ page }) => {
  const { actions, stops, composer } = await recordingFixture(page);
  await page.getByRole('button', { name: 'Dictate in Hebrew' }).click();
  await expect(page.getByRole('button', { name: 'Stop dictation' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('form.composer')).toHaveClass(/composer-recording/);
  await expect(composer).toHaveValue('שלום');
  await composer.press('Enter');
  await expect.poll(() => actions.find(a => a.type === 'send-composer')?.text).toBe('שלום עולם');
  expect(stops).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Dictate in Hebrew' })).toBeEnabled();
  await expect(page.locator('form.composer')).not.toHaveClass(/composer-recording/);
});
test('Escape stops dictation without sending, and the shortcut starts it', async ({ page }) => {
  const { actions, stops, composer } = await recordingFixture(page);
  await composer.click(); await composer.press('ControlOrMeta+Shift+KeyM');
  await expect(composer).toHaveValue('שלום');
  await composer.press('Escape');
  await expect.poll(() => stops.length).toBe(1);
  await expect(composer).toHaveValue('שלום עולם');
  await expect(page.getByRole('button', { name: 'Dictate in Hebrew' })).toBeEnabled();
  expect(actions.filter(a => a.type === 'send-composer' || a.type === 'discuss')).toHaveLength(0);
});
test('Discuss first while recording waits for the last segment and discusses the full text', async ({ page }) => {
  const { actions, composer } = await recordingFixture(page);
  await page.getByRole('button', { name: 'Dictate in Hebrew' }).click();
  await expect(composer).toHaveValue('שלום');
  await page.getByRole('button', { name: 'Discuss first', exact: true }).click();
  await expect.poll(() => actions.find(a => a.type === 'discuss')?.text).toBe('שלום עולם');
  expect(actions.filter(a => a.type === 'send-composer')).toHaveLength(0);
});
test('an insertion scrolls the composer to the end, and a pending stop shows a marker', async ({ page }) => {
  const { stops, composer } = await recordingFixture(page, false);
  await composer.fill(Array.from({ length: 40 }, (_, i) => 'line ' + i).join('\n')); await composer.evaluate(el => { el.scrollTop = 0; });
  await page.getByRole('button', { name: 'Dictate in Hebrew' }).click();
  await expect(composer).toHaveValue(/שלום$/);
  await expect.poll(() => composer.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Stop dictation' }).click();
  await expect.poll(() => stops.length).toBe(1);
  await expect(page.locator('.dictation-control .dictation-status', { hasText: '…' })).toBeVisible();
});
test('the recording clock advances once a second while recording', async ({ page }) => {
  await recordingFixture(page, false);
  await page.getByRole('button', { name: 'Dictate in Hebrew' }).click();
  const clock = page.locator('.dictation-elapsed');
  await expect(clock).toHaveText('00:00');
  await expect(clock).toHaveText('00:01', { timeout: 2500 });
});
test('audio is captured while the speech engine starts, with a status line saying so', async ({ page }) => {
  await mockDictationPage(page);
  let frames = 0; let socket: import('@playwright/test').WebSocketRoute | undefined;
  await page.routeWebSocket('**/api/dictation/audio**', ws => {
    socket = ws; ws.send(JSON.stringify({ type: 'state', state: 'starting' }));
    ws.onMessage(message => { if (typeof message !== 'string') frames++; });
  });
  await page.goto('/#capability=test');
  const composer = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await page.getByRole('button', { name: 'Dictate in Hebrew' }).click();
  await expect(page.getByRole('button', { name: 'Starting the speech engine, you can talk now' })).toBeVisible();
  await expect(page.locator('.dictation-status', { hasText: 'Loading the speech engine, speech is being recorded…' })).toBeVisible();
  await expect(page.locator('form.composer')).toHaveClass(/composer-recording/);
  // The engine is still starting: PCM frames already flow so the server can buffer them.
  await expect.poll(() => frames).toBeGreaterThan(2);
  socket!.send(JSON.stringify({ type: 'state', state: 'recording' })); socket!.send(JSON.stringify({ type: 'segment', sequence: 1, text: 'שלום' }));
  await expect(page.getByRole('button', { name: 'Stop dictation' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.dictation-status', { hasText: 'speech is being recorded' })).toHaveCount(0);
  await expect(composer).toHaveValue('שלום');
});
test('the first press without the speech model explains the one-time download; Cancel does nothing, Continue starts', async ({ page }) => {
  await mockDictationPage(page, false);
  let sockets = 0; let frames = 0;
  await page.routeWebSocket('**/api/dictation/audio**', ws => {
    sockets++; ws.send(JSON.stringify({ type: 'state', state: 'downloading', received: 10 * 1024 * 1024, total: 100 * 1024 * 1024 }));
    ws.onMessage(message => { if (typeof message !== 'string') frames++; });
  });
  await page.goto('/#capability=test');
  const mic = page.getByRole('button', { name: 'Dictate in Hebrew' });
  const dialog = page.getByRole('dialog', { name: 'One-time download for dictation' });
  await mic.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('about 574 MB');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(mic).toBeEnabled(); expect(sockets).toBe(0);
  await mic.click();
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => sockets).toBe(1);
  await expect(page.locator('.dictation-status', { hasText: 'Downloading the speech model (10%), speech is being recorded…' })).toBeVisible();
  await expect.poll(() => frames).toBeGreaterThan(2);
});
test('no download dialog when the speech model is present', async ({ page }) => {
  await mockDictationPage(page);
  let sockets = 0; await page.routeWebSocket('**/api/dictation/audio**', ws => { sockets++; ws.send(JSON.stringify({ type: 'state', state: 'starting' })); });
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'Dictate in Hebrew' }).click();
  await expect.poll(() => sockets).toBe(1);
  await expect(page.getByRole('dialog', { name: 'One-time download for dictation' })).toBeHidden();
});
test('closing the download dialog with × or Enter never sends the composer text', async ({ page }) => {
  const actions = await mockDictationPage(page, false);
  await page.goto('/#capability=test');
  const composer = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await composer.fill('keep me');
  const mic = page.getByRole('button', { name: 'Dictate in Hebrew' });
  const dialog = page.getByRole('dialog', { name: 'One-time download for dictation' });
  await mic.click(); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close One-time download for dictation' }).click();
  await expect(dialog).toBeHidden();
  await mic.click(); await expect(dialog).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await page.waitForTimeout(300);
  expect(actions.filter(a => a.type === 'send-composer' || a.type === 'discuss')).toHaveLength(0);
  await expect(composer).toHaveValue('keep me');
});
