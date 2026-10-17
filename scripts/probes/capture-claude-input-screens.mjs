// Captures Claude Code's input box from ONE throwaway session for the tmux delivery fixtures
// (docs/superpowers/plans/2026-10-16-gloss-tmux-delivery.md, Task 1). Runs Claude under a fake HOME in a
// private tmux server inside that home, in a scratch project, with Haiku, no MCP servers and
// --permission-mode default (these versions otherwise start in auto mode and never show the permission prompt).
// It reads ~/.claude.json (copied into the fake home) and links ~/Library/Keychains for the login; it never
// writes to the real home. Usage: node scripts/probes/capture-claude-input-screens.mjs <version> <fake home> [long]
// The `long` mode captures only claude-typed-long-<version>.jsonl: where Claude starts collapsing a paste to a chip,
// and how it records long pastes and the attachment manifest once submitted (D-1, the `<pasted_content>` wrapper).
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
// A 1x1 red PNG for the manifest's image reference.
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

const execFileAsync = promisify(execFile);
const [version, homeArgument, mode] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !homeArgument || (mode && mode !== 'long'))
  throw new Error(
    'Usage: capture-claude-input-screens.mjs <claude version> <fake home under /private/var> [long]',
  );
const long = mode === 'long';
const home = await realpath(homeArgument);
if (!home.startsWith('/private/var/'))
  throw new Error('The fake home must resolve under /private/var');
const claude = join(homedir(), '.local', 'share', 'claude', 'versions', version);
const tmux = '/opt/homebrew/bin/tmux';
const base = ['-u', '-S', join(home, 'cap.sock'), '-f', '/dev/null'];
const project = join(home, (long ? 'project-long-' : 'project-') + version.replaceAll('.', '-'));
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
);
try {
  const first = await until((s) => idle(s) || /Yes, I trust this folder/.test(s), 'startup');
  if (/Yes, I trust this folder/.test(first)) {
    if (!long) await save('trust');
    // The question opens on "No, exit"; move to the trust answer before confirming.
    await keys('Down');
    await until((s) => /❯ Yes, I trust this folder/.test(s), 'trust answer selected', 10_000);
    await keys('Enter');
  }
  await until(idle, 'input box');
  await (long ? captureLong() : captureScreens());
} finally {
  const records = await transcriptRecords();
  if (records.length)
    await writeFile(
      join(out, `claude-typed-${long ? 'long-' : ''}${version}.jsonl`),
      scrubbedTranscript(records),
    );
  await t('kill-server').catch(() => undefined);
}
