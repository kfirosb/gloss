// Captures Claude Code's input box from ONE throwaway session for the tmux delivery fixtures
// (docs/superpowers/plans/2026-10-16-gloss-tmux-delivery.md, Task 1). Runs Claude under a fake HOME in a
// private tmux server inside that home, in a scratch project, with Haiku, no MCP servers and
// --permission-mode default (these versions otherwise start in auto mode and never show the permission prompt).
// It reads ~/.claude.json (copied into the fake home) and links ~/Library/Keychains for the login; it never
// writes to the real home. Usage: node scripts/probes/capture-claude-input-screens.mjs <version> <fake home> [long]
// The `long` mode captures only claude-typed-long-<version>.jsonl: where Claude starts collapsing a paste to a chip,
// and how it records long pastes and the attachment manifest once submitted (D-1, the `<pasted_content>` wrapper).
// The `stash` mode captures only the stash screens (plan 2b, Task 1): Ctrl+S with and without a stash, an empty and a
// filled box, while Claude works, with the @ popup open, and next to the Ctrl+Y hint. Each state also
// gets a .window.ansi: the rows from one above the cursor to 24 below it. It also saves the plain `typed` screen when
// that version has none, and the Ctrl+R history picker opened over a stash (`stash-history`).
// The `narrow` mode sends no message to the model: with a stash present it narrows the pane to each NARROW_WIDTHS
// width and captures an empty box, a box with text and the Ctrl+Y hint, then each permission mode (Shift+Tab) at the
// narrowest width, to show what Claude cuts from a footer too long for the pane (`narrow-<width>-…`).
// The `statusline` mode sends no message to the model either: it starts Claude with a three-row custom `statusLine`
// (STATUS_LINE_ROWS) and captures the rows it draws between the box's bottom rule and Claude's footer: an empty box,
// the box after Ctrl+S with no stash, typed text, a stash and the @ popup (`statusline-…`). No `/` menu capture: it
// lists the account's synced skills and plugins.
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

// Tests repeat these two texts verbatim (tests/adapters/tmux-fixtures.ts, CAPTURED).
const TYPED_MESSAGE = 'Reply with the single word OK.\nThis second line checks a multi-line paste.';
const BUSY_MESSAGE = 'After counting, also say DONE.';
const BUSY_PROMPT = 'Count from 1 to 60, one number per line.';
const PERMISSION_PROMPT = 'Run this shell command and nothing else: touch gloss-fixture.txt';
// Long mode (tests/adapters/tmux-fixtures.ts, CAPTURED_LONG): seven short lines, one 2,000-character line, and a
// message with Gloss's numbered attachment manifest (src/core/file-references.ts attachmentManifest).
const SEVEN_LINES = [
  'Reply with the single word OK.',
  ...Array.from({ length: 6 }, (_, i) => `Line ${i + 2} of a seven-line paste.`),
].join('\n');
const LONG_LINE = 'Reply with the single word OK.'.padEnd(2000, ' filler');
const MANIFEST_TEXT = 'Reply with the single word OK after reading the referenced files.';
// Stash mode (tests/adapters/tmux-fixtures.ts, CAPTURED_STASH).
const STASH_DRAFT = 'hello there';
const SECOND_DRAFT = 'second draft';
// Long enough that Haiku is still answering through the working captures (it counts to 150 in about 2 s).
const STASH_BUSY_PROMPT = 'Count from 1 to 1000, one number per line.';
const STASH_MESSAGE = 'Reply with the single word OK.';
// Rows below the cursor saved in each .window.ansi; Gloss reads at most this many (INPUT_ROWS_BELOW_CURSOR).
const WINDOW_BELOW = 24;
// Narrow mode: pane widths, widest first, and how many Shift+Tab presses cycle through the permission modes.
const NARROW_WIDTHS = [80, 60, 40];
const MODE_PRESSES = 3;
// Statusline mode (tests/adapters/tmux-fixtures.ts, STATUS_LINE_ROWS): the rows the custom status line prints.
const STATUS_LINE_ROWS = [
  '[Opus] | project git:(main)',
  'Context 7% | Usage 28%',
  '1 CLAUDE.md | 10 MCPs | 11 hooks',
];
const shellQuote = (text) => `'${text}'`;
// A 1x1 red PNG for the manifest's image reference.
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

const execFileAsync = promisify(execFile);
const [version, homeArgument, mode] = process.argv.slice(2);
if (
  !/^\d+\.\d+\.\d+$/.test(version ?? '') ||
  !homeArgument ||
  (mode && !['long', 'stash', 'narrow', 'statusline'].includes(mode))
)
  throw new Error(
    'Usage: capture-claude-input-screens.mjs <claude version> <fake home under /private/var> [long|stash|narrow|statusline]',
  );
const long = mode === 'long';
const narrow = mode === 'narrow';
const statusline = mode === 'statusline';
// Narrow and statusline modes drive the stash keys too.
const stash = mode === 'stash' || narrow || statusline;
const home = await realpath(homeArgument);
if (!home.startsWith('/private/var/'))
  throw new Error('The fake home must resolve under /private/var');
const claude = join(homedir(), '.local', 'share', 'claude', 'versions', version);
const tmux = '/opt/homebrew/bin/tmux';
const base = ['-u', '-S', join(home, 'cap.sock'), '-f', '/dev/null'];
const project = join(
  home,
  (long
    ? 'project-long-'
    : statusline
      ? 'project-statusline-'
      : stash
        ? 'project-stash-'
        : 'project-') + version.replaceAll('.', '-'),
);
const out = join(process.cwd(), 'tests', 'fixtures', 'tmux-screens');
const prefix = `claude-${version}`;
const sessionId = randomUUID();
const pane = '=cap:';
const env = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: home,
  LANG: 'en_US.UTF-8',
  TERM: 'xterm-256color',
  USER: process.env.USER ?? '',
};
const t = async (...args) => (await execFileAsync(tmux, [...base, ...args], { env })).stdout;
const ignoreExisting = (error) => {
  if (error.code !== 'EEXIST') throw error;
};

await mkdir(join(home, 'Library'), { recursive: true });
await symlink(join(homedir(), 'Library', 'Keychains'), join(home, 'Library', 'Keychains')).catch(
  ignoreExisting,
);
await copyFile(
  join(homedir(), '.claude.json'),
  join(home, '.claude.json'),
  constants.COPYFILE_EXCL,
).catch(ignoreExisting);
await mkdir(project, { recursive: true });
// The `@READ` popup needs a file to suggest.
if (stash) await writeFile(join(project, 'README.md'), 'hello\n');
await chmod(home, 0o700);
await mkdir(out, { recursive: true });

const plain = () => t('capture-pane', '-p', '-t', pane);
const styled = () => t('capture-pane', '-e', '-p', '-t', pane);
const cursor = async () =>
  (await t('display-message', '-p', '-t', pane, '#{cursor_x} #{cursor_y} #{pane_in_mode}')).trim();
const keys = (...names) => t('send-keys', '-t', pane, ...names);
const literal = (text) => t('send-keys', '-t', pane, '-l', '--', text);
async function paste(text) {
  execFileSync(tmux, [...base, 'load-buffer', '-b', 'gloss-capture', '-'], { env, input: text });
  await t('paste-buffer', '-p', '-r', '-d', '-b', 'gloss-capture', '-t', pane);
}
// A rule line above or below Claude's input box.
const RULE = /^─{20,}\s*$/;
// Text from the last `❯` line to the rule that closes the input box.
function promptBox(screen) {
  const lines = screen.split('\n');
  const at = lines.findLastIndex((line) => line.startsWith('❯'));
  if (at < 0) return '';
  const close = lines.findIndex((line, i) => i > at && RULE.test(line));
  return lines.slice(at, close < 0 ? undefined : close).join('\n');
}
const promptLine = (screen) =>
  screen
    .split('\n')
    .filter((line) => line.startsWith('❯'))
    .at(-1) ?? '';
// Rows below the rule that closes the input box: Claude's footer (or a popup), where `› stashed` shows.
function footer(screen) {
  const lines = screen.split('\n');
  const at = lines.findLastIndex((line) => line.startsWith('❯'));
  const close = lines.findIndex((line, i) => i > at && RULE.test(line));
  return at < 0 || close < 0 ? '' : lines.slice(close + 1).join('\n');
}
const stashShown = (screen) => /›\s*stashed/.test(footer(screen));
const below = (screen, pattern) => {
  const lines = screen.split('\n');
  const at = lines.findLastIndex((line) => line.startsWith('❯'));
  return at >= 0 && lines.slice(at + 1).some((line) => pattern.test(line));
};
const summary = [];
const latencies = [];
async function saveStash(name) {
  await save(name);
  const [x, y] = (await cursor()).split(' ').map(Number);
  const window = await t(
    'capture-pane',
    '-e',
    '-p',
    '-S',
    String(Math.max(0, y - 1)),
    '-E',
    String(y + WINDOW_BELOW),
    '-t',
    pane,
  );
  await writeFile(join(out, `${prefix}-${name}.window.ansi`), window);
  const screen = await plain();
  const lastText = screen.split('\n').findLastIndex((line) => line.trim() !== '');
  summary.push({
    name,
    cursor: `${x} ${y}`,
    marker: stashShown(screen),
    rowsBelowCursor: lastText - y,
    footer: screen.split('\n').slice(y + 2, lastText + 1),
  });
}
// Presses Ctrl+S and records how long Claude takes to show `ready` (the redraw KEY_SETTLE_MIN_MS rests on).
async function timedStash(label, ready) {
  const started = Date.now();
  await keys('C-s');
  for (;;) {
    if (ready(await plain())) return void latencies.push({ label, ms: Date.now() - started });
    if (Date.now() - started > 10_000) throw new Error(`Timed out waiting for ${label}`);
    await sleep(20);
  }
}
async function emptyBox() {
  for (let i = 0; i < 16; i++) await keys('BSpace');
  await until(
    (s) => inputBox(s) && !/@READ|\/mo|gone|second|hello/.test(promptLine(s)),
    'empty box',
    10_000,
  );
}
async function ensureStash() {
  if (stashShown(await plain())) return;
  await literal(STASH_DRAFT);
  await timedStash('ensure', (s) => stashShown(s) && !promptLine(s).includes(STASH_DRAFT));
}
// Claude is answering: its spinner line (`✢ Elucidating…`, later `✳ Beboppin'… (1s · ↓ 7 tokens)`) or the footer's
// interrupt hint. The footer drops that hint while the box has text, so the spinner is the sign to wait on.
const working = (screen) => /esc to interrupt|^[^\s❯⏺⎿]\s+[^\s…]+…/mu.test(screen);
const idle = (screen) => promptLine(screen) !== '' && !/esc to interrupt/.test(screen);
// The input box is on screen: a `❯` line directly under a rule, closed by a rule a few lines below, and no dialog
// footer. A dialog's own echoed `❯ /model` line satisfies `idle`, so closing a dialog must wait on this instead.
function inputBox(screen) {
  if (/Esc to cancel|Enter to confirm|Do you want to proceed\?/.test(screen)) return false;
  const lines = screen.split('\n');
  const at = lines.findLastIndex((line) => line.startsWith('❯'));
  return (
    at > 0 &&
    RULE.test(lines[at - 1]) &&
    lines.slice(at + 1, at + 6).some((line) => RULE.test(line))
  );
}
async function until(ready, label, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const screen = await plain();
    if (ready(screen)) return screen;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}:\n${screen}`);
    await sleep(300);
  }
}
async function save(name) {
  await sleep(700);
  await writeFile(join(out, `${prefix}-${name}.ansi`), await styled());
  await writeFile(join(out, `${prefix}-${name}.cursor`), (await cursor()) + '\n');
  console.log('captured', name);
}
async function transcriptRecords() {
  const projects = join(home, '.claude', 'projects');
  for (const dir of await readdir(projects).catch(() => [])) {
    const text = await readFile(join(projects, dir, `${sessionId}.jsonl`), 'utf8').catch(
      () => undefined,
    );
    if (text !== undefined)
      return text
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
  }
  return [];
}
const userText = (record) =>
  record.type === 'user' && !record.isMeta ? record.message?.content : undefined;
// The probe must not depend on the code under test, so a long paste counts as recorded when the record contains it.
const recorded = (record, text) => {
  const content = userText(record);
  return content === text || (long && typeof content === 'string' && content.includes(text));
};
// Waits until Claude recorded `text` as a user message and then ended a turn after it.
async function answered(text, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const records = await transcriptRecords();
    const at = records.findIndex((record) => recorded(record, text));
    const done = records
      .slice(at + 1)
      .some((r) => r.type === 'assistant' && r.message?.stop_reason === 'end_turn');
    if (at >= 0 && done && inputBox(await plain())) return;
    if (Date.now() > end) throw new Error(`Timed out waiting for the answer to: ${text}`);
    await sleep(500);
  }
}
// Keeps only the records the fixture tests parse (user, assistant, queued attachments) and scrubs the account
// identity, so no session context, email address, user name or home path reaches the committed fixture.
function scrubbedTranscript(records) {
  const kept = records.filter(
    (record) =>
      record.type === 'user' ||
      record.type === 'assistant' ||
      (record.type === 'attachment' && record.attachment?.type === 'queued_command'),
  );
  let text = kept.map((record) => JSON.stringify(record)).join('\n') + '\n';
  text = text.replaceAll(home, '/fixture/home').replaceAll(homedir(), '/fixture/real-home');
  text = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'user@example.com');
  if (env.USER) text = text.replace(new RegExp(env.USER, 'gi'), 'user');
  return text;
}
async function sessionRecord() {
  const dir = join(home, '.claude', 'sessions');
  for (const file of await readdir(dir).catch(() => [])) {
    const record = JSON.parse(await readFile(join(dir, file), 'utf8'));
    if (record.sessionId === sessionId) return record;
  }
  return undefined;
}
async function saveRecord(name) {
  const record = await sessionRecord();
  if (record === undefined) throw new Error('Session record not found');
  const kept = { status: record.status, waitingFor: record.waitingFor, version: record.version };
  await writeFile(
    join(out, `${prefix}-${name}.session.json`),
    JSON.stringify(kept, null, 2) + '\n',
  );
}
// The terminal route finds a session's pane by the record's pid, so it must be the pane's own process.
async function checkPanePid() {
  const panePid = Number((await t('display-message', '-p', '-t', pane, '#{pane_pid}')).trim());
  const end = Date.now() + 30_000;
  let record = await sessionRecord();
  while (record === undefined && Date.now() < end) {
    await sleep(300);
    record = await sessionRecord();
  }
  if (record === undefined) throw new Error('Session record not found');
  const same = record.pid === panePid;
  await writeFile(join(out, `${prefix}-pid.txt`), (same ? 'same' : 'different') + '\n');
  console.log('pane pid', panePid, 'record pid', record.pid);
  if (!same) throw new Error('pane pid differs from the session record pid');
}
async function clear(presses) {
  for (let i = 0; i < presses; i++) await keys('BSpace');
  const line = promptLine(await until(idle, 'cleared input'));
  if (/hello|line one|line two|Pasted|^❯ !/.test(line))
    throw new Error('Could not clear the input: ' + line);
}
// The input box shows a paste either as its text or as a `[Pasted text …]` chip.
const chipped = (screen) => /\[Pasted text/.test(promptBox(screen));
const drawn = (screen, text) => chipped(screen) || promptBox(screen).includes(text.slice(0, 12));
// Pastes `text`, reports whether Claude collapsed it to a chip, and clears the input again without sending.
async function chipFor(text) {
  await paste(text);
  const screen = await until((s) => drawn(s, text), 'paste drawn', 10_000);
  await sleep(500);
  const chip = chipped(await plain());
  await t('send-keys', '-t', pane, '-N', String(text.length + 10), 'BSpace');
  await until((s) => idle(s) && !/Probe|Pasted text/.test(promptBox(s)), 'probe cleared', 30_000);
  return chip || chipped(screen);
}
const linesOf = (count) =>
  Array.from({ length: count }, (_, i) => `Probe line ${i + 1}.`).join('\n');
const lineOf = (length) => 'Probe of one long line.'.padEnd(length, 'x');
// Smallest value in [low, high] for which `chip(value)` is true, assuming it is monotonic; undefined when none is.
async function threshold(low, high, chip) {
  if (!(await chip(high))) return undefined;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (await chip(middle)) high = middle;
    else low = middle + 1;
  }
  return low;
}
async function submit(text) {
  await paste(text);
  await until((s) => drawn(s, text), 'paste drawn', 10_000);
  await sleep(500);
  await keys('Enter');
  await answered(text, 120_000);
}
async function captureLong() {
  const lines = await threshold(2, 12, (count) => chipFor(linesOf(count)));
  const chars = await threshold(100, 3000, (length) => chipFor(lineOf(length)));
  console.log(`chip from ${lines} lines (short lines); from ${chars} characters (one line)`);
  await writeFile(join(project, 'note.txt'), 'The colour is red.\n');
  await writeFile(join(project, 'red.png'), RED_PNG);
  const reference = (kind, index, name) =>
    `${kind} ${index}: name=${JSON.stringify(name)} path=${JSON.stringify(join(project, name))} worktree=${JSON.stringify(project)}`;
  const manifest = [
    MANIFEST_TEXT,
    '',
    'References:',
    reference('File', 1, 'note.txt'),
    reference('Image', 1, 'red.png'),
    'Read the referenced files and inspect referenced images before responding.',
  ].join('\n');
  // Each side of both thresholds, then the three D-1 messages.
  const boundary = [];
  if (lines !== undefined) boundary.push(linesOf(lines - 1), linesOf(lines));
  if (chars !== undefined) boundary.push(lineOf(chars - 1), lineOf(chars));
  for (const text of [...boundary, SEVEN_LINES, LONG_LINE, manifest]) {
    await submit(text);
    const record = (await transcriptRecords()).findLast((r) => recorded(r, text));
    const content = userText(record);
    console.log(
      `${text.split('\n').length} lines, ${text.length} chars:`,
      content === text ? 'recorded as typed' : `recorded wrapped (${content.length} chars)`,
    );
  }
}
async function captureStash() {
  await saveStash('stash-empty');
  await keys('C-s');
  await sleep(700);
  if (stashShown(await plain()))
    throw new Error('Ctrl+S on an empty box with no stash showed a stash');
  await saveStash('stash-empty-after');
  await literal(STASH_DRAFT);
  await until((s) => promptLine(s).includes(STASH_DRAFT), 'draft typed', 10_000);
  await saveStash('stash-typed');
  // The plain `typed` screen (the same text, no stash) for versions the default mode never captured.
  if (!(await readFile(join(out, `${prefix}-typed.ansi`)).catch(() => undefined)))
    await save('typed');
  await timedStash('stash', (s) => stashShown(s) && !promptLine(s).includes(STASH_DRAFT));
  await saveStash('stash-stashed');
  await literal(SECOND_DRAFT);
  await until((s) => promptLine(s).includes(SECOND_DRAFT), 'second draft typed', 10_000);
  if (!stashShown(await plain()))
    throw new Error('The stash marker is gone while the box has text');
  await saveStash('stash-stashed-typed');
  await timedStash('replace', (s) => stashShown(s) && !promptLine(s).includes(SECOND_DRAFT));
  await saveStash('stash-replaced');
  await timedStash('pop', (s) => !stashShown(s) && promptLine(s).includes(SECOND_DRAFT));
  await saveStash('stash-popped');
  await timedStash('restash', (s) => stashShown(s) && !promptLine(s).includes(SECOND_DRAFT));
  await saveStash('stash-restashed');
  // Claude working with a stash present and an empty box. Submitting restores the stash first, so stash it again.
  await paste(STASH_BUSY_PROMPT);
  await until(
    (s) => promptBox(s).includes(STASH_BUSY_PROMPT.slice(0, 12)),
    'busy prompt pasted',
    10_000,
  );
  await keys('Enter');
  await until(
    (s) => working(s) && promptLine(s).includes(SECOND_DRAFT),
    'working, draft restored',
    30_000,
  );
  await timedStash('working', (s) => stashShown(s) && !promptLine(s).includes(SECOND_DRAFT));
  await saveStash('stash-working');
  await sleep(300);
  await saveStash('stash-working-later');
  if (!working(await plain())) throw new Error('Claude finished before the working captures');
  await paste(STASH_MESSAGE);
  await until((s) => promptBox(s).includes(STASH_MESSAGE.slice(0, 12)), 'message pasted', 10_000);
  await sleep(500);
  await keys('Enter');
  await until(
    (s) => promptLine(s).includes(SECOND_DRAFT) && !stashShown(s),
    'stash restored on queue',
    10_000,
  );
  await saveStash('stash-restored');
  await answered(STASH_BUSY_PROMPT, 180_000);
  await answered(STASH_MESSAGE, 180_000);
  // Popups, each with a stash present underneath.
  await emptyBox();
  await ensureStash();
  await literal('@READ');
  await until((s) => below(s, /README\.md/), 'file popup', 10_000);
  await saveStash('stash-at-popup');
  await keys('C-s');
  await sleep(700);
  await saveStash('stash-at-popup-after');
  if (below(await plain(), /README\.md/)) await keys('Escape');
  // No `/` menu capture: it lists the account's synced skills and plugins. Like the @ popup, it replaces the footer.
  await emptyBox();
  await ensureStash();
  await literal('gone');
  await keys('C-u');
  await until((s) => /Ctrl\+Y/i.test(s), 'Ctrl+Y hint', 10_000);
  await saveStash('stash-ctrl-y');
  // The Ctrl+R history picker over a stash (spec 2.6: step 1 rules it out). Ctrl+S is not pressed in it.
  await keys('C-r');
  await until((s) => /search prompts|bck-i-search/i.test(s), 'history picker', 10_000);
  await saveStash('stash-history');
  await keys('Escape');
  console.log(JSON.stringify({ version, summary, latencies }, null, 2));
  await writeFile(
    join(home, `stash-summary-${version}.json`),
    JSON.stringify({ summary, latencies }, null, 2),
  );
}
async function captureNarrow() {
  await ensureStash();
  for (const width of NARROW_WIDTHS) {
    await t('resize-window', '-t', '=cap', '-x', String(width));
    await sleep(700);
    await emptyBox();
    await saveStash(`narrow-${width}-stash-empty`);
    await literal(SECOND_DRAFT);
    await until((s) => promptLine(s).includes(SECOND_DRAFT), 'second draft typed', 10_000);
    await saveStash(`narrow-${width}-stash-typed`);
    await keys('C-u');
    await until((s) => /Ctrl\+Y/i.test(s), 'Ctrl+Y hint', 10_000);
    await saveStash(`narrow-${width}-stash-ctrl-y`);
  }
  const width = NARROW_WIDTHS.at(-1);
  await emptyBox();
  for (let press = 1; press <= MODE_PRESSES; press++) {
    await keys('BTab');
    await sleep(700);
    await saveStash(`narrow-${width}-stash-mode-${press}`);
  }
  console.log(JSON.stringify({ version, summary }, null, 2));
  await writeFile(join(home, `narrow-summary-${version}.json`), JSON.stringify(summary, null, 2));
}
async function captureStatusline() {
  // The setting may take a render to apply; if the rows never show, the whole capture is meaningless, so fail.
  await until((s) => s.includes(STATUS_LINE_ROWS[2]), 'status line drawn', 30_000);
  await saveStash('statusline-empty');
  await keys('C-s');
  await sleep(700);
  await saveStash('statusline-empty-after');
  await literal(STASH_DRAFT);
  await until((s) => promptLine(s).includes(STASH_DRAFT), 'draft typed', 10_000);
  await saveStash('statusline-typed');
  await timedStash('statusline', (s) => stashShown(s) && !promptLine(s).includes(STASH_DRAFT));
  await saveStash('statusline-stashed');
  await literal('@READ');
  await until((s) => below(s, /README\.md/), 'popup', 10_000);
  await saveStash('statusline-at-popup');
  await emptyBox();
  console.log(JSON.stringify({ version, summary, latencies }, null, 2));
}
async function captureScreens() {
  await checkPanePid();
  await save('empty');
  await literal('hello there');
  await save('typed');
  await clear(30);
  await save('empty-after-edit');
  await literal('line one\\');
  await keys('Enter');
  await literal('line two');
  await save('multiline');
  await clear(40);
  await save('empty-after-multiline');
  await paste(Array.from({ length: 40 }, (_, i) => `pasted line ${i + 1}`).join('\n'));
  await save('pasted-chip');
  await clear(3);
  await save('empty-after-chip');
  await literal('!');
  await save('bash');
  await clear(2);
  await literal('/model');
  await sleep(500);
  await keys('Enter');
  await save('dialog');
  await saveRecord('dialog');
  await keys('Escape');
  await until((s) => inputBox(s) && !/Select model/.test(s), 'dialog closed');
  await paste(TYPED_MESSAGE);
  await until(
    (s) => /This second line checks|Pasted text/.test(promptBox(s)),
    'pasted message in the input box',
  );
  await keys('Enter');
  await answered(TYPED_MESSAGE, 120_000);
  await paste(BUSY_PROMPT);
  await keys('Enter');
  await sleep(1000);
  await literal(BUSY_MESSAGE);
  await save('working-typed');
  await keys('Enter');
  await save('working-queued');
  await answered(BUSY_MESSAGE, 180_000);
  await paste(PERMISSION_PROMPT);
  await keys('Enter');
  await until((s) => /Do you want to proceed\?/.test(s), 'permission prompt', 120_000);
  await save('permission');
  await saveRecord('permission');
  await keys('Escape');
  await until(inputBox, 'permission closed');
}

await t(
  'new-session',
  '-d',
  '-s',
  'cap',
  '-x',
  '200',
  '-y',
  '50',
  '-c',
  project,
  '--',
  '/usr/bin/env',
  '-i',
  ...Object.entries({ ...env, DISABLE_AUTOUPDATER: '1' }).map(([k, v]) => `${k}=${v}`),
  claude,
  '--session-id',
  sessionId,
  '--model',
  'haiku',
  '--permission-mode',
  'default',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  ...(statusline
    ? [
        '--settings',
        JSON.stringify({
          statusLine: {
            type: 'command',
            command: `printf '%s\\n' ${STATUS_LINE_ROWS.map(shellQuote).join(' ')}`,
            padding: 0,
          },
        }),
      ]
    : []),
);
try {
  const first = await until((s) => idle(s) || /Yes, I trust this folder/.test(s), 'startup');
  if (/Yes, I trust this folder/.test(first)) {
    if (!long && !stash) await save('trust');
    // The question opens on "No, exit"; move to the trust answer before confirming.
    await keys('Down');
    await until((s) => /❯ Yes, I trust this folder/.test(s), 'trust answer selected', 10_000);
    await keys('Enter');
  }
  await until(idle, 'input box');
  await (long
    ? captureLong()
    : narrow
      ? captureNarrow()
      : statusline
        ? captureStatusline()
        : stash
          ? captureStash()
          : captureScreens());
} finally {
  const records = await transcriptRecords();
  if (records.length && !narrow && !statusline)
    await writeFile(
      join(out, `claude-typed-${long ? 'long-' : stash ? 'stash-' : ''}${version}.jsonl`),
      scrubbedTranscript(records),
    );
  await t('kill-server').catch(() => undefined);
}
