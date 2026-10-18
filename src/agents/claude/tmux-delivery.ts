import { setTimeout as delay } from 'node:timers/promises';
import { DIALOG_OPEN_REASON, type AgentMessage } from '../../core/contracts.js';
import { classifyScreen, markersFor } from '../../runtime/attention-markers.js';
import { claudeActivity } from './activity.js';
import { parseStyledScreen, readInputBox, screenText } from './tmux-screen.js';

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
  loadBuffer(buffer: string, text: string): Promise<void>;
  /** Bracketed paste, line feeds kept, buffer deleted afterwards. */
  pasteBuffer(buffer: string): Promise<void>;
  deleteBuffer(buffer: string): Promise<void>;
  pressEnter(): Promise<void>;
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

export const UNSENT_TEXT_REASON = 'There is unsent text in the terminal';
export const NO_INPUT_BOX_REASON = 'The terminal isn’t showing Claude’s input box';
export const SCROLLED_REASON = 'The terminal is scrolled back; return it to the prompt';
export const UNKNOWN_VERSION_REASON = 'Gloss can’t read this Claude version’s terminal';
export const TERMINAL_READ_REASON = 'Gloss couldn’t read the terminal; it will check again';
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
/** C0 controls except tab and line feed, DEL and C1 controls: a terminal acts on them (ESC [201~ ends a bracketed paste). */
const TERMINAL_CONTROL_CHARACTER = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;
/** Claude reads a leading ! as a shell command, / as a slash command and # as a memory note. */
const COMMAND_PREFIX = /^\s*[!/#]/;
export const pasteBufferName = (requestId: string) => 'gloss-' + requestId;

export type TerminalCheck = { ready: true } | { ready: false; reason: string };
/** Spec 2.1: the session record, the screen, then an empty input by colour and by cursor. Only ever holds. */
export async function checkTerminal(
  terminal: GlossTerminal,
  session: TerminalSession,
): Promise<TerminalCheck> {
  const activity = claudeActivity(session.status, session.waitingFor);
  if (activity === 'dialog-open' || activity === 'approval-required')
    return { ready: false, reason: DIALOG_OPEN_REASON };
  const markers = markersFor('claude', session.version);
  if (!markers) return { ready: false, reason: UNKNOWN_VERSION_REASON };
  const screen = await terminal.capture();
  const cursor = await terminal.cursor();
  if (cursor.inMode) return { ready: false, reason: SCROLLED_REASON };
  const lines = parseStyledScreen(screen);
  if (!lines) return { ready: false, reason: NO_INPUT_BOX_REASON };
  if (classifyScreen(markers, screenText(lines)) !== 'none')
    return { ready: false, reason: DIALOG_OPEN_REASON };
  const box = readInputBox(lines);
  if (box.state === 'missing') return { ready: false, reason: NO_INPUT_BOX_REASON };
  // The cursor check is required, not a refinement: dim text at the caret reads as Claude's placeholder by style
  // alone, and only a cursor that sits right after the prompt shows that nothing was typed.
  if (box.state !== 'empty' || cursor.x !== box.column || cursor.y !== box.row)
    return { ready: false, reason: UNSENT_TEXT_REASON };
  return { ready: true };
}

/** Time for the wait after the paste; tests inject their own. */
export interface TypingClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
const realTime: TypingClock = { now: () => Date.now(), sleep: (ms) => delay(ms) };
/** Claude's input box shows something: the pasted text, or the chip for a long paste. A failed read shows nothing. */
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

export type TerminalSend =
  | { state: 'held'; reason: string }
  | { state: 'failed'; reason: string }
  | { state: 'typed'; nativeAfterRevision: number }
  | { state: 'unconfirmed'; reason: string; nativeAfterRevision: number };
/**
 * Types one message into Claude's input once the terminal is clear. `held` and `failed` mean nothing was typed.
 * `paneRunsSession` is asked again right before the buffer is loaded. `onTyping` runs after the buffer is ready and
 * before the paste; if it throws, nothing is typed. Enter follows once the paste shows. Windows line endings are
 * typed as line feeds; any other carriage return is refused like the other control characters.
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
  let check: TerminalCheck;
  try {
    check = await checkTerminal(input.terminal, input.session);
  } catch {
    return { state: 'held', reason: TERMINAL_READ_REASON };
  }
  if (!check.ready) return { state: 'held', reason: check.reason };
  // `/resume` or `/clear` may have switched the pane to another session while the screen was read.
  if (!(await input.paneRunsSession().catch(() => false)))
    return { state: 'failed', reason: SESSION_SWITCHED_REASON };
  const buffer = pasteBufferName(input.requestId);
  // Best effort: the buffer holds only this message's text, and a leftover is never pasted by anything else.
  const discard = () => input.terminal.deleteBuffer(buffer).catch(() => undefined);
  let nativeAfterRevision: number;
  try {
    nativeAfterRevision = await input.transcriptSize();
    await input.terminal.loadBuffer(buffer, body);
  } catch {
    await discard();
    return { state: 'failed', reason: PASTE_PREPARE_REASON };
  }
  try {
    input.onTyping({ nativeAfterRevision });
  } catch {
    await discard();
    return { state: 'failed', reason: PASTE_PREPARE_REASON };
  }
  try {
    await input.terminal.pasteBuffer(buffer);
    await waitForPaste(input.terminal, input.clock ?? realTime);
    await input.terminal.pressEnter();
  } catch {
    await discard();
    return { state: 'unconfirmed', reason: TYPING_UNCERTAIN_REASON, nativeAfterRevision };
  }
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
