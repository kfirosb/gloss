import { describe, expect, it } from 'vitest';
import {
  parseStyledScreen,
  readInputWindow,
  type ReadableWindow,
} from '../../src/agents/claude/tmux-screen.js';
import {
  INPUT_NOT_READY_REASON,
  STASHED_TEXT_NOTE,
  nextStashStep,
  notReadyReason,
  type StashStart,
} from '../../src/agents/claude/tmux-stash.js';
import { STASH_FIXTURE_VERSIONS, readWindow } from './tmux-fixtures.js';

describe.each(STASH_FIXTURE_VERSIONS)('stash steps on captured Claude %s screens', (version) => {
  const at = (state: string): ReadableWindow => {
    const w = readWindow(version, state);
    const lines = parseStyledScreen(w.text);
    const read = lines && readInputWindow(lines, w.cursorRow, w.cursorColumn);
    if (!read?.readable) throw new Error(`${state} has no readable input window`);
    return read;
  };
  const start = (state: string): StashStart => {
    const { stashed, emptyAtPrompt } = at(state);
    return { stashed, emptyAtPrompt };
  };
  it('no stash, empty box: one Ctrl+S changes nothing, then the paste', () => {
    expect(nextStashStep(start('stash-empty'), 1, at('stash-empty-after'))).toBe('paste');
  });
  it('no stash, text: pastes only once Claude shows the box empty under the marker', () => {
    expect(nextStashStep(start('stash-typed'), 1, at('stash-typed'))).toBe('wait');
    expect(nextStashStep(start('stash-typed'), 1, at('stash-stashed'))).toBe('paste');
  });
  it('stash and text: the text replaces the old stash, then the paste', () => {
    expect(nextStashStep(start('stash-stashed-typed'), 1, at('stash-stashed-typed'))).toBe('wait');
    expect(nextStashStep(start('stash-stashed-typed'), 1, at('stash-replaced'))).toBe('paste');
  });
  it('stash and an empty box: waits for the pop, presses again, then pastes over the stash put back', () => {
    const empty = start('stash-replaced');
    // Before Claude handles the press the screen still looks ready: that must never be taken for its result.
    expect(nextStashStep(empty, 1, at('stash-replaced'))).toBe('wait');
    expect(nextStashStep(empty, 1, at('stash-popped'))).toBe('press-again');
    expect(nextStashStep(empty, 2, at('stash-popped'))).toBe('wait');
    expect(nextStashStep(empty, 2, at('stash-restashed'))).toBe('paste');
  });
  it('pastes while Claude works once the box is set aside', () => {
    expect(nextStashStep({ stashed: false, emptyAtPrompt: false }, 1, at('stash-working'))).toBe(
      'paste',
    );
  });
  it('never pastes into a box with text in it', () => {
    for (const s of [
      { stashed: false, emptyAtPrompt: false },
      { stashed: true, emptyAtPrompt: false },
    ])
      for (const state of ['stash-typed', 'stash-stashed-typed', 'stash-popped', 'stash-restored'])
        for (const presses of [1, 2] as const)
          expect(nextStashStep(s, presses, at(state)), state).not.toBe('paste');
  });
});
describe('stash steps on synthetic window readings', () => {
  // Synthetic: readings no capture shows, built by hand to pin the decision's edges.
  const window = (stashed: boolean, emptyAtPrompt: boolean): ReadableWindow => ({
    readable: true,
    stashed,
    emptyAtPrompt,
  });
  it('asks for a second press only after the first one popped a stash into an empty box', () => {
    for (const start of [
      { stashed: false, emptyAtPrompt: true },
      { stashed: false, emptyAtPrompt: false },
      { stashed: true, emptyAtPrompt: false },
    ])
      for (const presses of [1, 2] as const)
        for (const now of [window(false, false), window(false, true), window(true, false)])
          expect(nextStashStep(start, presses, now)).not.toBe('press-again');
    for (const now of [window(false, false), window(false, true), window(true, true)])
      expect(nextStashStep({ stashed: true, emptyAtPrompt: true }, 2, now)).not.toBe('press-again');
  });
  it('waits when the text left the box but no marker shows, unless nothing was there to stash', () => {
    expect(nextStashStep({ stashed: false, emptyAtPrompt: false }, 1, window(false, true))).toBe(
      'wait',
    );
    expect(nextStashStep({ stashed: true, emptyAtPrompt: false }, 1, window(false, true))).toBe(
      'wait',
    );
    expect(nextStashStep({ stashed: true, emptyAtPrompt: true }, 2, window(false, true))).toBe(
      'wait',
    );
    // A pop always fills the box: an empty box without the marker after the first press is not one.
    expect(nextStashStep({ stashed: true, emptyAtPrompt: true }, 1, window(false, true))).toBe(
      'wait',
    );
    expect(nextStashStep({ stashed: false, emptyAtPrompt: true }, 2, window(false, true))).toBe(
      'wait',
    );
  });
});
describe('stash reasons', () => {
  it('says the text is set aside only when the marker shows', () => {
    expect(notReadyReason(undefined)).toBe(INPUT_NOT_READY_REASON);
    expect(notReadyReason({ readable: false })).toBe(INPUT_NOT_READY_REASON);
    expect(notReadyReason({ readable: true, stashed: false, emptyAtPrompt: false })).toBe(
      INPUT_NOT_READY_REASON,
    );
    expect(notReadyReason({ readable: true, stashed: true, emptyAtPrompt: false })).toBe(
      `${INPUT_NOT_READY_REASON}. ${STASHED_TEXT_NOTE}`,
    );
  });
});
