import { expect, it } from 'vitest';
import { isTerminalWheel, wheelLineCounter } from '../../src/core/terminal-wheel.js';

it('turns mouse-wheel notches, pages and trackpad pixels into whole lines', () => {
  const count = wheelLineCounter();
  expect(count({ deltaY: -100, deltaMode: 0 }, 20, 24)).toBe(-5);
  expect(count({ deltaY: 3, deltaMode: 1 }, 20, 24)).toBe(3);
  expect(count({ deltaY: 1, deltaMode: 2 }, 20, 24)).toBe(24);
  // Small trackpad deltas accumulate until they make a line.
  const trackpad = wheelLineCounter();
  const lines = Array.from({ length: 11 }, () => trackpad({ deltaY: 20, deltaMode: 0 }, 20, 24));
  expect(lines.reduce((a, b) => a + b, 0)).toBe(3);
  expect(lines.slice(0, 3)).toEqual([0, 0, 0]);
});
it('accepts only bounded whole-line movements at a real cell', () => {
  expect(isTerminalWheel({ lines: -50, col: 1, row: 1000 })).toBe(true);
  expect(isTerminalWheel({ lines: 0, col: 1, row: 1 })).toBe(false);
  expect(isTerminalWheel({ lines: 51, col: 1, row: 1 })).toBe(false);
  expect(isTerminalWheel({ lines: NaN, col: 1, row: 1 })).toBe(false);
  expect(isTerminalWheel({ lines: 1, col: 0.5, row: 1 })).toBe(false);
});
