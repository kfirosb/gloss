import { mockSession } from './session-fixture.js';
import { test, expect } from '@playwright/test';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
for (const [width, height] of [
  [1280, 800],
  [390, 600],
  [900, 450],
])
  test(`paste and attach reference images at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width: width!, height: height! });
    const target = { agent: 'codex', sessionRef: 's', projectId: 'p' };
    let sequence = 1,
      serial = 0;
    let sent = false;
    const calls: any[] = [];
    let snapshot: any = {
      id: 'images',
      target,
      codingState: 'idle',
      capabilities: { imageAttachments: true },
      codingMessages: [],
      discussion: [],
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
    await page.route('**/api/sessions/*/files', (r) =>
      r.fulfill({
        json: {
          id: `image-${++serial}`,
          name: 'Screenshot.png',
          mime: 'image/png',
          size: 68,
          kind: 'image',
          index: serial,
          sessionId: snapshot.id,
          path: '/tmp/image.png',
          worktreePath: '/project',
          source: 'upload',
        },
      }),
    );
    await page.route('**/api/sessions/*/files/*/content', (r) =>
      r.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') }),
    );
    await page.route('**/api/sessions/*/actions', async (r) => {
      const a = r.request().postDataJSON();
      calls.push(a);
      snapshot = {
        ...snapshot,
        deliveries: [
          {
            id: 'receipt',
            draftId: `composer-${a.requestId}`,
            revision: 1,
            target,
            englishText: 'Reference',
            state: sent ? 'sent' : 'queued',
          },
        ],
      };
      await r.fulfill({ json: { sessionId: snapshot.id, sequence: ++sequence, snapshot } });
    });
    await page.goto('/#capability=test');
    const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
    await input.fill('Use these references');
    await input.evaluate((e, data) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], 'Pasted.png', {
          type: 'image/png',
        }),
      );
      e.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    }, png);
    await expect(page.locator('.image-thumb')).toHaveCount(1);
    await expect(input).toHaveValue('Use these references');
    await page.getByLabel('Attach files').setInputFiles({
      name: 'File.png',
      mimeType: 'image/png',
      buffer: Buffer.from(png, 'base64'),
    });
    await expect(page.locator('.image-thumb')).toHaveCount(2);
    await page.getByRole('button', { name: 'Remove Image 1', exact: true }).click();
    await expect(page.locator('.image-thumb')).toHaveCount(1);
    await page.reload();
    await expect(page.locator('.image-thumb img')).toHaveCount(1);
    await expect(input).toHaveValue('Use these references');
    await page.getByRole('button', { name: 'Send to Terminal in English', exact: true }).click();
    expect(calls.find((a) => a.type === 'send-composer').attachmentIds).toEqual(['image-2']);
    await expect(page.locator('.image-thumb')).toHaveCount(1);
    await expect(input).toHaveValue('Use these references');
    sent = true;
    await expect(page.locator('.image-thumb')).toHaveCount(0, { timeout: 7000 });
    await expect(input).toHaveValue('');
    expect(calls.filter((a) => a.type === 'send-composer')).toHaveLength(1);
  });

for (const width of [1280, 390])
  test(`discussion images flow into instruction review at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    let sequence = 1;
    let fail = true;
    let discussionCalls = 0;
    const image = {
      id: 'image-discuss',
      index: 1,
      name: 'Reference.png',
      mime: 'image/png',
      size: 68,
      path: '/tmp/reference.png',
      kind: 'image',
      sessionId: 'image-discussion',
      worktreePath: '/project',
      source: 'upload',
    };
    const target = { agent: 'codex', sessionRef: 's', projectId: 'p' };
    let snapshot: any = {
      id: 'image-discussion',
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
    await mockSession(page, () => snapshot);
    await page.route('**/api/sessions/*/events', (r) =>
      r.fulfill({
        contentType: 'text/event-stream',
        body: 'data: ' + JSON.stringify({ sessionId: snapshot.id, sequence, snapshot }) + '\n\n',
      }),
    );
    await page.route('**/api/sessions/*/files', (r) => r.fulfill({ json: image }));
    await page.route('**/api/sessions/*/files/*/content', (r) =>
      r.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') }),
    );
    await page.route('**/api/sessions/*/actions', async (r) => {
      const a = r.request().postDataJSON();
      if (a.type === 'discuss') {
        discussionCalls++;
        if (discussionCalls <= 2) expect(a.attachmentIds).toEqual([image.id]);
        else expect(a.attachmentIds).toBeUndefined();
        if (fail) {
          await r.fulfill({ status: 400, json: { error: 'Discussion unavailable' } });
          return;
        }
        snapshot.discussion = [
          { role: 'user', text: a.text, attachments: [image] },
          { role: 'assistant', text: 'Image 1 shows the reference', attachments: [image] },
        ];
      } else if (a.type === 'prepare')
        snapshot.currentDraft = {
          id: 'review-image',
          revision: 1,
          target,
          sourceRevision: 1,
          language: 'he',
          localizedText: 'Use Image 1',
          englishText: 'Use Image 1',
          attachments: [image],
          selectedDiscussion: a.indices,
        };
      else throw new Error('Unexpected action');
      await r.fulfill({
        json: {
          sessionId: snapshot.id,
          sequence: ++sequence,
          snapshot,
          ...(a.type === 'prepare' ? { review: snapshot.currentDraft } : {}),
        },
      });
    });
    await page.goto('/#capability=test');
    const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
    await page.getByLabel('Attach files').setInputFiles({
      name: 'Reference.png',
      mimeType: 'image/png',
      buffer: Buffer.from(png, 'base64'),
    });
    await expect(page.locator('.image-thumb')).toHaveCount(1);
    await input.fill('Discuss this reference');
    await page.getByRole('button', { name: 'Discuss first', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Discussion unavailable');
    await expect(input).toHaveValue('Discuss this reference');
    await expect(page.locator('.image-thumb')).toHaveCount(1);
    fail = false;
    await page.getByRole('button', { name: 'Discuss first', exact: true }).click();
    await expect(input).toHaveValue('');
    await expect(page.locator('.image-thumb')).toHaveCount(0);
    await expect(page.locator('.discussion figcaption')).toHaveText('Image 1');
    await page.getByRole('button', { name: 'Add to answer', exact: true }).click();
    await page.getByRole('button', { name: 'Prepare instruction', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Review instruction', exact: true });
    await expect(dialog.locator('figcaption')).toHaveText('Image 1');
    await expect(dialog.locator('img')).toHaveCount(1);
    await page.getByRole('button', { name: 'Close review', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: 'Resume review', exact: true }).click();
    await expect(dialog.locator('figcaption')).toHaveText('Image 1');
    await page.getByRole('button', { name: 'Close review', exact: true }).click();
    await input.fill('Follow-up without an attachment');
    await page.getByRole('button', { name: 'Discuss first', exact: true }).click();
    await expect(input).toHaveValue('');
    expect(discussionCalls).toBe(3);
  });
