import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordOf } from '../../src/core/json-record.js';
import type { GlossTerminal } from '../../src/agents/claude/tmux-delivery.js';
import { inputWindowRows } from '../../src/agents/claude/tmux-screen.js';

/** Captured by scripts/probes/capture-claude-input-screens.mjs from throwaway sessions (tmux delivery plan, Task 1). */
export const FIXTURE_DIR = 'tests/fixtures/tmux-screens';
export const FIXTURE_VERSIONS = ['2.1.299', '2.1.300', '2.1.301'] as const;
export interface CapturedRecord {
  status?: string | undefined;
  waitingFor?: unknown;
  version: string;
}
export function readRecord(version: string, state: 'dialog' | 'permission'): CapturedRecord {
  const value: unknown = JSON.parse(
    readFileSync(join(FIXTURE_DIR, `claude-${version}-${state}.session.json`), 'utf8'),
  );
  const record = recordOf(value);
  if (!record || typeof record.version !== 'string')
    throw new Error('Malformed captured session record');
  return {
    ...(typeof record.status === 'string' ? { status: record.status } : {}),
    waitingFor: record.waitingFor,
    version: record.version,
  };
}
export const readScreen = (version: string, state: string) =>
  readFileSync(join(FIXTURE_DIR, `claude-${version}-${state}.ansi`), 'utf8');
export function readCursor(
  version: string,
  state: string,
): { x: number; y: number; inMode: boolean } {
  const text = readFileSync(join(FIXTURE_DIR, `claude-${version}-${state}.cursor`), 'utf8');
  const match = /^(\d+) (\d+) ([01])$/.exec(text.trim());
  if (!match) throw new Error('Malformed captured cursor');
  return { x: Number(match[1]), y: Number(match[2]), inMode: match[3] === '1' };
}
/** The texts the capture script typed; keep them identical to its constants. */
export const CAPTURED = {
  typed: 'Reply with the single word OK.\nThis second line checks a multi-line paste.',
  busy: 'After counting, also say DONE.',
} as const;
/** Versions whose long-paste transcript (`claude-typed-long-<version>.jsonl`, the capture script's `long` mode) exists. */
export const LONG_FIXTURE_VERSIONS = ['2.1.301', '2.1.302'] as const;
/** The long texts the capture script's `long` mode typed and submitted; keep them identical to its constants. */
export const CAPTURED_LONG = {
  sevenLines: [
    'Reply with the single word OK.',
    ...Array.from({ length: 6 }, (_, i) => `Line ${i + 2} of a seven-line paste.`),
  ].join('\n'),
  longLine: 'Reply with the single word OK.'.padEnd(2000, ' filler'),
  manifestText: 'Reply with the single word OK after reading the referenced files.',
  /** The probe texts on each side of Claude's chip thresholds (more than 3 lines, more than 800 characters). */
  probeLines: (count: number) =>
    Array.from({ length: count }, (_, i) => `Probe line ${i + 1}.`).join('\n'),
  probeLine: (length: number) => 'Probe of one long line.'.padEnd(length, 'x'),
  /** The scratch project the references point into, as the scrubbed transcript names it. */
  project: (version: string) => `/fixture/home/project-long-${version.replaceAll('.', '-')}`,
} as const;
/** Versions with the stash captures (the capture script's `stash` mode); 2.1.296 is the screen reader's floor. */
export const STASH_FIXTURE_VERSIONS = ['2.1.296', '2.1.302'] as const;
/** The texts the capture script's `stash` mode typed; keep them identical to its constants. */
export const CAPTURED_STASH = {
  draft: 'hello there',
  secondDraft: 'second draft',
  busy: 'Count from 1 to 1000, one number per line.',
  message: 'Reply with the single word OK.',
} as const;
/**
 * The stash screens the capture script's `narrow` mode took at each pane width (`claude-<version>-narrow-<width>-…`),
 * with a stash present: Claude never cuts `› stashed` but wraps the footer's right side onto a second row, which Gloss
 * cannot read. Only a footer that still fits on one row reads.
 */
type WindowReading =
  { readable: false } | { readable: true; stashed: boolean; emptyAtPrompt: boolean };
export const NARROW_READINGS: Readonly<Record<string, WindowReading>> = Object.fromEntries([
  ...[80, 60, 40].flatMap((width) =>
    ['stash-empty', 'stash-typed', 'stash-ctrl-y'].map((state): [string, WindowReading] => [
      `narrow-${width}-${state}`,
      width === 80 && state === 'stash-typed'
        ? { readable: true, stashed: true, emptyAtPrompt: false }
        : { readable: false },
    ]),
  ),
  // Each permission mode (Shift+Tab) at the narrowest width.
  ...[1, 2, 3].map((press): [string, WindowReading] => [
    `narrow-40-stash-mode-${press}`,
    { readable: false },
  ]),
]);
/** What Gloss must read in each captured stash state's input window (Task 1 states with a single right answer). */
export const STASH_READINGS = {
  'stash-empty': { stashed: false, emptyAtPrompt: true },
  'stash-empty-after': { stashed: false, emptyAtPrompt: true },
  'stash-typed': { stashed: false, emptyAtPrompt: false },
  'stash-stashed': { stashed: true, emptyAtPrompt: true },
  'stash-stashed-typed': { stashed: true, emptyAtPrompt: false },
  'stash-replaced': { stashed: true, emptyAtPrompt: true },
  'stash-popped': { stashed: false, emptyAtPrompt: false },
  'stash-restashed': { stashed: true, emptyAtPrompt: true },
  'stash-working': { stashed: true, emptyAtPrompt: true },
  'stash-working-later': { stashed: true, emptyAtPrompt: true },
  'stash-restored': { stashed: false, emptyAtPrompt: false },
  'stash-ctrl-y': { stashed: true, emptyAtPrompt: true },
} as const;
/**
 * The rows Gloss reads around the cursor of a captured screen: the real `-S/-E` capture (`window`, the default), or
 * the same rows cut from the full capture (`screen`), which is what fixtureTerminal serves.
 */
export function readWindow(version: string, state: string, source: 'window' | 'screen' = 'window') {
  const cursor = readCursor(version, state);
  const { start, end } = inputWindowRows(cursor.y);
  const rows =
    source === 'window'
      ? readFileSync(join(FIXTURE_DIR, `claude-${version}-${state}.window.ansi`), 'utf8')
          .split('\n')
          .slice(0, end - start + 1)
      : readScreen(version, state)
          .split('\n')
          .slice(start, end + 1);
  return { text: rows.join('\n'), cursorRow: cursor.y - start, cursorColumn: cursor.x };
}
export interface TerminalLog {
  calls: string[];
  loaded: string[];
}
export interface FixtureTerminalOptions {
  inMode?: boolean;
  cursorShift?: number;
  panePid?: number;
  fail?: 'capture' | 'load' | 'paste' | 'enter';
  onEnter?: (text: string) => Promise<void>;
  /**
   * The captured screen shown from the paste until Enter, as Claude shows pasted text; `null` keeps the screen as it
   * was, as when Claude has not drawn the paste. Defaults to the captured `typed` screen.
   */
  pastedState?: string | null;
  /** Screen reads after the paste that still show the old screen, as while Claude is still drawing it. */
  pasteDrawnAfter?: number;
}
/** A Gloss terminal that shows a captured screen and records what the adapter does to it. */
export function fixtureTerminal(
  version: string,
  state: string,
  options: FixtureTerminalOptions = {},
): { terminal: GlossTerminal; log: TerminalLog } {
  const log: TerminalLog = { calls: [], loaded: [] };
  const pastedState = options.pastedState === undefined ? 'typed' : options.pastedState;
  /** Screen reads since the paste, while it is in the input; undefined when nothing is pasted. */
  let readsSincePaste: number | undefined;
  const fail = (step: FixtureTerminalOptions['fail']) => {
    if (options.fail === step) throw new Error(`fixture ${step} failure`);
  };
  const terminal: GlossTerminal = {
    launchId: 'launch-1',
    panePid: options.panePid ?? process.pid,
    async capture() {
      log.calls.push('capture');
      fail('capture');
      if (readsSincePaste === undefined || pastedState === null) return readScreen(version, state);
      readsSincePaste += 1;
      return readsSincePaste > (options.pasteDrawnAfter ?? 0)
        ? readScreen(version, pastedState)
        : readScreen(version, state);
    },
    async cursor() {
      log.calls.push('cursor');
      const cursor = readCursor(version, state);
      return {
        x: cursor.x + (options.cursorShift ?? 0),
        y: cursor.y,
        inMode: options.inMode ?? cursor.inMode,
      };
    },
    async loadBuffer(buffer, text) {
      log.calls.push('load:' + buffer);
      fail('load');
      log.loaded.push(text);
    },
    async pasteBuffer(buffer) {
      log.calls.push('paste:' + buffer);
      fail('paste');
      readsSincePaste = 0;
    },
    async deleteBuffer(buffer) {
      log.calls.push('delete:' + buffer);
    },
    async pressEnter() {
      log.calls.push('enter');
      readsSincePaste = undefined;
      fail('enter');
      await options.onEnter?.(log.loaded.at(-1) ?? '');
    },
  };
  return { terminal, log };
}
