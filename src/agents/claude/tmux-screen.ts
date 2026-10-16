/** One cell of a `capture-pane -e` line: its character and how it is drawn. */
export interface ScreenCell {
  char: string;
  /** Dimmed or drawn in a colour other than the default foreground: Claude's placeholder and hints. */
  faint: boolean;
  /** Reverse video: Claude draws its own cursor this way. */
  inverse: boolean;
}
export type ScreenLine = ScreenCell[];

const ESC = '\u001b';
const SGR = /\u001b\[([0-9;:]*)m/y;
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/y;
interface Style {
  dim: boolean;
  defaultForeground: boolean;
  inverse: boolean;
}
const PLAIN: Style = { dim: false, defaultForeground: true, inverse: false };

function applySgr(style: Style, params: string): Style {
  const codes = params === '' ? ['0'] : params.split(';');
  let next = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i] ?? '';
    const head = code.split(':')[0] ?? '';
    const n = Number(head);
    if (head === '' || n === 0) next = { ...PLAIN };
    else if (n === 2) next.dim = true;
    else if (n === 22) next.dim = false;
    else if (n === 7) next.inverse = true;
    else if (n === 27) next.inverse = false;
    else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) next.defaultForeground = false;
    else if (n === 39) next.defaultForeground = true;
    else if (n === 38 || n === 48) {
      if (n === 38) next.defaultForeground = false;
      // 38;5;n and 38;2;r;g;b carry their colour in the following parameters; 38:5:n carries it in this one.
      if (!code.includes(':')) i += codes[i + 1] === '5' ? 2 : codes[i + 1] === '2' ? 4 : 0;
    }
  }
  return next;
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
    current.push({ char, faint: style.dim || !style.defaultForeground, inverse: style.inverse });
  }
  return lines;
}
const lineText = (line: readonly ScreenCell[]) => line.map((cell) => cell.char).join('');
export const screenText = (lines: readonly ScreenLine[]) => lines.map(lineText).join('\n');

export type InputBox =
  { state: 'missing' } | { state: 'not-empty' } | { state: 'empty'; row: number; column: number };
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
function isEmptyInput(cells: readonly ScreenCell[]): boolean {
  const [first, ...rest] = cells;
  if (!first) return true;
  if (rest.some((cell) => visible(cell) && !cell.faint)) return false;
  if (!visible(first) || first.faint) return true;
  // Claude's inverted cursor sits on the first letter of the placeholder when the input is empty.
  return first.inverse && rest.some((cell) => visible(cell) && cell.faint);
}
/** Claude's input box: the `❯` line between the last two rules on the screen. Anything unrecognised is not empty. */
export function readInputBox(lines: readonly ScreenLine[]): InputBox {
  const rules: number[] = [];
  for (let row = lines.length - 1; row >= 0 && rules.length < 2; row--)
    if (isRule(lines[row] ?? [])) rules.push(row);
  const [bottom, top] = rules;
  if (bottom === undefined || top === undefined || bottom - top < 2) return { state: 'missing' };
  if (bottom - top > 2) return { state: 'not-empty' };
  if (lines.slice(bottom).some((line) => VIM_MODE.test(lineText(line))))
    return { state: 'not-empty' };
  const row = top + 1;
  const line = lines[row] ?? [];
  if (!startsWithPrompt(line)) return { state: 'not-empty' };
  return isEmptyInput(line.slice(PROMPT_CELLS))
    ? { state: 'empty', row, column: PROMPT_CELLS }
    : { state: 'not-empty' };
}
