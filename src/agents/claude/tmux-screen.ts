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
/** Claude's input box: the `❯` line between the last two rules on the screen. Anything unrecognised is not empty. */
export function readInputBox(lines: readonly ScreenLine[]): InputBox {
  const rules: number[] = [];
  for (let row = lines.length - 1; row >= 0 && rules.length < 2; row--)
    if (isRule(lines[row] ?? [])) rules.push(row);
  const [bottom, top] = rules;
  if (bottom === undefined || top === undefined || bottom - top < 2) return { state: 'missing' };
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
 * Rows read below the cursor: the box's bottom rule, Claude's footer, and one more row that shows nothing continues
 * under the footer. In every stash capture on 2.1.296 and 2.1.302 the rule is at cursor + 1, the footer at cursor + 2
 * and cursor + 3 is blank; an `@` popup takes the footer's place, and a `/` menu runs on to the pane's bottom.
 */
export const INPUT_ROWS_BELOW_CURSOR = 3;
/**
 * The rows around Claude's input box, anchored at the cursor: Claude draws the box right below the conversation, so
 * on a short conversation the pane's last rows are blank. tmux clamps `end` to the pane.
 */
export const inputWindowRows = (cursorY: number) => ({
  start: Math.max(0, cursorY - INPUT_ROWS_ABOVE_CURSOR),
  end: cursorY + INPUT_ROWS_BELOW_CURSOR,
});
/** Claude 2.1.296-2.1.302 show `› stashed` on the footer while its one stash slot holds text (stash fixtures). */
const STASH_MARKER = /›\s*stashed\b/u;
/**
 * Claude's normal footer row, told by its shape and never by its words (they change with the permission mode and
 * the notices): indented two cells, then a character that does not open a popup row. An `@` popup row is indented
 * four cells (`    + README.md`) and a `/` menu row starts `  ❯ /`.
 */
const isFooterRow = (text: string) => /^ {2}[^\s❯+]/u.test(text);
export interface ReadableWindow {
  readable: true;
  /** Claude's footer shows that its stash slot holds text. */
  stashed: boolean;
  /** A one-row normal box that reads empty, with the cursor right after `❯`: a paste lands alone. */
  emptyAtPrompt: boolean;
}
/** Unreadable: no bottom rule under the cursor, or the rows under it are not Claude's normal footer (a popup). */
export type InputWindow = { readable: false } | ReadableWindow;
/**
 * Reads the rows Gloss captured around the cursor (`cursorRow` is the cursor's row within them): the bottom rule
 * right under the cursor, the normal footer under the rule, and nothing under the footer. A row missing from the
 * capture (the pane ends there) counts as blank. Anything else, a wrapped footer included, is unreadable.
 */
export function readInputWindow(
  lines: readonly ScreenLine[],
  cursorRow: number,
  cursorColumn: number,
): InputWindow {
  const footer = lineText(lines[cursorRow + 2] ?? []);
  const belowFooter = lineText(lines[cursorRow + 3] ?? []);
  if (!isRule(lines[cursorRow + 1] ?? []) || !isFooterRow(footer) || belowFooter.trim() !== '')
    return { readable: false };
  const prompt = lines[cursorRow] ?? [];
  const emptyAtPrompt =
    isRule(lines[cursorRow - 1] ?? []) &&
    !VIM_MODE.test(footer) &&
    startsWithPrompt(prompt) &&
    cursorColumn === PROMPT_CELLS &&
    isEmptyInput(prompt.slice(PROMPT_CELLS));
  return { readable: true, stashed: STASH_MARKER.test(footer), emptyAtPrompt };
}
