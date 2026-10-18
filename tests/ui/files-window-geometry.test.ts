import { expect, it } from 'vitest';
import {
  clampFilesWindow,
  defaultFilesWindow,
  filesWindowGeometry,
} from '../../src/ui/files-window-geometry.js';

it('centres the default window and shrinks it to a small viewport', () => {
  expect(defaultFilesWindow({ width: 1440, height: 900 })).toEqual({
    x: 270,
    y: 140,
    width: 900,
    height: 620,
    split: 270,
  });
  expect(defaultFilesWindow({ width: 600, height: 400 })).toMatchObject({
    x: 0,
    y: 0,
    width: 600,
    height: 400,
  });
});
it('pulls an off-screen window fully into view', () => {
  expect(
    clampFilesWindow(
      { x: 2400, y: 10, width: 900, height: 620, split: 270 },
      { width: 1440, height: 900 },
    ),
  ).toEqual({ x: 540, y: 10, width: 900, height: 620, split: 270 });
  expect(
    clampFilesWindow(
      { x: -50, y: -9, width: 900, height: 620, split: 270 },
      { width: 1440, height: 900 },
    ),
  ).toMatchObject({ x: 0, y: 0 });
});
it('shrinks to a small viewport and keeps both panes usable', () => {
  const g = clampFilesWindow(
    { x: 100, y: 100, width: 900, height: 620, split: 700 },
    { width: 600, height: 400 },
  );
  expect(g).toMatchObject({ x: 0, y: 0, width: 600, height: 400 });
  expect(g.split).toBe(600 - 240);
});
it('keeps the minimum size unless the viewport is smaller, and rounds values', () => {
  expect(
    clampFilesWindow(
      { x: 0, y: 0, width: 100, height: 100, split: 10 },
      { width: 1440, height: 900 },
    ),
  ).toEqual({ x: 0, y: 0, width: 480, height: 320, split: 160 });
  expect(
    clampFilesWindow(
      { x: 0, y: 0, width: 300, height: 200, split: 100 },
      { width: 300, height: 200 },
    ),
  ).toMatchObject({ width: 300, height: 200, split: 160 });
  expect(
    clampFilesWindow(
      { x: 10.4, y: 10.6, width: 900.2, height: 620.5, split: 270.4 },
      { width: 1440, height: 900 },
    ),
  ).toEqual({ x: 10, y: 11, width: 900, height: 621, split: 270 });
});
it('rejects malformed persisted geometry', () => {
  for (const bad of [
    null,
    'x',
    { x: 1 },
    { x: NaN, y: 0, width: 900, height: 620, split: 270 },
    { x: 0, y: 0, width: '900', height: 620, split: 270 },
  ])
    expect(filesWindowGeometry(bad)).toBeUndefined();
  expect(filesWindowGeometry({ x: 1, y: 2, width: 900, height: 620, split: 270 })).toEqual({
    x: 1,
    y: 2,
    width: 900,
    height: 620,
    split: 270,
  });
});
