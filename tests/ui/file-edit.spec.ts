import { test, expect, type Page } from '@playwright/test';
import { mockSession, basicSnapshot } from './session-fixture.js';

/** An in-memory session folder behind the file routes; each write bumps the file's version. */
async function setup(page: Page, initial: Record<string, string>) {
  const files = new Map(
    Object.entries(initial).map(([path, text]) => [path, { text, version: 1 }]),
  );
  const requests = { saves: [] as unknown[], creates: [] as unknown[], reviews: 0 };
  await mockSession(page, basicSnapshot);
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route('**/files/browse?*', (r) => {
    const folder = new URL(r.request().url()).searchParams.get('path') ?? '';
    const prefix = folder ? folder + '/' : '';
    const names = new Map<string, 'file' | 'directory'>();
    for (const path of files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const [name, ...rest] = path.slice(prefix.length).split('/');
      names.set(name!, rest.length ? 'directory' : 'file');
    }
    return r.fulfill({
      json: {
        entries: [...names].map(([name, kind]) => ({ name, relativePath: prefix + name, kind })),
        limited: false,
      },
    });
  });
  await page.route('**/files/preview?*', (r) => {
    const path = new URL(r.request().url()).searchParams.get('path')!;
    const file = files.get(path)!;
    return r.fulfill({
      json: {
        name: path.split('/').at(-1),
        relativePath: path,
        state: 'text',
        size: file.text.length,
        text: file.text,
        version: 'v' + file.version,
      },
    });
  });
  await page.route('**/files/review*', (r) => {
    requests.reviews++;
    return r.fulfill({ json: { summary: false, translation: false } });
  });
  await page.route('**/files/editable?*', (r) => {
    const path = new URL(r.request().url()).searchParams.get('path')!;
    const file = files.get(path)!;
    return r.fulfill({
      json: { relativePath: path, text: file.text, version: 'sha256:' + file.version },
    });
  });
  await page.route('**/files/edit', (r) => {
    const body = r.request().postDataJSON();
    requests.saves.push(body);
    const file = files.get(body.path)!;
    if (body.baseVersion !== 'sha256:' + file.version)
      return r.fulfill({
        status: 409,
        json: { error: 'The file changed on disk since you opened it', code: 'file-changed' },
      });
    files.set(body.path, { text: body.text, version: file.version + 1 });
    return r.fulfill({
      json: { relativePath: body.path, version: 'sha256:' + (file.version + 1) },
    });
  });
  await page.route('**/files/create', (r) => {
    const body = r.request().postDataJSON();
    requests.creates.push(body);
    if (files.has(body.path) || [...files.keys()].some((p) => p.startsWith(body.path + '/')))
      return r.fulfill({
        status: 409,
        json: { error: 'A file or folder with this name already exists', code: 'file-exists' },
      });
    files.set(body.path, { text: body.text, version: 1 });
    return r.fulfill({ json: { relativePath: body.path, version: 'sha256:1' } });
  });
  await page.goto('/#capability=test');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  const popup = page.getByRole('dialog', { name: 'File preview' });
  return { files, requests, popup };
}
const editor = (page: Page) => page.getByRole('textbox', { name: /^Contents of / });

test('edits a file, keeps its CRLF line endings, saves with Cmd/Ctrl+S and offers to tell the agent', async ({
  page,
}) => {
  const { files, requests, popup } = await setup(page, { 'config.txt': 'A=1\r\nB=2\r\n' });
  await page.getByRole('button', { name: 'Preview config.txt' }).click();
  // An ordinary file keeps its review tools in the preview; the editor shows none.
  await expect(popup.getByRole('button', { name: 'TL;DR' })).toBeVisible();
  await popup.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(popup.getByRole('button', { name: 'TL;DR' })).toHaveCount(0);
  await expect(editor(page)).toHaveValue('A=1\nB=2\n');
  await expect(editor(page)).toBeFocused();
  await expect(editor(page)).toHaveAttribute('translate', 'no');
  await editor(page).fill('A=1\nB=3\nC=4');
  await expect(popup.getByText('Unsaved changes')).toBeVisible();
  await editor(page).press('ControlOrMeta+s');
  await expect(popup.getByRole('status').filter({ hasText: 'Saved config.txt.' })).toBeVisible();
  expect(requests.saves).toEqual([
    { path: 'config.txt', text: 'A=1\r\nB=3\r\nC=4', baseVersion: 'sha256:1' },
  ]);
  expect(files.get('config.txt')!.text).toBe('A=1\r\nB=3\r\nC=4');
  await expect(editor(page)).toHaveCount(0);
  await expect(popup.locator('.file-source')).toContainText('B=3');
  const composer = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await expect(composer).toHaveValue('');
  await popup.getByRole('button', { name: 'Tell the agent' }).click();
  await expect(composer).toHaveValue('I edited config.txt.');
  // Nothing is unsaved any more, so closing asks nothing.
  await popup.getByRole('button', { name: 'Close file preview' }).click();
  await expect(popup).toHaveCount(0);
});

test('environment files can be edited but offer no TL;DR or translation', async ({ page }) => {
  const { requests, popup } = await setup(page, { '.env': 'TOKEN=secret\n' });
  await page.getByRole('button', { name: 'Preview .env' }).click();
  await expect(popup.locator('.file-source')).toContainText('TOKEN=secret');
  await expect(popup.getByRole('button', { name: 'TL;DR' })).toHaveCount(0);
  await popup.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(editor(page)).toHaveValue('TOKEN=secret\n');
  await expect(popup.getByRole('button', { name: 'TL;DR' })).toHaveCount(0);
  expect(requests.reviews).toBe(0);
});

test('a file changed on disk is never overwritten: reload or copy the edits', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { files, popup } = await setup(page, { 'notes.md': 'one\n' });
  await page.getByRole('button', { name: 'Preview notes.md' }).click();
  await popup.getByRole('button', { name: 'Edit', exact: true }).click();
  await editor(page).fill('mine\n');
  // The agent writes the file meanwhile.
  files.set('notes.md', { text: 'agent\n', version: 2 });
  await popup.getByRole('button', { name: 'Save', exact: true }).click();
  const conflict = popup.getByRole('alert').filter({ hasText: 'changed on disk' });
  await expect(conflict).toBeVisible();
  expect(files.get('notes.md')!.text).toBe('agent\n');
  await expect(editor(page)).toHaveValue('mine\n');
  await conflict.getByRole('button', { name: 'Copy my edits' }).click();
  await expect(popup.getByText('Your edits are copied')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('mine\n');
  await conflict.getByRole('button', { name: 'Reload (lose my edits)' }).click();
  await expect(editor(page)).toHaveValue('agent\n');
  await expect(conflict).toHaveCount(0);
});

test('creates a file from the column header or a folder menu, refusing a taken name', async ({
  page,
}) => {
  const { files, requests, popup } = await setup(page, { 'src/app.ts': 'x' });
  await page.getByRole('button', { name: 'Open folder src' }).click();
  await page.getByRole('button', { name: 'Open folder src' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New file…' }).click();
  const path = page.getByLabel('New file path in this session');
  await expect(path).toHaveValue('src/');
  await path.fill('src/app.ts');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'already exists' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(path).toHaveCount(0);
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  await expect(path).toHaveValue('');
  await path.fill('docs/guide.md');
  await path.press('Enter');
  await expect(editor(page)).toHaveValue('');
  await expect(popup.locator('.files-window-title strong')).toHaveText('guide.md');
  expect(requests.creates).toEqual([
    { path: 'src/app.ts', text: '' },
    { path: 'docs/guide.md', text: '' },
  ]);
  // The tree lists the new folder.
  await expect(page.getByRole('button', { name: 'Open folder docs' })).toBeVisible();
  await editor(page).fill('# Guide\n');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(popup.getByRole('status').filter({ hasText: 'Saved docs/guide.md.' })).toBeVisible();
  expect(files.get('docs/guide.md')!.text).toBe('# Guide\n');
});

test('unsaved edits are only dropped after the user agrees, in the app', async ({ page }) => {
  let dialogs = 0;
  page.on('dialog', (dialog) => {
    dialogs++;
    void dialog.dismiss();
  });
  const { requests, popup } = await setup(page, { 'a.txt': 'alpha\n', 'b.txt': 'beta\n' });
  await page.getByRole('button', { name: 'Preview a.txt' }).click();
  await popup.getByRole('button', { name: 'Edit', exact: true }).click();
  await editor(page).fill('alpha edited\n');
  // Another file: asked first, and "Keep editing" keeps everything.
  await page.getByRole('button', { name: 'Preview b.txt' }).click();
  const prompt = popup.getByRole('alertdialog', { name: 'Unsaved edits' });
  await expect(prompt).toContainText('You have unsaved edits to a.txt');
  await expect(prompt.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await prompt.getByRole('button', { name: 'Keep editing' }).click();
  await expect(prompt).toHaveCount(0);
  await expect(editor(page)).toHaveValue('alpha edited\n');
  await expect(popup.locator('.files-window-title strong')).toHaveText('a.txt');
  // Cancel inside the editor asks too.
  await popup.getByRole('button', { name: 'Cancel', exact: true }).click();
  await popup.getByRole('alertdialog').getByRole('button', { name: 'Keep editing' }).click();
  await expect(editor(page)).toHaveValue('alpha edited\n');
  // Closing the popup: Escape on the question keeps editing, Discard closes.
  await popup.getByRole('button', { name: 'Close file preview' }).click();
  await expect(prompt).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);
  await expect(editor(page)).toHaveValue('alpha edited\n');
  await popup.getByRole('button', { name: 'Close file preview' }).click();
  await prompt.getByRole('button', { name: 'Discard and close' }).click();
  await expect(popup).toHaveCount(0);
  // Reopened: the discarded draft is gone and the file was never written.
  await page.getByRole('button', { name: 'Preview a.txt' }).click();
  await expect(popup.locator('.file-source')).toContainText('alpha');
  await expect(editor(page)).toHaveCount(0);
  expect(requests.saves).toEqual([]);
  expect(dialogs).toBe(0);
});

test('Discard and open switches to the other file and drops the draft', async ({ page }) => {
  const { popup } = await setup(page, { 'a.txt': 'alpha\n', 'b.txt': 'beta\n' });
  await page.getByRole('button', { name: 'Preview a.txt' }).click();
  await popup.getByRole('button', { name: 'Edit', exact: true }).click();
  await editor(page).fill('draft\n');
  await page.getByRole('button', { name: 'Preview b.txt' }).click();
  await popup.getByRole('button', { name: 'Discard and open' }).click();
  await expect(popup.locator('.files-window-title strong')).toHaveText('b.txt');
  await expect(editor(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview a.txt' }).click();
  await expect(popup.locator('.file-source')).toContainText('alpha');
  await expect(editor(page)).toHaveCount(0);
});
