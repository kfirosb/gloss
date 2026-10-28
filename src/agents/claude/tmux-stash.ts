import type { InputWindow, ReadableWindow } from './tmux-screen.js';

/** What the input window showed before Gloss's first Ctrl+S. */
export interface StashStart {
  stashed: boolean;
  emptyAtPrompt: boolean;
}
export type StashStep = 'wait' | 'press-again' | 'paste';
/**
 * Spec 2.6: what a settled input window means after Gloss's `presses`-th Ctrl+S. Claude has one stash slot: Ctrl+S
 * moves the box's text into it (replacing an older stash), and on an empty box brings the stash back. `wait` means
 * the window does not yet show the expected result; past the settle bound the caller opens the terminal.
 */
export function nextStashStep(start: StashStart, presses: 1 | 2, now: ReadableWindow): StashStep {
  // Stash and an empty box: the press pops the stash into the box. Until the marker goes, the screen still looks like
  // it did before the press, so only its disappearance shows Claude handled it; a real pop always fills the box.
  if (presses === 1 && start.stashed && start.emptyAtPrompt)
    return !now.stashed && !now.emptyAtPrompt ? 'press-again' : 'wait';
  if (!now.emptyAtPrompt) return 'wait';
  if (now.stashed) return 'paste';
  // Without the marker only an empty box with no stash may look unchanged: Ctrl+S on it does nothing.
  return presses === 1 && !start.stashed && start.emptyAtPrompt ? 'paste' : 'wait';
}
export const INPUT_UNREADABLE_REASON =
  'Gloss doesn’t recognise what’s drawn under Claude’s input box (a popup or menu may be open); nothing was sent';
export const INPUT_NOT_READY_REASON =
  'The terminal’s input wasn’t ready for the message; nothing was sent';
/** The input window changed between the cursor check and the paste: the user may be typing in the terminal. */
export const INPUT_CHANGED_REASON =
  'The terminal’s input changed before Gloss could type; nothing was sent';
/** Spec 2.6 step 5, added when the marker shows: the user's draft is in Claude's stash slot, not lost. */
export const STASHED_TEXT_NOTE =
  'Your text is set aside: Claude puts it back after your next message, or press Ctrl+S in the terminal';
/** A refusal after Ctrl+S ran: adds STASHED_TEXT_NOTE when the last window Gloss read shows the marker. */
export const withStashNote = (reason: string, last: InputWindow | undefined) =>
  last?.readable && last.stashed ? `${reason}. ${STASHED_TEXT_NOTE}` : reason;
/** Why Gloss did not paste after its Ctrl+S, from the last window it read. */
export const notReadyReason = (last: InputWindow | undefined) =>
  withStashNote(INPUT_NOT_READY_REASON, last);
