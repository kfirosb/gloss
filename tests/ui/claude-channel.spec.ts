import { expect, test, type Page } from '@playwright/test';
import type { DeliveryRoute } from '../../src/core/contracts.js';
import { basicSnapshot, mockSession } from './session-fixture.js';
import { sessionFixture } from './multi-session-fixture.js';
import { selectSession } from './session-fixture.js';
/** `route` fixes the delivery route before the page loads; otherwise it follows the channel state. */
async function fixture(
  page: Page,
  initial = 'setup-required',
  deliveryState = 'unconfirmed',
  route?: DeliveryRoute,
) {
  const snapshot: any = {
    ...basicSnapshot(),
    target: {
      agent: 'claude',
      sessionRef: '11111111-1111-4111-8111-111111111111',
      projectId: '/project',
    },
    capabilities: { sendWhileBusy: true, fileReferences: true },
  };
  const actions: any[] = [];
  let state = initial;
  let sequence = 0;
  let setups = 0;
  const currentRoute = (): DeliveryRoute =>
    route ??
    (state === 'connected'
      ? { transport: 'channel' }
      : { transport: null, reason: 'Gloss can’t reach this session yet.' });
  await page.route('**/api/sessions/*/claude-route', (r) => r.fulfill({ json: currentRoute() }));
  await mockSession(page, () => snapshot);
  await page.route('**/api/sessions/*/events', (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: '' }),
  );
  await page.route('**/api/sessions/*/claude-channel', (route) => {
    if (route.request().method() === 'POST') {
      setups++;
      return route.fulfill({
        json: {
          kind: 'command',
          command:
            'claude --resume 11111111-1111-4111-8111-111111111111 --dangerously-load-development-channels server:gloss',
          cdCommand:
            "cd '/project' && claude --resume 11111111-1111-4111-8111-111111111111 --dangerously-load-development-channels server:gloss",
          folder: '/project',
        },
      });
    }
    return route.fulfill({ json: { state } });
  });
  await page.route('**/api/sessions/*/actions', (route) => {
    const action = route.request().postDataJSON();
    actions.push(action);
    if (action.type === 'send-composer')
      snapshot.deliveries.push({
        id: action.requestId,
        draftId: 'composer-' + action.requestId,
        revision: 1,
        state: deliveryState,
        transport: action.transport ?? currentRoute().transport ?? undefined,
      });
    if (action.type === 'release-composer') delete snapshot.composerDraft;
    if (action.type === 'send-review')
      snapshot.deliveries.push({
        id: 'review-send',
        draftId: action.draftId,
        revision: action.revision,
        state: 'unconfirmed',
        transport: action.transport ?? currentRoute().transport ?? undefined,
      });
    return route.fulfill({ json: { sessionId: snapshot.id, sequence: ++sequence, snapshot } });
  });
  await page.goto('/#capability=test');
  return {
    snapshot,
    actions,
    setState: (v: string) => {
      state = v;
    },
    setups: () => setups,
  };
}
test('channel handoff clears the composer before a reply and reload keeps the next draft usable', async ({
  page,
}) => {
  const f = await fixture(page, 'connected', 'queued');
  await page.route('**/api/sessions/*/files', (route) =>
    route.fulfill({
      json: {
        id: 'image-1',
        kind: 'image',
        name: 'shot.png',
        mime: 'image/png',
        index: 1,
        size: 7,
        sessionId: f.snapshot.id,
        path: '/tmp/image.png',
        source: 'upload',
        worktreePath: '/project',
      },
    }),
  );
  await page
    .getByLabel('Attach files', { exact: true })
    .setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: Buffer.from('fixture') });
  await expect(page.locator('.composer .attachment-card')).toHaveCount(1);
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.fill('הודעה ראשונה');
  await page.getByRole('button', { name: 'Send to Terminal in English', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(page.locator('.composer .attachment-card')).toHaveCount(0);
  expect(f.actions.find((a) => a.type === 'send-composer').attachmentIds).toEqual(['image-1']);
  await expect(page.getByText('Waiting for Claude’s response', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Release composer', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check delivery', exact: true })).toHaveCount(0);
  const savedDraft = page.waitForResponse(
    (response) =>
      response.url().endsWith('/workspace') &&
      response.request().method() === 'PUT' &&
      response.ok() &&
      response.request().postDataJSON().data.composer === 'טיוטה חדשה',
  );
  await input.fill('טיוטה חדשה');
  await expect.poll(() => f.actions.filter((a) => a.type === 'send-composer').length).toBe(1);
  // Wait for persistence so a reload exercises saved data, not browser timing.
  await savedDraft;
  await page.reload();
  await expect(input).toHaveValue('טיוטה חדשה');
  await expect(page.getByText('Waiting for Claude’s response', { exact: false })).toBeVisible();
  f.snapshot.deliveries[0].state = 'sent';
  await page.reload();
  await expect(input).toHaveValue('טיוטה חדשה');
  await expect(page.getByText('Waiting for Claude’s response', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Send to Terminal in English', exact: true }).click();
  await expect(input).toHaveValue('');
  const sends = f.actions.filter((a) => a.type === 'send-composer');
  expect(sends).toHaveLength(2);
  expect(sends[1].requestId).not.toBe(sends[0].requestId);
  expect(sends[1].text).toBe('טיוטה חדשה');
});

test('a delayed channel handoff preserves edits made while sending', async ({ page }) => {
  const f = await fixture(page, 'connected', 'queued');
  let finish!: () => void;
  await page.route('**/api/sessions/*/actions', async (route) => {
    if (route.request().postDataJSON().type !== 'send-composer') return route.fallback();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    await route.fallback();
  });
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.fill('הודעה בדרך');
  await page.getByRole('button', { name: 'Send to Terminal in English', exact: true }).click();
  await expect.poll(() => Boolean(finish)).toBe(true);
  await input.fill('עריכה בזמן השליחה');
  finish();
  await expect(page.getByText('Waiting for Claude’s response', { exact: false })).toBeVisible();
  await expect(input).toHaveValue('עריכה בזמן השליחה');
  await expect(page.getByRole('button', { name: 'Release composer', exact: true })).toHaveCount(0);
  expect(f.actions.filter((a) => a.type === 'send-composer')).toHaveLength(1);
});
test('discovery is not send readiness; explicit setup is collapsible and shows all five states', async ({
  page,
}) => {
  const f = await fixture(page);
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.fill('שלום');
  await expect(
    page.getByRole('button', { name: 'Send to Terminal in English', exact: true }),
  ).toBeDisabled();
  await expect(page.getByText('Not connected', { exact: false })).toBeVisible();
  await expect(page.locator('.claude-connection summary')).toContainText(
    'Connect this session to Gloss',
  );
  expect(f.setups()).toBe(0);
  await page.locator('.claude-connection summary').click();
  await page.getByRole('button', { name: 'Show connect command' }).click();
  await expect(page.getByRole('textbox', { name: 'Claude connect command' })).toContainText(
    '--resume',
  );
  expect(f.setups()).toBe(1);
  for (const [state, label] of [
    ['connecting', 'Connecting'],
    ['connected', 'Connected'],
    ['disconnected', 'Disconnected'],
    ['unsupported', 'Unsupported'],
  ]) {
    f.setState(state!);
    await expect(page.locator('.claude-connection summary')).toContainText(label!);
    if (state === 'connected')
      await expect(
        page.getByRole('button', { name: 'Send to Terminal in English', exact: true }),
      ).toBeEnabled();
    else
      await expect(
        page.getByRole('button', { name: 'Send to Terminal in English', exact: true }),
      ).toBeDisabled();
  }
  expect(f.actions).toEqual([]);
});
test('a peer-route send keeps edited Hebrew after an uncertain release and reload', async ({
  page,
}) => {
  const f = await fixture(page, undefined, undefined, { transport: 'peer' });
  await expect(page.locator('.route-line > summary')).toHaveText('Peer — limited');
  const input = page.getByRole('textbox', { name: 'Discuss with language assistant' });
  await input.fill('שלום לעולם');
  await page.getByRole('button', { name: 'Send to Terminal in English', exact: true }).click();
  await expect(page.getByText('Awaiting Claude confirmation', { exact: false })).toBeVisible();
  expect(f.actions.find((a) => a.type === 'send-composer')).toMatchObject({
    text: 'שלום לעולם',
  });
  expect(f.actions.find((a) => a.type === 'send-composer')).not.toHaveProperty('transport');
  await input.fill('טיוטה חדשה');
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toMatch(/may still arrive/);
    await dialog.accept();
  });
  await page.getByRole('button', { name: 'Release composer' }).click();
  await expect(page.getByRole('button', { name: 'Release composer' })).toHaveCount(0);
  await expect(input).toHaveValue('טיוטה חדשה');
  await page.reload();
  await expect(input).toHaveValue('טיוטה חדשה');
  await expect(
    page.getByRole('button', { name: 'Send to Terminal in English', exact: true }),
  ).toBeEnabled();
  expect(f.actions.filter((a) => a.type === 'send-composer')).toHaveLength(1);
});
test('a connected composer send leaves the route to the server and preserves uncertainty', async ({
  page,
}) => {
  const f = await fixture(page, 'connected');
  await page.getByRole('textbox', { name: 'Discuss with language assistant' }).fill('בדיקה');
  await page.getByRole('button', { name: 'Send to Terminal in English', exact: true }).click();
  await expect(page.getByText('Awaiting Claude confirmation', { exact: false })).toBeVisible();
  expect(f.actions.find((a) => a.type === 'send-composer')).toMatchObject({
    text: 'בדיקה',
  });
  expect(f.actions.find((a) => a.type === 'send-composer')).not.toHaveProperty('transport');
});
test('a prepared review sends through the peer route with the one Send button', async ({
  page,
}) => {
  const f = await fixture(page, undefined, undefined, { transport: 'peer' });
  f.snapshot.currentDraft = {
    id: 'review',
    revision: 1,
    target: f.snapshot.target,
    language: 'he',
    localizedText: 'בדיקה',
    englishText: 'Test',
    sourceRevision: 0,
  };
  await page.reload();
  await page.getByRole('button', { name: 'Resume review' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review instruction' });
  await expect(dialog.getByRole('button', { name: 'Send as peer' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Send to Terminal', exact: true }).click();
  await expect(dialog.getByText('Awaiting Claude confirmation', { exact: false })).toBeVisible();
  expect(f.actions.find((a) => a.type === 'send-review')).toMatchObject({
    draftId: 'review',
  });
  expect(f.actions.find((a) => a.type === 'send-review')).not.toHaveProperty('transport');
});

test('connected review uses channel and a failed send does not fall back or discard Hebrew edits', async ({
  page,
}) => {
  const f = await fixture(page, 'connected');
  f.snapshot.currentDraft = {
    id: 'review',
    revision: 1,
    target: f.snapshot.target,
    language: 'he',
    localizedText: 'בדיקה',
    englishText: 'Test',
    sourceRevision: 0,
  };
  await page.reload();
  await page.getByRole('button', { name: 'Resume review' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review instruction' });
  await dialog.getByRole('button', { name: 'Edit instruction', exact: true }).click();
  await dialog.getByRole('textbox').fill('הוראה ערוכה');
  const attempts: any[] = [];
  await page.route('**/api/sessions/*/actions', (route) => {
    attempts.push(route.request().postDataJSON());
    return route.fulfill({ status: 400, json: { error: 'Channel disconnected during send' } });
  });
  await dialog.getByRole('button', { name: 'Send to Terminal', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('disconnected');
  expect(attempts).toEqual([
    {
      type: 'send-review',
      draftId: 'review',
      revision: 1,
      localizedText: 'הוראה ערוכה',
    },
  ]);
  await dialog.getByRole('button', { name: 'Close review' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Resume review' }).click();
  await expect(dialog).toContainText('הוראה ערוכה');
  expect(attempts).toHaveLength(1);
});

test('connected sends keep file and image reference IDs and a read-only delivery check never resends', async ({
  page,
}) => {
  const f = await fixture(page, 'connected');
  const refs: any[] = [];
  await page.route('**/api/sessions/*/files', (route) => {
    const body = route.request().postDataJSON();
    const kind = body.mime.startsWith('image/') ? 'image' : 'file';
    const file = {
      id: kind + '-1',
      kind,
      name: body.name,
      mime: body.mime,
      index: 1,
      size: 12,
      sessionId: f.snapshot.id,
      path: '/private/reference',
      source: 'upload',
      worktreePath: '/project',
    };
    refs.push(file);
    return route.fulfill({ json: file });
  });
  await page.route('**/api/sessions/*/files/*/metadata', (route) =>
    route.fulfill({ json: refs.find((ref) => route.request().url().includes(ref.id)) }),
  );
  await page.getByLabel('Attach files', { exact: true }).setInputFiles([
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') },
    { name: 'shot.png', mimeType: 'image/png', buffer: Buffer.from('fixture') },
  ]);
  await expect(page.locator('.composer .attachment-card')).toHaveCount(2);
  await page
    .getByRole('textbox', { name: 'Discuss with language assistant' })
    .fill('בדוק את הקבצים');
  await page.getByRole('button', { name: 'Send to Terminal in English', exact: true }).click();
  await expect(page.getByText('Awaiting Claude confirmation', { exact: false })).toBeVisible();
  expect(f.actions.find((a) => a.type === 'send-composer')).toMatchObject({
    attachmentIds: ['file-1', 'image-1'],
  });
  expect(f.actions.find((a) => a.type === 'send-composer')).not.toHaveProperty('transport');
  await page.getByRole('button', { name: 'Check delivery', exact: true }).click();
  expect(f.actions.filter((a) => a.type === 'send-composer')).toHaveLength(1);
  expect(f.actions.some((a) => a.type === 'check-composer')).toBe(true);
  await expect(page.locator('.composer .attachment-card')).toHaveCount(2);
});

test('same-name destinations retain isolated status and late status cannot enable another session', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  for (const record of f.records) {
    record.target.agent = 'claude';
    record.projectName = 'Same name';
  }
  let finish: (() => void) | undefined;
  await context.route('**/api/sessions/*/claude-channel', async (route) => {
    if (route.request().url().includes('/A/')) {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return route.fulfill({ json: { state: 'connected' } });
    }
    return route.fulfill({ json: { state: 'setup-required' } });
  });
  await context.route('**/api/sessions/*/claude-route', (route) =>
    route.fulfill({
      json: route.request().url().includes('/A/')
        ? { transport: 'channel' }
        : { transport: null, reason: 'Gloss can’t reach this session yet.' },
    }),
  );
  await page.goto('/#capability=test');
  await expect.poll(() => !!finish).toBe(true);
  await selectSession(page, 'B');
  finish!();
  await page.getByRole('textbox', { name: 'Discuss with language assistant' }).fill('לסשן השני');
  await expect(page.locator('.claude-connection summary')).toContainText('Not connected');
  await expect(
    page.getByRole('button', { name: 'Send to Terminal in English', exact: true }),
  ).toBeDisabled();
  expect(f.calls.filter((a) => a.type === 'send-composer')).toHaveLength(0);
});

test('an already-open tab keeps edited text after another tab releases and sends with a new request ID', async ({
  page,
  context,
}) => {
  const f = await sessionFixture(context);
  f.records[0]!.target.agent = 'claude';
  const snapshot = f.snapshots.A;
  snapshot.composerDraft = {
    id: 'composer-old',
    revision: 1,
    target: snapshot.target,
    sourceRevision: 0,
    language: 'he',
    localizedText: 'original',
    englishText: 'original',
  };
  snapshot.deliveries = [
    {
      id: 'old',
      draftId: 'composer-old',
      revision: 1,
      target: snapshot.target,
      state: 'unconfirmed',
      englishText: 'original',
      transport: 'channel',
    },
  ];
  f.workspaces.A!.revision = 1;
  f.workspaces.A!.data.composer = 'original';
  f.workspaces.A!.data.composerAttempt = { requestId: 'old', text: 'original', attachmentIds: [] };
  await context.route('**/api/sessions/*/claude-channel', (route) =>
    route.fulfill({ json: { state: 'connected' } }),
  );
  await context.route('**/api/sessions/*/claude-route', (route) =>
    route.fulfill({ json: { transport: 'channel' } }),
  );
  let released!: () => void;
  const releaseDone = new Promise<void>((resolve) => {
    released = resolve;
  });
  await context.route('**/api/sessions/A/actions', async (route) => {
    const action = route.request().postDataJSON();
    if (action.type !== 'release-composer') return route.fallback();
    delete snapshot.composerDraft;
    f.workspaces.A!.data.composerAttempt = null;
    f.workspaces.A!.revision++;
    await route.fulfill({ json: { sessionId: 'A', sequence: ++f.sequences.A!, snapshot } });
  });
  await page.goto('/#capability=test');
  const other = await context.newPage();
  // Hold this tab's debounced save until the releasing tab's final workspace save,
  // so Keep local resolves one stable conflict rather than racing that extra write.
  await other.route('**/api/sessions/A/workspace', async (route) => {
    if (route.request().method() === 'PUT') await releaseDone;
    await route.fallback();
  });
  await other.goto('/#capability=test');
  const input = other.getByRole('textbox', { name: 'Discuss with language assistant' });
  await expect(input).toHaveValue('original');
  await input.fill('בקשה חדשה מהכרטיסייה הפתוחה');
  const releaseSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/sessions/A/workspace') &&
      response.request().method() === 'PUT' &&
      response.ok() &&
      response.request().postDataJSON().data.composerAttempt === null,
  );
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Release composer', exact: true }).click();
  await releaseSaved;
  released();
  await expect(other.getByText('Workspace changed in another tab')).toBeVisible();
  await other.getByRole('button', { name: 'Keep local', exact: true }).click();
  await expect(other.getByText('Workspace changed in another tab')).toHaveCount(0);
  await expect.poll(() => f.workspaces.A!.data.composerAttempt).toBeNull();
  await expect(input).toHaveValue('בקשה חדשה מהכרטיסייה הפתוחה');
  expect(f.calls.filter((action) => action.type === 'send-composer')).toHaveLength(0);
  await other.getByRole('button', { name: 'Send to Terminal in English', exact: true }).click();
  await expect
    .poll(() => f.calls.filter((action) => action.type === 'send-composer').length)
    .toBe(1);
  const sent = f.calls.find((action) => action.type === 'send-composer');
  expect(sent).toMatchObject({
    sessionId: 'A',
    text: 'בקשה חדשה מהכרטיסייה הפתוחה',
  });
  expect(sent.requestId).not.toBe('old');
  await other.close();
});

test('a working Claude keeps Send on the channel route; approval disables it', async ({ page }) => {
  const f = await fixture(page, 'connected', 'queued');
  f.snapshot.codingState = 'working';
  f.snapshot.capabilities = {
    sendWhileBusy: false,
    channelSendWhileBusy: true,
    fileReferences: true,
  };
  await page.reload();
  await page
    .getByRole('textbox', { name: 'Discuss with language assistant' })
    .fill('הודעה בזמן עבודה');
  await expect(
    page.getByRole('button', { name: 'Send to Terminal in English', exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole('button', { name: /Send as peer/ })).toHaveCount(0);
  f.snapshot.codingState = 'approval-required';
  await page.reload();
  await page.getByRole('textbox', { name: 'Discuss with language assistant' }).fill('הודעה');
  await expect(
    page.getByRole('button', { name: 'Send to Terminal in English', exact: true }),
  ).toBeDisabled();
});

test('walks an outside session from registration to the short command', async ({ page }) => {
  const f = await fixture(page);
  let registered = false;
  await page.route('**/api/claude/registration', async (route) => {
    if (route.request().method() === 'POST') registered = true;
    await route.fulfill({ json: { state: registered ? 'registered' : 'unregistered' } });
  });
  await page.route('**/api/sessions/*/claude-channel', (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: { state: 'setup-required' } });
    return route.fulfill({
      json: registered
        ? {
            kind: 'command',
            folder: '/project',
            command:
              'claude --resume 11111111-1111-4111-8111-111111111111 --dangerously-load-development-channels server:gloss',
            cdCommand:
              "cd '/project' && claude --resume 11111111-1111-4111-8111-111111111111 --dangerously-load-development-channels server:gloss",
          }
        : { kind: 'registration-required', registration: { state: 'unregistered' } },
    });
  });
  await page.locator('.claude-connection summary').click();
  await page.getByRole('button', { name: 'Show connect command' }).click();
  await expect(page.getByText('registers itself once with Claude Code')).toBeVisible();
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Claude connect command' })).toHaveValue(
    /--resume 11111111-1111-4111-8111-111111111111 --dangerously-load-development-channels server:gloss$/,
  );
  await expect(page.getByRole('button', { name: 'Copy with cd' })).toBeVisible();
  await expect(page.getByText('--mcp-config')).toHaveCount(0);
  expect(f.actions).toEqual([]);
});

test('explains peer sending and allows it for all sessions on an explicit click', async ({
  page,
}) => {
  await fixture(page, undefined, undefined, { transport: 'peer' });
  let user = 'unset';
  const posts: unknown[] = [];
  await page.route('**/api/sessions/*/claude-peer', async (route) => {
    if (route.request().method() === 'POST') {
      posts.push(route.request().postDataJSON());
      user = 'accept';
    }
    await route.fulfill({ json: { user } });
  });
  await page.locator('.route-line > summary').click();
  await page.getByText('How to allow', { exact: true }).click();
  await page.getByRole('button', { name: 'Allow for all sessions' }).click();
  await expect(page.getByRole('button', { name: 'Allow for all sessions' })).toHaveCount(0);
  await expect(page.getByText('Messages from your other sessions').first()).toBeVisible();
  expect(posts).toEqual([{ action: 'accept' }]);
});

test('a forced peer setting shows the reason instead of the allow button', async ({ page }) => {
  await fixture(page, undefined, undefined, { transport: 'peer' });
  await page.route('**/api/sessions/*/claude-peer', (route) =>
    route.fulfill({ json: { user: 'unset', forcedBy: 'repository', forced: 'hold' } }),
  );
  await page.locator('.route-line > summary').click();
  await page.getByText('How to allow', { exact: true }).click();
  await expect(page.getByText('by your repository', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow for all sessions' })).toHaveCount(0);
});

test('peer send stays available while Claude works when Claude queues peer messages', async ({
  page,
}) => {
  const f = await fixture(page, 'connected', 'queued', { transport: 'peer' });
  f.snapshot.codingState = 'working';
  f.snapshot.capabilities = {
    sendWhileBusy: false,
    channelSendWhileBusy: true,
    peerSendWhileBusy: true,
    fileReferences: true,
  };
  await page.reload();
  await page
    .getByRole('textbox', { name: 'Discuss with language assistant' })
    .fill('הודעה בזמן עבודה');
  await expect(
    page.getByRole('button', { name: 'Send to Terminal in English', exact: true }),
  ).toBeEnabled();
});
