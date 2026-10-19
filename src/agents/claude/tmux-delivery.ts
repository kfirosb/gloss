import { setTimeout as delay } from 'node:timers/promises';
import { DIALOG_OPEN_REASON, type AgentMessage } from '../../core/contracts.js';
import { classifyScreen, markersFor } from '../../runtime/attention-markers.js';
import { claudeActivity } from './coding-state.js';
import {
  inputBoxRules,
  inputWindowRows,
  parseStyledScreen,
  readInputBox,
  readInputWindow,
  screenText,
  type InputWindow,
} from './tmux-screen.js';
import {
  INPUT_CHANGED_REASON,
  INPUT_NOT_READY_REASON,
  INPUT_UNREADABLE_REASON,
  nextStashStep,
  notReadyReason,
  withStashNote,
  type StashStart,
} from './tmux-stash.js';

export interface PaneCursor {
  x: number;
  y: number;
  /** The pane is in copy mode or another tmux mode: keys would go to tmux, not to Claude. */
  inMode: boolean;
}
/** The tmux pane Gloss launched a Claude session in. Supplied by the trusted server, never by a browser. */
export interface GlossTerminal {
  readonly launchId: string;
  /** Gloss starts Claude through `env`, which execs, so the pane's process is Claude itself. */
  readonly panePid: number;
  capture(): Promise<string>;
  cursor(): Promise<PaneCursor>;
  /** Rows `start`..`end` of the pane (0 = top), styled, clamped to the pane. */
  captureRows(start: number, end: number): Promise<string>;
  loadBuffer(buffer: string, text: string): Promise<void>;
  /** Bracketed paste, line feeds kept, buffer deleted afterwards. */
  pasteBuffer(buffer: string): Promise<void>;
  deleteBuffer(buffer: string): Promise<void>;
  pressEnter(): Promise<void>;
  /** Ctrl+S once: Claude's stash. Gloss presses no other key besides Enter. */
  pressStash(): Promise<void>;
}
/** The parts of Claude's session record the checks read. */
export interface TerminalSession {
  status?: string | undefined;
  waitingFor?: unknown;
  version: string;
}

/** How long a typed message may take to appear in Claude's transcript before it shows as unconfirmed, in milliseconds. */
export const TMUX_CONFIRM_TIMEOUT_MS = 30_000;
/** How often the transcript is read for it meanwhile, in milliseconds. */
export const TMUX_CONFIRM_POLL_MS = 500;
/**
 * How long Gloss waits after the paste for Claude's input to show the pasted text before pressing Enter, in
 * milliseconds. Past it Enter is pressed anyway: on an empty input it does nothing.
 */
export const PASTE_SETTLE_MS = 2_000;
/** How often the screen is read meanwhile, in milliseconds. */
export const PASTE_SETTLE_POLL_MS = 50;
/**
 * At least this long after a Ctrl+S before Gloss reads Claude's redraw, in milliseconds: twice the slowest redraw Task 1
 * measured (45 ms on 2.1.296 and 2.1.302), at least 100, rounded up to 50.
 */
export const KEY_SETTLE_MIN_MS = 100;
/** How long Gloss waits after a Ctrl+S for the input to settle in the expected state, in milliseconds. */
export const KEYS_SETTLE_MS = 2_000;
/** How often the input window is read meanwhile, in milliseconds. */
export const KEYS_SETTLE_POLL_MS = 50;

export const NO_INPUT_BOX_REASON = 'The terminal isn’t showing Claude’s input box';
export const SCROLLED_REASON = 'The terminal is scrolled back; return it to the prompt';
export const UNKNOWN_VERSION_REASON = 'Gloss can’t read this Claude version’s terminal';
export const TERMINAL_READ_REASON = 'Gloss couldn’t read the terminal';
export const UNSAFE_TEXT_REASON =
  'The message contains control characters a terminal would act on; nothing was typed';
export const COMMAND_PREFIX_REASON =
  'Claude would read a message starting with !, / or # as a command; nothing was typed';
export const PASTE_PREPARE_REASON = 'Gloss could not prepare the paste; nothing was typed';
export const TYPING_UNCERTAIN_REASON =
  'The paste into the terminal did not finish cleanly; check the terminal. Gloss will not type it again';
export const TMUX_UNCONFIRMED_REASON = `Claude has not shown this message within ${TMUX_CONFIRM_TIMEOUT_MS / 1000} seconds. Check delivery, or release the composer; Gloss will not type it again`;
export const TERMINAL_GONE_REASON =
  'The terminal closed before the message was typed; nothing was sent';
export const NO_TYPING_RECORD_REASON =
  'Gloss could not record that typing started; nothing was sent';
export const SESSION_SWITCHED_REASON =
  'The terminal no longer runs this Claude session; nothing was sent';
export const OTHER_MODE_REASON = 'The terminal’s input is in shell or vim mode';
/** C0 controls except tab and line feed, DEL and C1 controls: a terminal acts on them (ESC [201~ ends a bracketed paste). */
const TERMINAL_CONTROL_CHARACTER = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;
/** Claude reads a leading ! as a shell command, / as a slash command and # as a memory note. */
const COMMAND_PREFIX = /^\s*[!/#]/;
export const pasteBufferName = (requestId: string) => 'gloss-' + requestId;

export type TerminalCheck = { ready: true } | { ready: false; reason: string };

/** What Gloss reads at Send for step 1. A screen or cursor that could not be read is undefined. */
export interface TerminalFacts {
  session: TerminalSession;
  screen: string | undefined;
  cursor: PaneCursor | undefined;
}
/**
 * Spec 2.1 step 1, decided once at Send from the record and the full screen: anything that needs the user opens the
 * terminal. What is written in the box does not matter here; the stash step (2.6) handles it.
 */
export function checkAtSend(facts: TerminalFacts): TerminalCheck {
  const hold = (reason: string): TerminalCheck => ({ ready: false, reason });
  const activity = claudeActivity(facts.session.status, facts.session.waitingFor);
  if (activity === 'dialog-open' || activity === 'approval-required')
    return hold(DIALOG_OPEN_REASON);
  const markers = markersFor('claude', facts.session.version);
  if (!markers) return hold(UNKNOWN_VERSION_REASON);
  const { screen, cursor } = facts;
  if (screen === undefined || cursor === undefined) return hold(TERMINAL_READ_REASON);
  if (cursor.inMode) return hold(SCROLLED_REASON);
  const lines = parseStyledScreen(screen);
  if (!lines) return hold(NO_INPUT_BOX_REASON);
  if (classifyScreen(markers, screenText(lines)) !== 'none') return hold(DIALOG_OPEN_REASON);
  const box = readInputBox(lines);
  if (box.state === 'missing') return hold(NO_INPUT_BOX_REASON);
  if (box.state === 'other-mode') return hold(OTHER_MODE_REASON);
  // The cursor must be in the box: elsewhere (the Ctrl+R history picker puts it on the footer row) the keys go to
  // something Gloss does not recognise, and Ctrl+S may mean something else there.
  const rules = inputBoxRules(lines);
  if (!rules || cursor.y <= rules.top || cursor.y >= rules.bottom) return hold(NO_INPUT_BOX_REASON);
  return { ready: true };
}

/** Time for the wait after the paste; tests inject their own. */
export interface TypingClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
const realTime: TypingClock = { now: () => Date.now(), sleep: (ms) => delay(ms) };
/**
 * Claude's input box shows something: the pasted text, or the chip for a long paste. A failed read shows nothing.
 * `other-mode` counts as not shown: the cursor check put the cursor after an empty `❯` and the body never starts with
 * `!`, so only a screen Gloss does not recognise reads that way, and Enter after the bound is the existing fallback.
 */
async function pasteShown(terminal: GlossTerminal): Promise<boolean> {
  try {
    const lines = parseStyledScreen(await terminal.capture());
    return !!lines && readInputBox(lines).state === 'not-empty';
  } catch {
    return false;
  }
}
/** Waits, bounded by PASTE_SETTLE_MS, for the paste to show; Enter before that could be lost while Claude reads it. */
async function waitForPaste(terminal: GlossTerminal, clock: TypingClock): Promise<void> {
  const deadline = clock.now() + PASTE_SETTLE_MS;
  // A clock that stops advancing still ends the wait.
  const maxPolls = Math.ceil(PASTE_SETTLE_MS / PASTE_SETTLE_POLL_MS);
  for (let polls = 0; !(await pasteShown(terminal)); polls += 1) {
    if (clock.now() >= deadline || polls >= maxPolls) return;
    await clock.sleep(PASTE_SETTLE_POLL_MS);
  }
}

/** The screen and the cursor for step 1; both undefined when either cannot be read. */
async function readTerminal(
  terminal: GlossTerminal,
): Promise<{ screen: string | undefined; cursor: PaneCursor | undefined }> {
  try {
    const screen = await terminal.capture();
    return { screen, cursor: await terminal.cursor() };
  } catch {
    return { screen: undefined, cursor: undefined };
  }
}
interface WindowRead {
  /** Cursor and text: tells two reads apart. */
  key: string;
  cursor: PaneCursor;
  window: InputWindow;
}
/** One read of the rows around the cursor. Undefined when it fails. */
async function readWindowOf(terminal: GlossTerminal): Promise<WindowRead | undefined> {
  try {
    const cursor = await terminal.cursor();
    const { start, end } = inputWindowRows(cursor.y);
    const text = await terminal.captureRows(start, end);
    const lines = cursor.inMode ? undefined : parseStyledScreen(text);
    return {
      key: `${cursor.x} ${cursor.y} ${cursor.inMode}\n${text}`,
      cursor,
      window: lines ? readInputWindow(lines, cursor.y - start, cursor.x) : { readable: false },
    };
  } catch {
    return undefined;
  }
}
/** The cursor is where it was and the box and the stash marker read the same. */
function sameInput(settled: WindowRead, now: WindowRead | undefined): boolean {
  if (!now?.window.readable || !settled.window.readable) return false;
  return (
    now.cursor.x === settled.cursor.x &&
    now.cursor.y === settled.cursor.y &&
    now.cursor.inMode === settled.cursor.inMode &&
    now.window.emptyAtPrompt === settled.window.emptyAtPrompt &&
    now.window.stashed === settled.window.stashed
  );
}
/**
 * After a Ctrl+S: waits KEY_SETTLE_MIN_MS, then until two reads in a row are identical and show the step's expected
 * state, bounded by KEYS_SETTLE_MS (a clock that stops advancing still ends it).
 */
async function settleAfterStash(
  terminal: GlossTerminal,
  clock: TypingClock,
  start: StashStart,
  presses: 1 | 2,
): Promise<
  | { step: 'paste'; last: InputWindow; read: WindowRead }
  | { step: 'press-again' | 'timeout'; last: InputWindow | undefined }
> {
  await clock.sleep(KEY_SETTLE_MIN_MS);
  const deadline = clock.now() + KEYS_SETTLE_MS;
  const maxPolls = Math.ceil(KEYS_SETTLE_MS / KEYS_SETTLE_POLL_MS);
  let previous: string | undefined;
  for (let polls = 0; ; polls += 1) {
    const read = await readWindowOf(terminal);
    if (read?.window.readable && read.key === previous) {
      const step = nextStashStep(start, presses, read.window);
      if (step === 'paste') return { step, last: read.window, read };
      if (step !== 'wait') return { step, last: read.window };
    }
    previous = read?.key;
    if (clock.now() >= deadline || polls >= maxPolls)
      return { step: 'timeout', last: read?.window };
    await clock.sleep(KEYS_SETTLE_POLL_MS);
  }
}
/**
 * Spec 2.6: sets Claude's input aside with Ctrl+S (once, or twice when the first press brought an older stash back)
 * and checks the cursor sits right after `❯` on an empty box. The window is read before any press: unreadable, nothing
 * is pressed. Presses nothing else, and never more than twice. `last` is the last readable window, for the reason of a
 * later refusal.
 */
async function stashForSend(
  terminal: GlossTerminal,
  clock: TypingClock,
): Promise<
  { ready: true; last: InputWindow; settled: WindowRead } | { ready: false; reason: string }
> {
  const before = await readWindowOf(terminal);
  if (!before?.window.readable) return { ready: false, reason: INPUT_UNREADABLE_REASON };
  const start: StashStart = {
    stashed: before.window.stashed,
    emptyAtPrompt: before.window.emptyAtPrompt,
  };
  let last: InputWindow = before.window;
  for (const presses of [1, 2] as const) {
    try {
      await terminal.pressStash();
    } catch {
      // A first press that failed set nothing aside, whatever an older stash's marker shows.
      return {
        ready: false,
        reason: presses === 1 ? INPUT_NOT_READY_REASON : notReadyReason(last),
      };
    }
    const settled = await settleAfterStash(terminal, clock, start, presses);
    // An unparsable last poll must not hide the marker an earlier read showed.
    if (settled.last?.readable) last = settled.last;
    if (settled.step === 'paste') return { ready: true, last, settled: settled.read };
    if (settled.step === 'timeout') break;
  }
  return { ready: false, reason: notReadyReason(last) };
}

export type TerminalSend =
  | { state: 'failed'; reason: string; openTerminal?: true }
  | { state: 'typed'; nativeAfterRevision: number }
  | { state: 'unconfirmed'; reason: string; nativeAfterRevision: number };
/**
 * Types one message into Claude's input at Send (spec 2.1, 2.2, 2.6). `failed` means nothing of the message was
 * typed; with `openTerminal` the terminal needs the user. `paneRunsSession` is asked before the buffer is loaded and
 * again after the stash, which can take seconds. The stash runs after the buffer is ready; `onTyping` runs after the
 * cursor check and a last read that finds the input as it settled, right before the paste, and if it throws nothing is
 * typed. Enter follows once the paste shows.
 * Windows line endings are typed as line feeds; any other carriage return is refused like the other control
 * characters.
 */
export async function typeIntoTerminal(input: {
  terminal: GlossTerminal;
  requestId: string;
  body: string;
  session: TerminalSession;
  /** The pane still runs the session this message is for. */
  paneRunsSession(): Promise<boolean>;
  transcriptSize(): Promise<number>;
  /** Synchronous on purpose: a returned promise would let its rejection escape after the paste. */
  onTyping: (evidence: { nativeAfterRevision: number }) => undefined;
  clock?: TypingClock;
}): Promise<TerminalSend> {
  const body = input.body.replace(/\r\n/g, '\n');
  if (TERMINAL_CONTROL_CHARACTER.test(body)) return { state: 'failed', reason: UNSAFE_TEXT_REASON };
  if (COMMAND_PREFIX.test(body)) return { state: 'failed', reason: COMMAND_PREFIX_REASON };
  const { terminal } = input;
  const clock = input.clock ?? realTime;
  const check = checkAtSend({ session: input.session, ...(await readTerminal(terminal)) });
  if (!check.ready) return { state: 'failed', reason: check.reason, openTerminal: true };
  const runsSession = () => input.paneRunsSession().catch(() => false);
  // `/resume` or `/clear` may have switched the pane to another session while the screen was read.
  if (!(await runsSession())) return { state: 'failed', reason: SESSION_SWITCHED_REASON };
  const buffer = pasteBufferName(input.requestId);
  // Best effort: the buffer holds only this message's text, and a leftover is never pasted by anything else.
  const discard = () => terminal.deleteBuffer(buffer).catch(() => undefined);
  let nativeAfterRevision: number;
  try {
    nativeAfterRevision = await input.transcriptSize();
    await terminal.loadBuffer(buffer, body);
  } catch {
    await discard();
    return { state: 'failed', reason: PASTE_PREPARE_REASON };
  }
  // From here Ctrl+S may have run, so the terminal can show a stash: every refusal shows it to the user.
  const refuse = async (reason: string): Promise<TerminalSend> => {
    await discard();
    return { state: 'failed', reason, openTerminal: true };
  };
  const stash = await stashForSend(terminal, clock);
  if (!stash.ready) return refuse(stash.reason);
  // The user's draft may now be in Claude's stash: say so whenever the settled window shows the marker.
  if (!(await runsSession())) return refuse(withStashNote(SESSION_SWITCHED_REASON, stash.last));
  // The user may have typed in the terminal while the session was checked: paste only into the box as it settled.
  if (!sameInput(stash.settled, await readWindowOf(terminal)))
    return refuse(withStashNote(INPUT_CHANGED_REASON, stash.last));
  try {
    input.onTyping({ nativeAfterRevision });
  } catch {
    return refuse(withStashNote(PASTE_PREPARE_REASON, stash.last));
  }
  try {
    await terminal.pasteBuffer(buffer);
    await waitForPaste(terminal, clock);
    await terminal.pressEnter();
  } catch {
    await discard();
    return { state: 'unconfirmed', reason: TYPING_UNCERTAIN_REASON, nativeAfterRevision };
  }
  // Claude restores its stash into the box by itself; Gloss never presses Ctrl+S after the paste.
  return { state: 'typed', nativeAfterRevision };
}

/**
 * Runs typing tasks one at a time per session (spec 2.1.3): a second message is checked and pasted only after the
 * first one's Enter, so two pastes never interleave. Other sessions are not held up, and a failed task does not stop
 * the next.
 */
export function createTypingQueue() {
  const tails = new Map<string, Promise<void>>();
  return function typeInTurn<T>(sessionRef: string, task: () => Promise<T>): Promise<T> {
    const run = (tails.get(sessionRef) ?? Promise.resolve()).then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(sessionRef, tail);
    void tail.then(() => {
      if (tails.get(sessionRef) === tail) tails.delete(sessionRef);
    });
    return run;
  };
}

/** One message typed into the terminal: its text and the transcript size just before the paste. */
export interface TypedSend {
  id: string;
  body: string;
  after: number;
}
const normalized = (text: string) => text.replace(/\r\n?/g, '\n').trim();
export const sameTypedText = (a: string, b: string) => normalized(a) === normalized(b);
/**
 * Claude 2.1.301 and 2.1.302 record a paste they collapsed to a chip (more than 3 lines or 800 characters) as the
 * pasted text inside one `<pasted_content id="…">` tag pair with the same id in both tags, after blank lines
 * (tests/fixtures/tmux-screens/claude-typed-long-*.jsonl). Matched against the normalised record text.
 */
const PASTED_CONTENT_WRAPPER =
  /^<pasted_content id="([^"\n]+)">\n([\s\S]*)\n<\/pasted_content id="\1">$/;
const PASTED_CONTENT_TAG = /<\/?pasted_content\b/;
/** The text a typed user record holds: the paste inside Claude's wrapper, or the record text as it is. */
function typedRecordText(text: string): string {
  const match = PASTED_CONTENT_WRAPPER.exec(normalized(text));
  const inner = match?.[2];
  // Only one whole wrapper is unwrapped; a tag inside it means several, nested or partial wrappers.
  return inner === undefined || PASTED_CONTENT_TAG.test(inner) ? text : inner;
}
/**
 * Gives each send, in order, the first unclaimed plain user message after its paste with the same text, so identical
 * texts confirm in send order. `taken` are records that already confirmed an earlier send.
 */
export function assignTypedMessages(
  sends: readonly TypedSend[],
  messages: readonly AgentMessage[],
  taken: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const claimed = new Set(taken);
  const result = new Map<string, string>();
  const candidates = messages
    .filter((m) => m.role === 'user' && m.clientId === undefined)
    .sort((a, b) => a.revision - b.revision);
  for (const send of sends) {
    const match = candidates.find(
      (m) =>
        !claimed.has(m.sourceId) &&
        m.revision > send.after &&
        sameTypedText(typedRecordText(m.text), send.body),
    );
    if (!match) continue;
    claimed.add(match.sourceId);
    result.set(send.id, match.sourceId);
  }
  return result;
}
/** User messages newer than `after`, oldest first. History pages run newest first, so reading stops at `after`. */
export async function typedMessagesAfter(
  history: (cursor?: string) => Promise<{ messages: AgentMessage[]; next?: string }>,
  after: number,
): Promise<AgentMessage[]> {
  const found: AgentMessage[] = [];
  let cursor: string | undefined;
  do {
    const page = await history(cursor);
    found.push(...page.messages.filter((m) => m.role === 'user' && m.revision > after));
    if (page.messages.some((m) => m.revision <= after)) break;
    cursor = page.next;
  } while (cursor);
  return found.sort((a, b) => a.revision - b.revision);
}
