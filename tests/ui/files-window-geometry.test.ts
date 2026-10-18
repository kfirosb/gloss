import { expect, it } from 'vitest';
import {
  clampFilesWindow,
  defaultFilesWindow,
  filesWindowGeometry,
} from '../../src/ui/files-window-geometry.js';

it('centres the default window and shrinks it to a small viewport', () => {
  expect(defaultFilesWindow({ width: 1440, height: 900 })).toEqual({
    x: 340,
    y: 140,
    width: 760,
    height: 620,
  });
  expect(defaultFilesWindow({ width: 600, height: 400 })).toEqual({
    x: 0,
    y: 0,
    width: 600,
    height: 400,
  });
});
it('centres the default window over a given area and keeps it inside the viewport', () => {
  // A 980px agent area beside a 300px sessions sidebar.
  expect(
    defaultFilesWindow(
      { width: 1280, height: 800 },
      { left: 300, top: 0, width: 980, height: 800 },
    ),
  ).toEqual({ x: 410, y: 90, width: 760, height: 620 });
  // An area narrower than the default narrows the window to fit it, beside the docked Files column.
  expect(
    defaultFilesWindow(
      { width: 1280, height: 800 },
      { left: 550, top: 80, width: 730, height: 720 },
    ),
  ).toEqual({ x: 550, y: 130, width: 730, height: 620 });
  // Below the minimum size the window keeps the minimum and stays fully inside the viewport.
  expect(
    defaultFilesWindow(
      { width: 1000, height: 800 },
      { left: 600, top: 100, width: 300, height: 200 },
    ),
  ).toEqual({ x: 570, y: 80, width: 360, height: 240 });
});
it('pulls an off-screen window fully into view', () => {
  expect(
    clampFilesWindow({ x: 2400, y: 10, width: 900, height: 620 }, { width: 1440, height: 900 }),
  ).toEqual({ x: 540, y: 10, width: 900, height: 620 });
  expect(
    clampFilesWindow({ x: -50, y: -9, width: 900, height: 620 }, { width: 1440, height: 900 }),
  ).toMatchObject({ x: 0, y: 0 });
});
it('keeps the minimum size unless the viewport is smaller, and rounds values', () => {
  expect(
    clampFilesWindow({ x: 0, y: 0, width: 100, height: 100 }, { width: 1440, height: 900 }),
  ).toEqual({ x: 0, y: 0, width: 360, height: 240 });
  expect(
    clampFilesWindow({ x: 0, y: 0, width: 300, height: 200 }, { width: 300, height: 200 }),
  ).toEqual({ x: 0, y: 0, width: 300, height: 200 });
  expect(
    clampFilesWindow(
      { x: 10.4, y: 10.6, width: 900.2, height: 620.5 },
      { width: 1440, height: 900 },
    ),
  ).toEqual({ x: 10, y: 11, width: 900, height: 621 });
});
it('rejects malformed persisted geometry and reads blobs that still carry the old split', () => {
  for (const bad of [
    null,
    'x',
    { x: 1 },
    { x: NaN, y: 0, width: 900, height: 620 },
    { x: 0, y: 0, width: '900', height: 620 },
  ])
    expect(filesWindowGeometry(bad)).toBeUndefined();
  expect(filesWindowGeometry({ x: 1, y: 2, width: 900, height: 620 })).toEqual({
    x: 1,
    y: 2,
    width: 900,
    height: 620,
  });
  // 0.14.0 stored the list width as `split`; it is ignored, not a reason to drop the geometry.
  expect(filesWindowGeometry({ x: 1, y: 2, width: 900, height: 620, split: 270 })).toEqual({
    x: 1,
    y: 2,
    width: 900,
    height: 620,
  });
  // A malformed split no longer matters either.
  expect(filesWindowGeometry({ x: 1, y: 2, width: 900, height: 620, split: 'wide' })).toEqual({
    x: 1,
    y: 2,
    width: 900,
    height: 620,
  });
});
