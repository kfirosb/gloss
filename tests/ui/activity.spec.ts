import { expect, test, type Page, type Route } from '@playwright/test';
import type {
  ActivityCall,
  ActivityEvent,
  ActivitySnapshot,
  ActivityTask,
} from '../../src/core/activity-contracts.js';
import type { CodingState, Target } from '../../src/core/contracts.js';
import { basicSnapshot, mockSession } from './session-fixture.js';

const claude: Target = { agent: 'claude', sessionRef: 'act-ref', projectId: '/project' };
const codex: Target = { agent: 'codex', sessionRef: 'act-ref', projectId: '/project' };

const task = (over: Partial<ActivityTask> & Pick<ActivityTask, 'id' | 'kind'>): ActivityTask => ({
  description: '',
  position: 0,
  depth: 0,
  status: 'running',
  ...over,
});
const call = (over: Partial<ActivityCall> & Pick<ActivityCall, 'id' | 'tool'>): ActivityCall => ({
  summary: '',
  input: '',
  position: 0,
  depth: 0,
  timestamp: '2026-10-18T14:02:00.000Z',
  ...over,
});
/** Depth-0 calls `c1..cN` at positions 10, 20, ... */
const calls = (count: number): ActivityCall[] =>
  Array.from({ length: count }, (_, index) =>
    call({
      id: `c${index + 1}`,
      tool: 'Bash',
      summary: `Step ${index + 1}`,
      input: `echo ${index + 1}`,
      position: (index + 1) * 10,
    }),
  );
const subagent = (over: Partial<ActivityTask> = {}) =>
  task({
    id: 'a1',
    kind: 'subagent',
    description: 'Re-review final fix wave',
    position: 15,
    agentType: 'general-purpose',
    model: 'opus',
    ...over,
  });
const background = (over: Partial<ActivityTask> = {}) =>
  task({
    id: 'b1',
    kind: 'background',
    description: 'Run the browser test suite',
    position: 25,
    command: 'npx playwright test',
    outputAvailable: true,
    ...over,
  });
const activity = (over: Partial<ActivitySnapshot> = {}): ActivitySnapshot => ({
  calls: calls(8),
  tasks: [subagent(), background()],
  running: 2,
  gaps: [],
  ...over,
});
const streamed: ActivityEvent = {
  kind: 'call',
  call: call({
    id: 's-grep',
    tool: 'Grep',
    summary: 'approvalSwitch in src',
    position: 40,
    depth: 1,
  }),
};
const sse = (events: unknown[]) => ({
  contentType: 'text/event-stream',
  body: events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''),
});

interface OpenOptions {
  target?: Target;
  codingState?: CodingState;
  value?: ActivitySnapshot;
  subagentEvents?: ActivityEvent[];
}
/** Opens the session; `push` sends a later snapshot over the session event stream. */
async function open(page: Page, options: OpenOptions = {}) {
  const {
    target = claude,
    codingState = 'idle',
    value = activity(),
    subagentEvents = [streamed],
  } = options;
  const snapshot = { ...basicSnapshot(), id: 'act', target, codingState, activity: value };
  await mockSession(page, () => snapshot);
  let events: Route | undefined;
  let sequence = 0;
  await page.route('**/api/sessions/*/events', (route) => {
    events = route;
  });
  await page.route('**/api/sessions/*/claude-channel', (route) =>
    route.fulfill({ json: { state: 'connected' } }),
  );
  await page.route('**/api/sessions/*/actions', (route) => {
    return route.fulfill({ json: { sessionId: snapshot.id, sequence: 1, snapshot } });
  });
  const streams: string[] = [];
  const windows: string[] = [];
  await page.route('**/activity/subagents/*/events', (route) => {
    streams.push(route.request().url().split('/').at(-2) ?? '');
    return route.fulfill(sse(subagentEvents));
  });
  await page.route('**/activity/tasks/*/output', (route) => {
    streams.push(route.request().url().split('/').at(-2) ?? '');
    // Raw colour codes, as a server log writes them; the page shows the plain text.
    const text = '\u001b[1mRunning\u001b[22m 279 tests\n';
    return route.fulfill(sse([{ kind: 'chunk', text, start: 8, end: 26 }]));
  });
  await page.route('**/activity/tasks/*/output?end=*', (route) => {
    const url = new URL(route.request().url());
    windows.push(url.pathname.split('/').at(-2) ?? '');
    const end = Number(url.searchParams.get('end'));
    return route.fulfill({
      json:
        end === 8
          ? { text: 'earlier\n', start: 0, end: 8, size: 100 }
          : { text: '\u001b[32mAll 12 passed\u001b[0m\n', start: 8, end: 22, size: 22 },
    });
  });
  await page.goto('/#capability=test');
  const push = async (next: ActivitySnapshot, state: CodingState = codingState) => {
    await expect.poll(() => events !== undefined).toBe(true);
    const route = events!;
    events = undefined;
    sequence++;
    await route.fulfill(
      sse([
        {
          sessionId: snapshot.id,
          sequence,
          snapshot: { ...snapshot, codingState: state, activity: next },
        },
      ]),
    );
  };
  return { streams, windows, push };
}
const activityRadio = (page: Page) =>
  page
    .getByRole('radiogroup', { name: 'Live Conversation view' })
    .getByRole('radio', { name: /^Activity/ });

test('shows the strip, the active cards and the last five actions newest first', async ({
  page,
}) => {
  const { streams } = await open(page);
  await expect(activityRadio(page)).toHaveText('Activity2');
  await activityRadio(page).click();
  const view = page.locator('.activity');
  const strip = view.locator('section.activity-strip[aria-label="Background commands"]');
  const row = strip.locator('.activity-strip-row[data-task="b1"]');
  await expect(row.locator('code')).toHaveText('npx playwright test');
  await expect(row.locator('.activity-last-line')).toHaveText('Running 279 tests');

  const cards = view.locator('article.activity-agent');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toHaveAttribute('data-agent', 'main');
  await expect(cards.nth(1)).toHaveAttribute('data-agent', 'a1');
  const main = view.locator('[data-agent="main"]');
  await expect(main.locator('.activity-tag')).toHaveText('main');
  const rows = main.locator('.activity-row[data-call]');
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toHaveAttribute('data-call', 'c8');
  await main.getByRole('button', { name: 'Show earlier actions (3)' }).click();
  await expect(rows).toHaveCount(8);
  await expect(rows.last()).toHaveAttribute('data-call', 'c1');
  await main.getByRole('button', { name: 'Show fewer' }).click();
  await expect(rows).toHaveCount(5);

  const card = view.locator('[data-agent="a1"]');
  await expect(card.locator('.activity-tag')).toHaveText('subagent');
  await expect(card.locator('.activity-meta').first()).toContainText('general-purpose · opus');
  await expect(card.locator('[data-call="s-grep"]')).toContainText('approvalSwitch in src');

  const failedRow = main.locator('[data-call="c8"]');
  const toggle = failedRow.getByRole('button');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(failedRow.locator('pre').first()).toHaveText('echo 8');

  await row.getByRole('button', { name: 'output' }).click();
  await expect(row.getByRole('button', { name: 'output' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  const tail = strip.locator('.activity-output pre');
  await expect(tail).toHaveText('Running 279 tests\n');
  await strip.getByRole('button', { name: 'Show earlier', exact: true }).click();
  await expect(tail).toHaveText('earlier\nRunning 279 tests\n');
  // The panel reads the strip's own tail: expanding opens no second stream.
  expect(streams.filter((id) => id === 'b1')).toEqual(['b1']);
  await expect(activityRadio(page)).toHaveText('Activity2');
});

test('the newest row is highlighted briefly', async ({ page }) => {
  const { push } = await open(page);
  await activityRadio(page).click();
  const main = page.locator('[data-agent="main"]');
  await expect(main.locator('[data-call="c8"]')).toBeVisible();
  const next = activity();
  next.calls.push(call({ id: 'c9', tool: 'Edit', summary: 'src/ui/live-view.ts', position: 90 }));
  await push(next, 'working');
  const newest = main.locator('[data-call="c9"]');
  await expect(newest).toHaveClass(/activity-row-new/);
  await expect
    .poll(async () => (await newest.getAttribute('class')) ?? '', { timeout: 3000 })
    .not.toContain('activity-row-new');
});

test('a finished subagent moves to History and keeps its actions', async ({ page }) => {
  const { streams, push } = await open(page);
  await activityRadio(page).click();
  const view = page.locator('.activity');
  await expect(view.locator('[data-agent="a1"] [data-call="s-grep"]')).toHaveCount(1);
  await expect.poll(() => streams.filter((id) => id === 'a1')).toEqual(['a1']);
  const opened = streams.length;
  await push(
    activity({
      tasks: [subagent({ status: 'finished', report: 'All **good**.' }), background()],
      running: 1,
    }),
  );
  const active = view.locator('article.activity-agent');
  await expect(active).toHaveCount(1);
  await expect(active).toHaveAttribute('data-agent', 'main');
  const toggle = view.locator('button.activity-history-toggle');
  await expect(toggle).toHaveText('History · 1 finished subagent');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const card = view.locator('.activity-history [data-agent="a1"]');
  await expect(card).toHaveAttribute('data-status', 'finished');
  await expect(card.locator('.activity-report strong')).toHaveText('good');
  await expect(card.locator('[data-call]')).toHaveCount(0);
  await card.getByRole('button', { name: /Re-review final fix wave/ }).click();
  await expect(card.locator('[data-call="s-grep"]')).toHaveCount(1);
  expect(streams.length).toBe(opened);
});

test('a subagent preempted while running streams again from History', async ({ page }) => {
  const commands = [1, 2, 3].map((index) =>
    background({ id: `b${index}`, description: `Command ${index}`, position: 100 + index }),
  );
  const { streams, push } = await open(page, {
    value: activity({ tasks: [subagent(), ...commands], running: 4 }),
  });
  await activityRadio(page).click();
  const view = page.locator('.activity');
  await expect(view.locator('[data-agent="a1"] [data-call="s-grep"]')).toHaveCount(1);
  for (const id of ['b1', 'b2', 'b3']) {
    await view
      .locator(`.activity-strip-row[data-task="${id}"]`)
      .getByRole('button', { name: 'output' })
      .click();
  }
  await expect.poll(() => streams.filter((id) => id.startsWith('b')).length).toBeGreaterThan(2);
  await page.waitForTimeout(300);
  const opened = streams.filter((id) => id === 'a1').length;
  expect(opened).toBe(1);
  await push(
    activity({
      tasks: [
        subagent({ status: 'finished', report: 'Done.' }),
        ...commands.map((command) => ({ ...command, status: 'finished' as const })),
      ],
      running: 0,
    }),
  );
  await expect(view.locator('article.activity-agent')).toHaveCount(1);
  await view.locator('button.activity-history-toggle').click();
  const card = view.locator('.activity-history [data-agent="a1"]');
  await card.getByRole('button', { name: /Re-review final fix wave/ }).click();
  await expect(card.locator('[data-call="s-grep"]')).toHaveCount(1);
  expect(streams.filter((id) => id === 'a1')).toHaveLength(2);
});

test('finished commands show their output once', async ({ page }) => {
  const { streams, windows } = await open(page, {
    value: activity({
      tasks: [background({ id: 'b0', status: 'finished', finishedAt: '2026-10-18T14:03:00Z' })],
      running: 0,
    }),
  });
  await activityRadio(page).click();
  const view = page.locator('.activity');
  await expect(view.locator('section.activity-strip')).toHaveCount(0);
  const toggle = view.locator('button.activity-history-toggle');
  await expect(toggle).toHaveText('History · 1 finished command');
  await toggle.click();
  const row = view.locator('.activity-history .activity-strip-row[data-task="b0"]');
  await expect(row).toHaveAttribute('data-status', 'finished');
  await expect(row.locator('code')).toHaveText('npx playwright test');
  await row.getByRole('button', { name: 'output' }).click();
  const panel = view.locator('.activity-history .activity-output pre');
  await expect(panel).toHaveText('All 12 passed\n');
  expect(windows).toEqual(['b0']);
  await view
    .locator('.activity-history')
    .getByRole('button', { name: 'Show earlier', exact: true })
    .click();
  await expect(panel).toHaveText('earlier\nAll 12 passed\n');
  expect(streams).toEqual([]);
});

test('five running commands take three slots and the rest show an ellipsis', async ({ page }) => {
  const commands = [1, 2, 3, 4, 5].map((index) =>
    background({ id: `b${index}`, description: `Command ${index}`, position: index * 100 }),
  );
  const { streams } = await open(page, {
    value: activity({ calls: calls(2), tasks: commands, running: 5 }),
  });
  await activityRadio(page).click();
  const rows = page.locator('section.activity-strip .activity-strip-row');
  await expect(rows).toHaveCount(5);
  await expect(rows.locator('.activity-last-line', { hasText: 'Running 279 tests' })).toHaveCount(
    3,
  );
  await expect(rows.locator('.activity-last-line', { hasText: /^…$/ })).toHaveCount(2);
  expect(streams).toHaveLength(3);
  await page.waitForTimeout(1000);
  expect(streams).toHaveLength(3);
});

test('a disconnected session greys everything and opens no stream', async ({ page }) => {
  const { streams } = await open(page, { codingState: 'disconnected' });
  await expect(activityRadio(page)).toHaveText('Activity');
  await activityRadio(page).click();
  const view = page.locator('.activity');
  const main = view.locator('[data-agent="main"]');
  await expect(main).toHaveAttribute('data-status', 'unknown');
  await expect(main.locator('.activity-meta').first()).toHaveText('Session disconnected');
  await expect(view.locator('[data-status="unknown"]:not([data-agent="main"])')).toHaveCount(2);
  await expect(view.locator('[data-agent="a1"]')).toHaveAttribute('data-status', 'unknown');
  await expect(view.locator('[data-task="b1"]')).toHaveAttribute('data-status', 'unknown');
  await expect(view.getByRole('button', { name: 'output' })).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(streams).toEqual([]);
});

test('the gap line follows the earlier actions', async ({ page }) => {
  const reason = 'Older activity is not shown; the lookback is bounded.';
  await open(page, { value: activity({ calls: calls(7), tasks: [], running: 0, gaps: [reason] }) });
  await activityRadio(page).click();
  const main = page.locator('[data-agent="main"]');
  await expect(main.locator('[data-call]')).toHaveCount(5);
  await expect(main.locator('.activity-gap')).toHaveCount(0);
  await main.getByRole('button', { name: 'Show earlier actions (2)' }).click();
  await expect(main.locator('.activity-gap')).toHaveText(reason);
  await expect(main.locator('.activity-row[data-call="c1"] + .activity-gap')).toHaveCount(1);
  await expect(page.getByText('No tool calls yet.')).toHaveCount(0);
});

test('Activity is only for Claude sessions', async ({ page }) => {
  await open(page, { target: codex });
  await expect(activityRadio(page)).toBeDisabled();
  await expect(activityRadio(page)).toHaveAttribute(
    'title',
    'Activity is available for Claude sessions',
  );
});

test('nested tasks stay inside the parent card and off the badge', async ({ page }) => {
  const nested: ActivityEvent = {
    kind: 'task-start',
    task: task({
      id: 'n1',
      kind: 'subagent',
      description: 'Check the reducer',
      position: 35,
      depth: 2,
      agentType: 'Explore',
    }),
  };
  await open(page, { subagentEvents: [nested, streamed] });
  await expect(activityRadio(page)).toHaveText('Activity2');
  await activityRadio(page).click();
  const card = page.locator('[data-agent="a1"]');
  const row = card.locator('[data-nested-task="n1"]');
  await expect(row).toContainText('Check the reducer');
  await expect(row).toContainText('Explore');
  await expect(row).toContainText('running');
  await expect(row).toContainText('nested ×2');
  await expect(card.locator('[data-call="s-grep"]')).toHaveCount(1);
  await expect(page.locator('article.activity-agent')).toHaveCount(2);
  await expect(page.locator('[data-agent="n1"]')).toHaveCount(0);
  await expect(page.locator('.activity-history')).toHaveCount(0);
  await expect(activityRadio(page)).toHaveText('Activity2');
});
