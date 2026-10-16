import { expect, it } from 'vitest';
import {
  chunkInput,
  shouldAutoOpen,
  shouldAutoOpenLaunch,
  MAX_INPUT_CHUNK,
  noteKeystroke,
  lastKeystrokeAt,
  terminalTitle,
} from '../../src/ui/launch-controls.js';

const entry = { key: 'k', sessionId: 'S', launchId: 'L1', activity: 'approval-required' } as any;
it('never opens in dot-only mode', () => {
  expect(shouldAutoOpen(entry, 'S', 'dot-only', 0, 10_000)).toBe(false);
});
it('never opens a session that is not shown', () => {
  expect(shouldAutoOpen(entry, 'other', 'auto', 0, 10_000)).toBe(false);
});
it('needs a launched session that is waiting for approval', () => {
  expect(shouldAutoOpen({ ...entry, launchId: undefined }, 'S', 'auto', 0, 10_000)).toBe(false);
  expect(shouldAutoOpen({ ...entry, activity: 'idle' }, 'S', 'auto', 0, 10_000)).toBe(false);
  expect(shouldAutoOpen(undefined, 'S', 'auto', 0, 10_000)).toBe(false);
});
it('waits two seconds after the last keystroke', () => {
  expect(shouldAutoOpen(entry, 'S', 'auto', 9_001, 10_000)).toBe(false);
  expect(shouldAutoOpen(entry, 'S', 'auto', 8_000, 10_000)).toBe(true);
  expect(shouldAutoOpen(entry, 'S', 'current-tab', 8_000, 10_000)).toBe(true);
});
it('splits large input into frames well under the server limit without losing text', () => {
  const big = 'a'.repeat(MAX_INPUT_CHUNK * 3 + 5);
  const parts = chunkInput(big);
  expect(parts.length).toBe(4);
  expect(parts.join('')).toBe(big);
  for (const p of parts)
    expect(
      new TextEncoder().encode(JSON.stringify({ type: 'input', data: p })).length,
    ).toBeLessThan(65536);
  expect(chunkInput('')).toEqual([]);
});
it('does not split a surrogate pair across frames', () => {
  const text = '😀'.repeat(MAX_INPUT_CHUNK);
  for (const p of chunkInput(text)) expect(p).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/);
  expect(chunkInput(text).join('')).toBe(text);
});

const placeholder = { key: 'launch:L1', launchId: 'L1', activity: 'approval-required' } as any;
it('opens a waiting placeholder launch regardless of selection', () => {
  expect(shouldAutoOpenLaunch(placeholder, 'other', 'auto', 0, 10_000)).toBe(true);
  expect(shouldAutoOpenLaunch(placeholder, 'other', 'current-tab', 0, 10_000)).toBe(true);
});
it('waiting launch respects dot-only, typing delay, and activity', () => {
  expect(shouldAutoOpenLaunch(placeholder, 'x', 'dot-only', 0, 10_000)).toBe(false);
  expect(shouldAutoOpenLaunch(placeholder, 'x', 'auto', 9_500, 10_000)).toBe(false);
  expect(shouldAutoOpenLaunch({ ...placeholder, activity: 'idle' }, 'x', 'auto', 0, 10_000)).toBe(
    false,
  );
});
it('leaves an identified, shown session to the per-session auto-open', () => {
  expect(shouldAutoOpenLaunch({ ...placeholder, sessionId: 'S' }, 'S', 'auto', 0, 10_000)).toBe(
    false,
  );
  expect(shouldAutoOpenLaunch({ ...placeholder, sessionId: 'S' }, 'T', 'auto', 0, 10_000)).toBe(
    true,
  );
});
it('shares one last-keystroke time between the session and launch auto-open paths', () => {
  noteKeystroke(9_000);
  expect(shouldAutoOpen(entry, 'S', 'auto', lastKeystrokeAt(), 10_000)).toBe(false);
  expect(
    shouldAutoOpenLaunch(
      { ...entry, sessionId: undefined },
      'other',
      'auto',
      lastKeystrokeAt(),
      10_000,
    ),
  ).toBe(false);
  expect(shouldAutoOpen(entry, 'S', 'auto', lastKeystrokeAt(), 11_000)).toBe(true);
});

it('names a terminal by its title, project and folder', () => {
  expect(
    terminalTitle({
      title: 'Terminal',
      projectName: 'gloss',
      folder: '/Users/k/gloss/.worktrees/terminal',
    }),
  ).toBe('Terminal · gloss / terminal');
  expect(
    terminalTitle({ title: 'Terminal 2', projectName: 'gloss', folder: '/Users/k/gloss' }),
  ).toBe('Terminal 2 · gloss / gloss');
});
