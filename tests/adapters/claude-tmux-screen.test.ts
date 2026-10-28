import { describe, expect, it } from 'vitest';
import { classifyScreen, markersFor } from '../../src/runtime/attention-markers.js';
import {
  inputWindowRows,
  parseStyledScreen,
  readInputBox,
  readInputWindow,
  screenText,
  type ScreenLine,
} from '../../src/agents/claude/tmux-screen.js';
import { MAX_PANE_ROW } from '../../src/runtime/tmux.js';
import {
  FIXTURE_VERSIONS,
  NARROW_ONE_ROW_FOOTERS,
  NARROW_READINGS,
  STASH_FIXTURE_VERSIONS,
  STASH_READINGS,
  STATUSLINE_FIXTURE_VERSIONS,
  STATUSLINE_READINGS,
  STATUSLINE_UNREADABLE,
  STATUS_LINE_ROWS,
  readCursor,
  readScreen,
  readWindow,
} from './tmux-fixtures.js';

const parsed = (screen: string): ScreenLine[] => {
  const lines = parseStyledScreen(screen);
  if (!lines) throw new Error('screen did not parse');
  return lines;
};
// Synthetic screens: they only exercise the parser. Claude's real screens are the captured fixtures below.
const rule = '─'.repeat(40);
const box = (prompt: string, footer = '  ? for shortcuts') =>
  `Claude says hi\n\n${rule}\n${prompt}\n${rule}\n${footer}\n`;

describe('styled screen parsing (synthetic)', () => {
  it('tracks dim, colour and inverse across escapes', () => {
    const [line] = parsed('\u001b[2mab\u001b[22mc\u001b[38;5;246md\u001b[39m\u001b[7me\u001b[0mf');
    expect(line?.map((cell) => [cell.char, cell.faint, cell.inverse])).toEqual([
      ['a', true, false],
      ['b', true, false],
      ['c', false, false],
      ['d', true, false],
      ['e', false, true],
      ['f', false, false],
    ]);
  });
  it('skips hyperlinks and refuses any other escape sequence', () => {
    expect(screenText(parsed('\u001b]8;;https://x\u001b\\link\u001b]8;;\u001b\\'))).toBe('link');
    expect(parseStyledScreen('\u001b[2Jcleared')).toBeUndefined();
  });
});
describe('Claude input box (synthetic)', () => {
  it('finds an empty box, with or without a dimmed placeholder under the cursor', () => {
    expect(readInputBox(parsed(box('❯ ')))).toEqual({ state: 'empty', row: 3, column: 2 });
    expect(readInputBox(parsed(box('❯')))).toEqual({ state: 'empty', row: 3, column: 2 });
    expect(
      readInputBox(parsed(box('❯ \u001b[7mT\u001b[27m\u001b[2mry "fix lint"\u001b[22m'))),
    ).toEqual({ state: 'empty', row: 3, column: 2 });
    expect(readInputBox(parsed(box('❯ \u001b[7m \u001b[27m')))).toEqual({
      state: 'empty',
      row: 3,
      column: 2,
    });
  });
  it('counts typed text, a lone inverted letter and multi-line input as not empty, bash and vim as another mode', () => {
    expect(readInputBox(parsed(box('❯ hello')))).toEqual({ state: 'not-empty' });
    expect(readInputBox(parsed(box('❯ \u001b[7ma\u001b[27m')))).toEqual({ state: 'not-empty' });
    expect(readInputBox(parsed(`${rule}\n❯ one\n  two\n${rule}\n`))).toEqual({
      state: 'not-empty',
    });
    expect(readInputBox(parsed(box('! ls')))).toEqual({ state: 'other-mode' });
    expect(readInputBox(parsed(box('❯ ', '  -- INSERT --')))).toEqual({ state: 'other-mode' });
    expect(readInputBox(parsed(`${rule}\n! one\n  two\n${rule}\n`))).toEqual({
      state: 'other-mode',
    });
  });
  it('counts typed text drawn dim, coloured or bold, and text after or apart from the placeholder, as not empty', () => {
    expect(readInputBox(parsed(box('❯ x')))).toEqual({ state: 'not-empty' });
    expect(readInputBox(parsed(box('❯ ')))).toEqual({ state: 'empty', row: 3, column: 2 });
    for (const prompt of [
      '❯ \u001b[38;5;141multrathink',
      '❯ \u001b[2m\u001b[1mX',
      '❯ \u001b[2mTry "fix lint"\u001b[22m visible',
      '❯ \u001b[38;5;246mTry "fix lint"\u001b[39m',
      '❯  \u001b[2mTry "fix lint"\u001b[22m',
      '❯ \u001b[7ma\u001b[27m\u001b[2m\u001b[1mbc',
      '❯ \u001b[2mTry\u001b[0m \u001b[2mthis\u001b[0m  x',
      '❯ \u001b[2mTry\u001b[0m  \u001b[2mthis\u001b[0m',
    ])
      expect(readInputBox(parsed(box(prompt))), prompt).toEqual({ state: 'not-empty' });
  });
  it('reads dim typed text at the caret as empty: by style alone it is the placeholder', () => {
    // Claude draws typed text in the default colour in every capture (the `typed` fixtures), and when text sits in
    // the box the terminal cursor is after it, not at the caret: the caller's cursor check (Task 6) is the guard here.
    expect(readInputBox(parsed(box('❯ \u001b[2mhello')))).toEqual({
      state: 'empty',
      row: 3,
      column: 2,
    });
  });
  it('reads a placeholder drawn word by word, with single plain spaces between, as empty', () => {
    expect(
      readInputBox(
        parsed(box('❯ \u001b[2mTry\u001b[0m \u001b[2m"fix\u001b[0m \u001b[2mlint"\u001b[0m')),
      ),
    ).toEqual({ state: 'empty', row: 3, column: 2 });
  });
  it('reports a missing box when the rules are absent', () => {
    expect(readInputBox(parsed('Do you want to proceed?\n ❯ 1. Yes\n'))).toEqual({
      state: 'missing',
    });
  });
  // Synthetic windows: row 0 is the row above the cursor, the cursor is on row 1, column 2.
  const window = (...rows: string[]) => parsed(rows.join('\n') + '\n');
  const footer = '  ? for shortcuts';
  /** Right-aligned like Claude's footer: its last cell two cells before the rule's edge. */
  const right = (text: string) => text.padStart(rule.length - 2);
  it('reads the stash marker only on the footer below the bottom rule, and an empty one-row box at the cursor', () => {
    expect(readInputWindow(window(rule, '❯ ', rule, '  › stashed'), 1, 2)).toEqual({
      readable: true,
      stashed: true,
      emptyAtPrompt: true,
    });
    expect(readInputWindow(window(rule, '❯ › stashed', rule, footer), 1, 13)).toEqual({
      readable: true,
      stashed: false,
      emptyAtPrompt: false,
    });
  });
  it('is not ready for a cursor elsewhere, a prompt-less row or vim mode', () => {
    expect(readInputWindow(window(rule, '❯ ', rule, footer), 1, 3)).toMatchObject({
      readable: true,
      emptyAtPrompt: false,
    });
    expect(readInputWindow(window('  one', '  two', rule, footer), 1, 5)).toMatchObject({
      readable: true,
      emptyAtPrompt: false,
    });
    expect(readInputWindow(window(rule, '❯ ', rule, '  -- INSERT --'), 1, 2)).toMatchObject({
      readable: true,
      emptyAtPrompt: false,
    });
  });
  it('cannot read a window whose rows under the cursor are not a rule and then a footer', () => {
    // No bottom rule right under the cursor: no rule at all, or a box that continues below the cursor.
    expect(readInputWindow(window(rule, '❯ ', '', ''), 1, 2)).toEqual({ readable: false });
    expect(readInputWindow(window(rule, '❯ ', '  more', rule), 1, 2)).toEqual({ readable: false });
    // A popup or menu in the footer's place: an `@` file list (one match), a `/` command list, nothing at all.
    expect(readInputWindow(window(rule, '❯ @READ', rule, '    + README.md'), 1, 7)).toEqual({
      readable: false,
    });
    expect(
      readInputWindow(
        window(rule, '❯ /mo', rule, '  ❯ /model   Set the AI model', '    /mobile'),
        1,
        5,
      ),
    ).toEqual({ readable: false });
    expect(readInputWindow(window(rule, '❯ ', rule, ''), 1, 2)).toEqual({ readable: false });
    // A row under the footer that is not its right side moved down: not right-aligned, or shaped like a popup row.
    // A second row shaped like a footer row is a status line, not a moved right side.
    expect(readInputWindow(window(rule, '❯ ', rule, footer, '  › stashed'), 1, 2)).toEqual({
      readable: true,
      stashed: true,
      emptyAtPrompt: true,
    });
    expect(
      readInputWindow(window(rule, '❯ ', rule, footer, right('    + README.md')), 1, 2),
    ).toEqual({
      readable: false,
    });
    expect(readInputWindow(window(rule, '❯ ', rule, footer, right('  /mobile')), 1, 2)).toEqual({
      readable: false,
    });
    // A moved right side with a row under it that is not blank: neither a footer nor a status row.
    expect(
      readInputWindow(window(rule, '❯ ', rule, footer, right('› stashed'), '    + more'), 1, 2),
    ).toEqual({ readable: false });
  });
  it("reads the footer's right side moved to the row under it, as Claude draws it on a narrow pane", () => {
    expect(
      readInputWindow(window(rule, '❯ ', rule, footer, right('◐ medium · › stashed')), 1, 2),
    ).toEqual({
      readable: true,
      stashed: true,
      emptyAtPrompt: true,
    });
    expect(
      readInputWindow(window(rule, '❯ ', rule, footer, right('◐ medium · /effort')), 1, 2),
    ).toEqual({
      readable: true,
      stashed: false,
      emptyAtPrompt: true,
    });
  });
  it("reads a footer on the pane's last row, with nothing captured below it", () => {
    expect(readInputWindow(parsed([rule, '❯ ', rule, '  › stashed'].join('\n')), 1, 2)).toEqual({
      readable: true,
      stashed: true,
      emptyAtPrompt: true,
    });
    expect(
      readInputWindow(parsed([rule, '❯ ', rule, footer, right('› stashed')].join('\n')), 1, 2),
    ).toEqual({ readable: true, stashed: true, emptyAtPrompt: true });
  });
  it("anchors the window one row above the cursor, never above the pane, and runs it to the pane's bottom", () => {
    expect(inputWindowRows(6)).toEqual({ start: 5, end: MAX_PANE_ROW });
    expect(inputWindowRows(0)).toEqual({ start: 0, end: MAX_PANE_ROW });
  });
  const status = [
    '  [Opus] | project git:(main)',
    '  Context 7% | Usage 28%',
    '  1 CLAUDE.md | 10 MCPs | 11 hooks',
  ];
  it('reads Claude’s footer under a custom status line of several rows', () => {
    expect(readInputWindow(window(rule, '❯ ', rule, ...status, footer), 1, 2)).toEqual({
      readable: true,
      stashed: false,
      emptyAtPrompt: true,
    });
    expect(
      readInputWindow(window(rule, '❯ ', rule, ...status, '  ⏵⏵ auto mode on · › stashed'), 1, 2),
    ).toEqual({ readable: true, stashed: true, emptyAtPrompt: true });
    expect(readInputWindow(window(rule, '❯ hello', rule, ...status, footer), 1, 7)).toMatchObject({
      readable: true,
      emptyAtPrompt: false,
    });
    // Narrow pane: Claude’s own footer still moves its right side to the row under it, below the status rows.
    expect(
      readInputWindow(
        window(rule, '❯ ', rule, ...status, footer, right('◐ medium · › stashed')),
        1,
        2,
      ),
    ).toEqual({ readable: true, stashed: true, emptyAtPrompt: true });
  });
  it('still cannot read a popup or menu row anywhere under the rule, or more rows than a footer can have', () => {
    expect(
      readInputWindow(window(rule, '❯ @READ', rule, '    + README.md', ...status), 1, 7),
    ).toEqual({ readable: false });
    expect(
      readInputWindow(
        window(rule, '❯ /mo', rule, ...status, '  ❯ /model   Set the AI model'),
        1,
        5,
      ),
    ).toEqual({ readable: false });
    expect(readInputWindow(window(rule, '❯ ', rule, '  /Users/me/project', footer), 1, 2)).toEqual({
      readable: false,
    });
  });
  it('reads a status line of any height, down to the pane’s last row', () => {
    const tall = Array.from({ length: 12 }, (_, i) => `  status row ${i + 1}`);
    expect(readInputWindow(window(rule, '❯ ', rule, ...tall, footer), 1, 2)).toEqual({
      readable: true,
      stashed: false,
      emptyAtPrompt: true,
    });
    // Nothing captured under the footer: the pane ends there.
    expect(
      readInputWindow(parsed([rule, '❯ ', rule, ...tall, '  › stashed'].join('\n')), 1, 2),
    ).toEqual({ readable: true, stashed: true, emptyAtPrompt: true });
  });
  it('does not read a status row drawn as a rule as the box', () => {
    // A status line that draws its own rule: the last two rules on screen no longer frame the prompt.
    expect(
      readInputBox(parsed(`${rule}\n❯ \n${rule}\n  Context 7%\n${rule}\n${footer}\n`)),
    ).toEqual({ state: 'other-mode' });
  });
});

const EMPTY = [
  'empty',
  'empty-after-edit',
  'empty-after-multiline',
  'empty-after-chip',
  'working-queued',
] as const;
const NOT_EMPTY = ['typed', 'multiline', 'pasted-chip', 'working-typed'] as const;
describe.each(FIXTURE_VERSIONS)('captured Claude %s screens', (version) => {
  it.each(EMPTY)('reads %s as empty, with the terminal cursor right after the prompt', (state) => {
    const cursor = readCursor(version, state);
    expect(readInputBox(parsed(readScreen(version, state)))).toEqual({
      state: 'empty',
      row: cursor.y,
      column: cursor.x,
    });
    expect(cursor.inMode).toBe(false);
  });
  it.each(NOT_EMPTY)('reads %s as not empty', (state) => {
    expect(readInputBox(parsed(readScreen(version, state))).state).not.toBe('empty');
  });
  it('reads shell mode as another mode', () =>
    expect(readInputBox(parsed(readScreen(version, 'bash')))).toEqual({ state: 'other-mode' }));
  it('finds the permission prompt with the attention markers', () => {
    const table = markersFor('claude', version);
    expect(table).toBeDefined();
    if (table)
      expect(classifyScreen(table, screenText(parsed(readScreen(version, 'permission'))))).toBe(
        'approval',
      );
  });
});

describe.each(STASH_FIXTURE_VERSIONS)(
  'input window of captured Claude %s stash screens',
  (version) => {
    const read = (state: string, source?: 'window' | 'screen') => {
      const w = readWindow(version, state, source);
      return readInputWindow(parsed(w.text), w.cursorRow, w.cursorColumn);
    };
    it.each(Object.entries(STASH_READINGS))('reads %s', (state, reading) => {
      expect(read(state)).toEqual({ readable: true, ...reading });
    });
    it.each([...Object.keys(STASH_READINGS), 'stash-at-popup', 'stash-history'])(
      'reads %s the same from rows cut out of the full screen',
      (state) => {
        expect(read(state, 'screen')).toEqual(read(state));
      },
    );
    it("reads the same while Claude works, though the footer's notices may change between reads", () => {
      expect(read('stash-working-later')).toEqual(read('stash-working'));
    });
    it('cannot read the window while the `@` popup replaces the footer and hides the marker', () => {
      expect(read('stash-at-popup')).toEqual({ readable: false });
    });
    it('never reads a box ready to paste without the marker after Ctrl+S closed the popup', () => {
      expect(read('stash-at-popup-after')).toEqual({
        readable: true,
        stashed: true,
        emptyAtPrompt: true,
      });
    });
    it('cannot read the history picker, whose cursor is on the footer row', () => {
      expect(read('stash-history')).toEqual({ readable: false });
    });
  },
);

describe.each(STASH_FIXTURE_VERSIONS)(
  'captured Claude %s stash screens on narrow panes',
  (version) => {
    const read = (state: string, source?: 'window' | 'screen') => {
      const w = readWindow(version, state, source);
      return readInputWindow(parsed(w.text), w.cursorRow, w.cursorColumn);
    };
    const states = Object.keys(NARROW_READINGS);
    it.each(Object.entries(NARROW_READINGS))('reads %s', (state, reading) => {
      expect(read(state)).toEqual(reading);
      expect(read(state, 'screen')).toEqual(read(state));
    });
    it.each(states)('keeps the stash marker whole on %s, cutting the notices first', (state) => {
      expect(screenText(parsed(readScreen(version, state)))).toMatch(/· › stashed *$/mu);
    });
    it('moves the marker to the row under the footer whenever the footer does not fit on one row', () => {
      for (const state of states) {
        const { y } = readCursor(version, state);
        const rows = screenText(parsed(readScreen(version, state))).split('\n');
        const oneRow = NARROW_ONE_ROW_FOOTERS.includes(state);
        expect(rows[y + 2], state).toMatch(oneRow ? /› stashed/u : /^(?!.*stashed)/u);
        expect(rows[y + 3]?.trim(), state).toEqual(
          oneRow ? '' : expect.stringMatching(/› stashed$/u),
        );
        expect(rows[y + 4]?.trim(), state).toBe('');
      }
    });
  },
);

describe.each(STATUSLINE_FIXTURE_VERSIONS)(
  'captured Claude %s screens with a custom status line',
  (version) => {
    const read = (state: string) => {
      const w = readWindow(version, state);
      return readInputWindow(parsed(w.text), w.cursorRow, w.cursorColumn);
    };
    it.each(Object.entries(STATUSLINE_READINGS))('reads %s', (state, expected) => {
      expect(read(state)).toEqual({ readable: true, ...expected });
    });
    it.each(STATUSLINE_UNREADABLE)('cannot read %s', (state) => {
      expect(read(state)).toEqual({ readable: false });
    });
    it('sees every status row inside the window it reads', () => {
      const w = readWindow(version, 'statusline-empty');
      const text = screenText(parsed(w.text));
      for (const row of STATUS_LINE_ROWS) expect(text).toContain(row);
    });
  },
);
