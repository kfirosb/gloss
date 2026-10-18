import { expect, test, type Page } from '@playwright/test';
import type {
  ActivityCall,
  ActivityEvent,
  ActivitySnapshot,
  ActivityTask,
} from '../../src/core/activity-contracts.js';
import type { Target } from '../../src/core/contracts.js';
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
const activity = (): ActivitySnapshot => ({
  calls: [
    call({
      id: 'c-read',
      tool: 'Read',
      summary: 'src/agents/claude/index.ts',
      input: '{\n  "file_path": "src/agents/claude/index.ts"\n}',
      position: 10,
      result: { text: 'file body', failed: false },
    }),
    call({
      id: 'c-bash',
      tool: 'Bash',
      summary: 'Run the unit tests',
      input: 'npx vitest run src/ui/live-view.test.ts',
      position: 20,
      result: { text: '1 failed, 14 passed', failed: true },
    }),
    call({ id: 'c-edit', tool: 'Edit', summary: 'src/ui/live-view.ts', position: 30 }),
  ],
  tasks: [
    task({
      id: 'a0',
      kind: 'subagent',
      description: 'Find every caller of toggleTerminal',
      position: 5,
      status: 'finished',
      agentType: 'Explore',
      report: 'Found three callers.',
      reportTranslation: { text: 'נמצאו שלושה קוראים.', status: 'complete' },
    }),
    task({
      id: 'a1',
      kind: 'subagent',
      description: 'Re-review final fix wave',
      position: 15,
      agentType: 'general-purpose',
      model: 'opus',
    }),
    task({
      id: 'b1',
      kind: 'background',
      description: 'Run the browser test suite',
      position: 25,
      command: 'npx playwright test',
      outputAvailable: true,
    }),
  ],
  running: 2,
  gaps: [],
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

async function open(page: Page, target: Target, codingState = 'idle', value = activity()) {
  const snapshot = { ...basicSnapshot(), id: 'act', target, codingState, activity: value };
  await mockSession(page, () => snapshot);
  await page.route('**/api/sessions/*/events', (route) => route.fulfill(sse([])));
  await page.route('**/api/sessions/*/claude-channel', (route) =>
    route.fulfill({ json: { state: 'connected' } }),
  );
  const translations: string[] = [];
  await page.route('**/api/sessions/*/actions', (route) => {
    const action = route.request().postDataJSON();
    if (action.type === 'translate-activity-report') translations.push(action.taskId);
    return route.fulfill({ json: { sessionId: snapshot.id, sequence: 1, snapshot } });
  });
  const streams: string[] = [];
  await page.route('**/activity/subagents/a1/events', (route) => {
    streams.push('a1');
    return route.fulfill(sse([streamed]));
  });
  await page.route('**/activity/tasks/b1/output', (route) => {
    streams.push('b1');
    return route.fulfill(sse([{ kind: 'chunk', text: 'Running 279 tests\n', start: 8, end: 26 }]));
  });
  await page.route('**/activity/tasks/b1/output?end=*', (route) =>
    route.fulfill({ json: { text: 'earlier\n', start: 0, end: 8, size: 100 } }),
  );
  await page.goto('/#capability=test');
  return { translations, streams };
}
const activityRadio = (page: Page) =>
  page
    .getByRole('radiogroup', { name: 'Live Conversation view' })
    .getByRole('radio', { name: /^Activity/ });

test('the Activity view shows running tasks, their streams and the tool timeline', async ({
  page,
}) => {
  const { translations } = await open(page, claude);
  await expect(activityRadio(page)).toHaveText('Activity2');
  await activityRadio(page).click();
  const view = page.locator('.activity');
  await expect(view.getByText('Running now')).toBeVisible();
  await expect(view.getByText('What Claude did')).toBeVisible();
  const cards = view.locator('[data-task]');
  await expect(cards).toHaveCount(3);
  await expect(cards.last()).toHaveAttribute('data-task', 'a0');
  await expect(cards.last()).toHaveAttribute('data-status', 'finished');

  const subagent = view.locator('[data-task="a1"]');
  await expect(subagent).toHaveAttribute('data-status', 'running');
  await expect(subagent).toContainText('general-purpose');
  await expect(subagent.locator('[data-call]')).toHaveCount(0);
  await subagent.getByRole('button', { name: /Re-review final fix wave/ }).click();
  await expect(subagent.locator('[data-call]')).toHaveCount(1);
  await expect(subagent.locator('[data-call="s-grep"]')).toContainText('approvalSwitch in src');

  const background = view.locator('[data-task="b1"]');
  await expect(background.locator('code')).toHaveText('npx playwright test');
  await background.getByRole('button', { name: 'Show output' }).click();
  const tail = background.locator('pre');
  await expect(tail).toHaveText('Running 279 tests\n');
  await background.getByRole('button', { name: 'Show earlier' }).click();
  await expect(tail).toHaveText('earlier\nRunning 279 tests\n');
  await expect(background.getByRole('button', { name: 'Show earlier' })).toHaveCount(0);
  await background.getByRole('button', { name: 'Hide output' }).click();
  await expect(tail).toHaveCount(0);

  const finished = view.locator('[data-task="a0"]');
  await expect(finished.locator('[dir="rtl"]')).toHaveText('נמצאו שלושה קוראים.');
  // The translated report needs no new translation request.
  expect(translations).toEqual([]);

  const rows = view.locator('.activity-main [data-call]');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toHaveAttribute('data-call', 'c-edit');
  const failed = view.locator('[data-call="c-bash"]');
  await expect(failed.locator('.activity-failed')).toHaveCount(1);
  await expect(view.locator('[data-call="c-read"] .activity-failed')).toHaveCount(0);
  const toggle = failed.getByRole('button');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(failed.locator('pre').first()).toHaveText('npx vitest run src/ui/live-view.test.ts');
  await expect(failed.locator('pre').last()).toHaveText('1 failed, 14 passed');
});

test('Activity is only for Claude sessions', async ({ page }) => {
  await open(page, codex);
  await expect(activityRadio(page)).toBeDisabled();
  await expect(activityRadio(page)).toHaveAttribute(
    'title',
    'Activity is available for Claude sessions',
  );
});

test('a disconnected session shows no running task and opens no stream', async ({ page }) => {
  const { streams } = await open(page, claude, 'disconnected');
  await expect(activityRadio(page)).toHaveText('Activity');
  await activityRadio(page).click();
  const subagent = page.locator('[data-task="a1"]');
  await expect(subagent).toHaveAttribute('data-status', 'unknown');
  await expect(subagent).toContainText('Session disconnected');
  const head = subagent.getByRole('button', { name: /Re-review final fix wave/ });
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await expect(subagent).toContainText('No live transcript.');
  const background = page.locator('[data-task="b1"]');
  await expect(background).toHaveAttribute('data-status', 'unknown');
  await expect(background.getByRole('button', { name: 'Show output' })).toHaveCount(0);
  await expect(page.locator('[data-task="a0"]')).toHaveAttribute('data-status', 'finished');
  expect(streams).toEqual([]);
});

test('a finished report is translated once when translation is on', async ({ page }) => {
  const value = activity();
  const finished = value.tasks.find((t) => t.id === 'a0');
  if (finished) delete finished.reportTranslation;
  const { translations } = await open(page, claude, 'idle', value);
  await activityRadio(page).click();
  await expect(page.locator('[data-task="a0"]')).toContainText('Found three callers.');
  await expect.poll(() => translations).toEqual(['a0']);
  await page.locator('[data-call="c-bash"]').getByRole('button').click();
  await page.locator('[data-call="c-bash"]').getByRole('button').click();
  expect(translations).toEqual(['a0']);
});

test('a nested task shows its depth', async ({ page }) => {
  const value = activity();
  const nested = value.tasks.find((t) => t.id === 'a1');
  if (nested) nested.depth = 2;
  await open(page, claude, 'idle', value);
  await activityRadio(page).click();
  await expect(page.locator('[data-task="a1"]')).toContainText('nested ×2');
  await expect(page.locator('[data-task="b1"]')).not.toContainText('nested');
});
