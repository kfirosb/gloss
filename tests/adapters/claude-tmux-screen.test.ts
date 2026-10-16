import { describe, expect, it } from 'vitest';
import { classifyScreen, markersFor } from '../../src/runtime/attention-markers.js';
import {
  parseStyledScreen,
  readInputBox,
  screenText,
  type ScreenLine,
} from '../../src/agents/claude/tmux-screen.js';
import { FIXTURE_VERSIONS, readCursor, readScreen } from './tmux-fixtures.js';

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
  it('counts typed text, a lone inverted letter, multi-line input, bash and vim modes as not empty', () => {
    expect(readInputBox(parsed(box('❯ hello')))).toEqual({ state: 'not-empty' });
    expect(readInputBox(parsed(box('❯ \u001b[7ma\u001b[27m')))).toEqual({ state: 'not-empty' });
    expect(readInputBox(parsed(`${rule}\n❯ one\n  two\n${rule}\n`))).toEqual({
      state: 'not-empty',
    });
    expect(readInputBox(parsed(box('! ls')))).toEqual({ state: 'not-empty' });
    expect(readInputBox(parsed(box('❯ ', '  -- INSERT --')))).toEqual({ state: 'not-empty' });
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
});

const EMPTY = [
  'empty',
  'empty-after-edit',
  'empty-after-multiline',
  'empty-after-chip',
  'working-queued',
] as const;
const NOT_EMPTY = ['typed', 'multiline', 'pasted-chip', 'bash', 'working-typed'] as const;
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
  it('finds the permission prompt with the attention markers', () => {
    const table = markersFor('claude', version);
    expect(table).toBeDefined();
    if (table)
      expect(classifyScreen(table, screenText(parsed(readScreen(version, 'permission'))))).toBe(
        'approval',
      );
  });
});
