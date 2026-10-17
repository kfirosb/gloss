/** A wheel movement the terminal view sends to the server: negative lines scroll up; col/row is the 1-based pointer cell. */
export interface TerminalWheel {
  lines: number;
  col: number;
  row: number;
}
/** Upper bound of lines in one scroll message; the view splits larger movements. */
export const MAX_WHEEL_LINES = 50;
export const isTerminalWheel = ({ lines, col, row }: TerminalWheel) =>
  Number.isSafeInteger(lines) &&
  lines !== 0 &&
  Math.abs(lines) <= MAX_WHEEL_LINES &&
  [col, row].every((n) => Number.isSafeInteger(n) && n >= 1 && n <= 1000);

// WheelEvent.deltaMode values; WheelEvent itself exists only in the browser.
const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_PAGE = 2;
/** Whole terminal lines per wheel movement, carrying the fraction a trackpad's small pixel deltas leave over. */
export function wheelLineCounter() {
  let partial = 0;
  return (
    event: { deltaY: number; deltaMode: number },
    cellHeight: number,
    rows: number,
  ): number => {
    let amount = event.deltaY;
    if (event.deltaMode === DOM_DELTA_PIXEL) {
      amount /= cellHeight > 0 ? cellHeight : 16;
      // Trackpads send many small deltas; slow them down the way xterm.js does for its own scrollback.
      if (Math.abs(event.deltaY) < 50) amount *= 0.3;
    } else if (event.deltaMode === DOM_DELTA_PAGE) amount *= rows;
    partial += amount;
    const lines = Math.trunc(partial);
    partial -= lines;
    return lines;
  };
}
