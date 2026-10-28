import { MAX_PANE_ROW } from '../../runtime/tmux.js';

/** One cell of a `capture-pane -e` line: its character and how it is drawn. */
export interface ScreenCell {
  char: string;
  /** Dimmed or drawn in a colour other than the default foreground: Claude's placeholder and hints. */
  faint: boolean;
  /** Reverse video: Claude draws its own cursor this way. */
  inverse: boolean;
  /** Drawn with a foreground or background colour, or an attribute other than dim and reverse (bold, underline, …). */
  decorated: boolean;
}
export type ScreenLine = ScreenCell[];

const ESC = '\u001b';
const SGR = /\u001b\[([0-9;:]*)m/y;
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/y;
interface Style {
  dim: boolean;
  defaultForeground: boolean;
  defaultBackground: boolean;
  inverse: boolean;
  /** Other SGR attributes still switched on (bold, italic, underline, …); unknown codes stay on until a full reset. */
  attributes: ReadonlySet<number>;
}
const PLAIN: Style = {
  dim: false,
  defaultForeground: true,
  defaultBackground: true,
  inverse: false,
  attributes: new Set(),
};
/** SGR codes that switch attributes off, and the attributes each one ends. */
const ATTRIBUTE_RESETS = new Map<number, readonly number[]>([
  [22, [1]],
  [23, [3]],
  [24, [4, 21]],
  [25, [5, 6]],
  [28, [8]],
  [29, [9]],
  [55, [53]],
  [59, [58]],
]);
const isForeground = (n: number) => (n >= 30 && n <= 37) || (n >= 90 && n <= 97);
const isBackground = (n: number) => (n >= 40 && n <= 47) || (n >= 100 && n <= 107);

function applySgr(style: Style, params: string): Style {
  const codes = params === '' ? ['0'] : params.split(';');
  let next = { ...style };
  const attributes = new Set(style.attributes);
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i] ?? '';
    const head = code.split(':')[0] ?? '';
    const n = Number(head);
    if (head === '' || n === 0) {
      next = { ...PLAIN };
      attributes.clear();
    } else if (n === 2) next.dim = true;
    else if (n === 22) {
      next.dim = false;
      attributes.delete(1);
    } else if (n === 7) next.inverse = true;
    else if (n === 27) next.inverse = false;
    else if (isForeground(n)) next.defaultForeground = false;
    else if (n === 39) next.defaultForeground = true;
    else if (isBackground(n)) next.defaultBackground = false;
    else if (n === 49) next.defaultBackground = true;
    else if (n === 38 || n === 48 || n === 58) {
      if (n === 38) next.defaultForeground = false;
      else if (n === 48) next.defaultBackground = false;
      else attributes.add(n);
      // 38;5;n and 38;2;r;g;b carry their colour in the following parameters; 38:5:n carries it in this one.
      if (!code.includes(':')) i += codes[i + 1] === '5' ? 2 : codes[i + 1] === '2' ? 4 : 0;
    } else {
      const ends = ATTRIBUTE_RESETS.get(n);
      if (ends) for (const ended of ends) attributes.delete(ended);
      else attributes.add(n);
    }
  }
  return { ...next, attributes };
}
/** Lines of cells from a styled capture; undefined when it holds an escape other than SGR or OSC (unrecognised). */
export function parseStyledScreen(screen: string): ScreenLine[] | undefined {
  let current: ScreenLine = [];
  const lines: ScreenLine[] = [current];
  let style = PLAIN;
  let at = 0;
  while (at < screen.length) {
    if (screen[at] === ESC) {
      SGR.lastIndex = at;
      const sgr = SGR.exec(screen);
      if (sgr) {
        style = applySgr(style, sgr[1] ?? '');
        at = SGR.lastIndex;
        continue;
      }
      OSC.lastIndex = at;
      if (OSC.exec(screen)) {
        at = OSC.lastIndex;
        continue;
      }
      return undefined;
    }
    const char = String.fromCodePoint(screen.codePointAt(at) ?? 0);
    at += char.length;
    if (char === '\n') {
      current = [];
      lines.push(current);
      continue;
    }
    current.push({
      char,
      faint: style.dim || !style.defaultForeground,
      inverse: style.inverse,
      decorated: !style.defaultForeground || !style.defaultBackground || style.attributes.size > 0,
    });
  }
  return lines;
}
const lineText = (line: readonly ScreenCell[]) => line.map((cell) => cell.char).join('');
export const screenText = (lines: readonly ScreenLine[]) => lines.map(lineText).join('\n');

export type InputBox =
  | { state: 'missing' }
  /** Claude's input is in another mode: a prompt other than `❯` (shell mode `!`) or vim mode. */
  | { state: 'other-mode' }
  | { state: 'not-empty' }
  | { state: 'empty'; row: number; column: number };
const PROMPT_MARK = '❯';
/** Claude 2.1.299-2.1.301 follow `❯` with a no-break space (U+00A0); a plain space is accepted as well. */
const PROMPT_GAPS = new Set([' ', '\u00a0']);
/** The mark and its gap: typed text, and the cursor of an empty box, start at this column. */
const PROMPT_CELLS = 2;
const startsWithPrompt = ([mark, gap]: readonly ScreenCell[]) =>
  mark?.char === PROMPT_MARK && (gap === undefined || PROMPT_GAPS.has(gap.char));
/** Claude's input box is drawn between two rules of box-drawing characters at least this many cells wide. */
const MIN_RULE_CELLS = 20;
const VIM_MODE = /-- (?:INSERT|NORMAL|VISUAL)(?: LINE)? --/;
const isRule = (line: readonly ScreenCell[]) => {
  const text = lineText(line).trim();
  return text.length >= MIN_RULE_CELLS && /^─+$/.test(text);
};
const visible = (cell: ScreenCell) => cell.char.trim() !== '';
/** Claude's placeholder style: dimmed, in the default colours, with no other attribute. */
const inPlaceholderStyle = (cell: ScreenCell) => cell.faint && !cell.decorated && !cell.inverse;
const isPlaceholder = (cell: ScreenCell) => visible(cell) && inPlaceholderStyle(cell);
/** Claude's own cursor on an empty box: a reversed space, or the reversed first letter of the placeholder. */
const isCursorCell = (cell: ScreenCell, next: ScreenCell | undefined) =>
  cell.inverse &&
  (cell.char === ' ' || (/^\p{L}$/u.test(cell.char) && next !== undefined && isPlaceholder(next)));
const isPlainBlank = (cell: ScreenCell) => !visible(cell) && !cell.decorated && !cell.inverse;
/** A fresh Claude draws each placeholder word as its own dim run, with one plain space between the words. */
const continuesPlaceholder = (cells: readonly ScreenCell[], at: number) => {
  const cell = cells[at];
  const next = cells[at + 1];
  if (!cell) return false;
  return (
    inPlaceholderStyle(cell) || (isPlainBlank(cell) && next !== undefined && isPlaceholder(next))
  );
};
/**
 * Empty input: nothing, or one placeholder run that starts at the caret (after Claude's reversed cursor, if any),
 * with single plain spaces allowed between its words, then only blanks. Blank typed input (spaces) also reads as
 * empty here; the caller's cursor check catches it.
 */
function isEmptyInput(cells: readonly ScreenCell[]): boolean {
  let at = 0;
  const first = cells[0];
  if (first?.inverse) {
    if (!isCursorCell(first, cells[1])) return false;
    at = 1;
  }
  const input = cells.slice(at);
  let runEnd = 0;
  if (input[0] && isPlaceholder(input[0]))
    while (runEnd < input.length && continuesPlaceholder(input, runEnd)) runEnd++;
  return input.slice(runEnd).every((cell) => !visible(cell));
}
/** The rows of the last two rules on the screen, which enclose Claude's input box; undefined without a box between. */
export function inputBoxRules(
  lines: readonly ScreenLine[],
): { top: number; bottom: number } | undefined {
  const rules: number[] = [];
  for (let row = lines.length - 1; row >= 0 && rules.length < 2; row--)
    if (isRule(lines[row] ?? [])) rules.push(row);
  const [bottom, top] = rules;
  return bottom === undefined || top === undefined || bottom - top < 2
    ? undefined
    : { top, bottom };
}
/**
 * Claude's input box: the `❯` line between the last two rules on the screen. Vim mode or a prompt other than `❯` is
 * another mode (even across several rows); anything else unrecognised is not empty.
 */
export function readInputBox(lines: readonly ScreenLine[]): InputBox {
  const rules = inputBoxRules(lines);
  if (!rules) return { state: 'missing' };
  const { top, bottom } = rules;
  if (lines.slice(bottom).some((line) => VIM_MODE.test(lineText(line))))
    return { state: 'other-mode' };
  const row = top + 1;
  const line = lines[row] ?? [];
  if (!startsWithPrompt(line)) return { state: 'other-mode' };
  if (bottom - top > 2) return { state: 'not-empty' };
  return isEmptyInput(line.slice(PROMPT_CELLS))
    ? { state: 'empty', row, column: PROMPT_CELLS }
    : { state: 'not-empty' };
}

/** Rows read above the cursor: for a one-row box, the box's top rule (every captured empty and typed screen). */
export const INPUT_ROWS_ABOVE_CURSOR = 1;
/**
 * The rows around Claude's input box, anchored at the cursor: Claude draws the box right below the conversation, so
 * on a short conversation the pane's last rows are blank. The window runs to the pane's bottom because a user's
 * `statusLine` setting draws any number of rows between the bottom rule and Claude's own footer row (the
 * `statusline-*` captures), and on a narrow pane Claude moves the footer's right side one row further down (the
 * `narrow-*` captures). tmux clamps `end` to the pane.
 */
export const inputWindowRows = (cursorY: number) => ({
  start: Math.max(0, cursorY - INPUT_ROWS_ABOVE_CURSOR),
  end: MAX_PANE_ROW,
});
/** Claude 2.1.296-2.1.302 show `› stashed` on the footer while its one stash slot holds text (stash fixtures). */
const STASH_MARKER = /›\s*stashed\b/u;
/**
 * A row of Claude's footer, told by its shape and never by its words (they change with the permission mode and the
 * notices): indented two cells, then a character that does not open a popup row. The row may be Claude's own footer
 * or a row of the user's status line, which is drawn the same way (the `statusline-*` captures). An `@` popup row is
 * indented four cells (`    + README.md`) and a `/` menu row starts `  ❯ /`. Accepted risk: a popup row that is
 * indented two cells and starts with another character would pass; a new popup shape needs a capture and an entry here.
 */
const isFooterRow = (text: string) => /^ {2}[^\s❯+/]/u.test(text);
/** Claude ends the footer's right side this many cells before the pane's edge (every stash capture). */
const FOOTER_RIGHT_MARGIN_CELLS = 2;
/**
 * The footer's right side moved onto its own row, as Claude draws it when the footer does not fit the pane (the
 * `narrow-*` captures): indented at least two cells, not starting like a popup or menu row (`+`, `❯`, `/`), and
 * right-aligned like the footer, its last visible cell `FOOTER_RIGHT_MARGIN_CELLS` before the edge of the rule
 * (which spans the pane). An `@` popup row (`    + README.md`) is neither.
 */
function isFooterContinuation(line: readonly ScreenCell[], rule: readonly ScreenCell[]): boolean {
  if (!/^ {2,}[^\s❯+/]/u.test(lineText(line))) return false;
  const lastVisible = line.findLastIndex(visible);
  const ruleCells = rule.findLastIndex(visible) + 1;
  return lastVisible + 1 === ruleCells - FOOTER_RIGHT_MARGIN_CELLS;
}
const isBlankRow = (line: readonly ScreenCell[] | undefined) => !line || !line.some(visible);
export interface ReadableWindow {
  readable: true;
  /** Claude's footer shows that its stash slot holds text. */
  stashed: boolean;
  /** A one-row normal box that reads empty, with the cursor right after `❯`: a paste lands alone. */
  emptyAtPrompt: boolean;
}
/** Unreadable: no bottom rule under the cursor, or the rows under it are not Claude's footer, with or without a status line (a popup or menu). */
export type InputWindow = { readable: false } | ReadableWindow;
/**
 * The footer's rows under the bottom rule at `rule`: every consecutive footer-shaped row (a status line's rows, then
 * Claude's own) up to the first blank row, which may be a row the capture lacks because the pane ends there, or up
 * to a right side moved down onto its own row followed by a blank one. Undefined for anything not footer-shaped
 * before the first blank row: a popup, a menu, or no footer at all.
 */
function footerRows(lines: readonly ScreenLine[], rule: number): string[] | undefined {
  const bottomRule = lines[rule] ?? [];
  if (!isRule(bottomRule)) return undefined;
  const rows: string[] = [];
  let next = rule + 1;
  while (isFooterRow(lineText(lines[next] ?? []))) rows.push(lineText(lines[next++] ?? []));
  if (rows.length === 0) return undefined;
  const stop = lines[next];
  if (isBlankRow(stop)) return rows;
  if (stop && isFooterContinuation(stop, bottomRule) && isBlankRow(lines[next + 1]))
    return [...rows, lineText(stop)];
  return undefined;
}
/**
 * Reads the rows Gloss captured around the cursor (`cursorRow` is the cursor's row within them): the bottom rule
 * right under the cursor, then Claude's normal footer (`footerRows`). Anything else is unreadable.
 */
export function readInputWindow(
  lines: readonly ScreenLine[],
  cursorRow: number,
  cursorColumn: number,
): InputWindow {
  const footer = footerRows(lines, cursorRow + 1);
  if (!footer) return { readable: false };
  const prompt = lines[cursorRow] ?? [];
  const emptyAtPrompt =
    isRule(lines[cursorRow - 1] ?? []) &&
    !footer.some((text) => VIM_MODE.test(text)) &&
    startsWithPrompt(prompt) &&
    cursorColumn === PROMPT_CELLS &&
    isEmptyInput(prompt.slice(PROMPT_CELLS));
  return { readable: true, stashed: footer.some((text) => STASH_MARKER.test(text)), emptyAtPrompt };
}
