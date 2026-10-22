import { test, expect, type Page } from '@playwright/test';
import type { FilePreview } from '../../src/core/file-references.js';
import { mockSession, basicSnapshot } from './session-fixture.js';

const VIDEO = 'tests/fixtures/preview-video.webm';
const AUDIO = 'tests/fixtures/dictation-he.wav';
/** Opens one file's preview through the @file picker, with the server's preview and link mocked. */
async function open(
  page: Page,
  preview: FilePreview,
  served?: { type: string } & ({ path: string } | { body: string }),
) {
  const links: string[] = [];
  await mockSession(page, basicSnapshot);
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route('**/files/search?*', (r) =>
    r.fulfill({ json: [{ name: preview.name, relativePath: preview.relativePath }] }),
  );
  await page.route('**/files/preview?*', (r) => r.fulfill({ json: preview }));
  await page.route('**/files/stream-link', (r) => {
    links.push(r.request().postDataJSON().path);
    return served
      ? r.fulfill({ json: { url: '/api/media/token/' + encodeURIComponent(preview.name) } })
      : r.fulfill({ status: 400, json: { error: 'Video exceeds the 2 GiB preview limit.' } });
  });
  if (served)
    await page.route('**/api/media/token/*', (r) =>
      r.fulfill({ ...served, contentType: served.type }),
    );
  await page.goto('/#capability=test');
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.fill('@file');
  await expect(page.locator('.file-picker [role=option]')).toHaveCount(1);
  await input.press('Enter');
  const pane = page.getByRole('dialog', { name: 'File preview' }).locator('.files-window-preview');
  return { pane, links };
}
const base = { size: 1000, version: '1:2:1000:0' };

test('video plays in the browser player from a streamed link, and attaches as a video', async ({
  page,
}) => {
  const ref = {
    id: 'ref',
    sessionId: 'basic',
    kind: 'file',
    index: 1,
    name: 'clip.webm',
    path: '/project/clip.webm',
    originalPath: 'clip.webm',
    worktreePath: '/project',
    source: 'worktree',
    mime: 'application/octet-stream',
    size: 1000,
  };
  const { pane, links } = await open(
    page,
    { ...base, name: 'clip.webm', relativePath: 'clip.webm', state: 'stream', kind: 'video' },
    { path: VIDEO, type: 'video/webm' },
  );
  // Registered after the session mock so these take precedence over its defaults.
  await page.route('**/files/reference', (r) => r.fulfill({ json: ref }));
  await page.route('**/files/*/metadata', (r) =>
    r.fulfill({
      json: { ...ref, contentStatus: { state: 'unreadable', reason: 'Unsupported binary' } },
    }),
  );
  const video = pane.locator('video');
  await expect(video).toHaveAttribute('src', '/api/media/token/clip.webm');
  await expect(video).toHaveAttribute('controls', '');
  // The fixture's metadata loads, so the player received real media from the link.
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
    .toBeGreaterThanOrEqual(1);
  // React's development StrictMode may request the link twice; both name only this file.
  expect(new Set(links)).toEqual(new Set(['clip.webm']));
  await pane.getByRole('button', { name: 'Attach file', exact: true }).click();
  await expect(pane.getByRole('status').filter({ hasText: 'Attached' })).toHaveText(
    'Attached as File 1',
  );
  await page
    .getByRole('dialog', { name: 'File preview' })
    .getByRole('button', { name: 'Close file preview', exact: true })
    .click();
  await expect(page.locator('.composer .attachment-card figcaption')).toHaveText('File 1 · Video');
});

test('audio uses the browser player', async ({ page }) => {
  const { pane } = await open(
    page,
    { ...base, name: 'voice.wav', relativePath: 'voice.wav', state: 'stream', kind: 'audio' },
    { path: AUDIO, type: 'audio/wav' },
  );
  const audio = pane.locator('audio');
  await expect(audio).toHaveAttribute('src', '/api/media/token/voice.wav');
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState))
    .toBeGreaterThanOrEqual(1);
});

test('PDF opens in an embedded viewer frame', async ({ page }) => {
  const { pane } = await open(
    page,
    { ...base, name: 'manual.pdf', relativePath: 'docs/manual.pdf', state: 'stream', kind: 'pdf' },
    { path: VIDEO, type: 'application/pdf' },
  );
  await expect(pane.locator('iframe[title="PDF preview"]')).toHaveAttribute(
    'src',
    '/api/media/token/manual.pdf',
  );
});

test('SVG shows as an image and as source', async ({ page }) => {
  const text = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>';
  const { pane } = await open(
    page,
    { ...base, name: 'logo.svg', relativePath: 'logo.svg', state: 'text', kind: 'svg', text },
    { body: text, type: 'image/svg+xml' },
  );
  await expect(pane.getByRole('img', { name: 'logo.svg' })).toHaveAttribute(
    'src',
    '/api/media/token/logo.svg',
  );
  await expect
    .poll(() => pane.getByRole('img').evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(20);
  await pane.getByRole('tab', { name: 'Source', exact: true }).click();
  await expect(pane.locator('.file-source')).toContainText('<svg xmlns=');
  await expect(pane.getByRole('img')).toHaveCount(0);
});

test('names kinds that are not previewed and over-limit files', async ({ page }) => {
  const { pane } = await open(page, {
    ...base,
    name: 'bundle.zip',
    relativePath: 'bundle.zip',
    state: 'binary',
    kind: 'archive',
  });
  await expect(pane.getByRole('status')).toHaveText(
    'Archives are not previewed. You can still attach the file.',
  );
  await expect(pane.getByRole('button', { name: 'Attach file', exact: true })).toBeVisible();
});

test('an over-limit video names its limit and requests no link', async ({ page }) => {
  const { pane, links } = await open(page, {
    ...base,
    name: 'huge.mp4',
    relativePath: 'huge.mp4',
    state: 'large',
    kind: 'video',
  });
  await expect(pane.getByRole('status')).toHaveText('Video exceeds the 2 GiB preview limit.');
  expect(links).toEqual([]);
});

test('a refused link shows the server message', async ({ page }) => {
  const { pane } = await open(page, {
    ...base,
    name: 'clip.mp4',
    relativePath: 'clip.mp4',
    state: 'stream',
    kind: 'video',
  });
  await expect(pane.getByRole('status')).toHaveText(
    'Preview unavailable: Video exceeds the 2 GiB preview limit.',
  );
  await expect(pane.locator('video')).toHaveCount(0);
});
