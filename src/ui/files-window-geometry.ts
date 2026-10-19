/** Geometry of the movable Files window, in CSS pixels. `split` is the list pane width. */
export interface FilesWindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  split: number;
}
export interface Viewport {
  width: number;
  height: number;
}
export const FILES_WINDOW_MIN = { width: 480, height: 320, list: 160, preview: 240 } as const;
export const FILES_WINDOW_DEFAULT = { width: 900, height: 620, split: 270 } as const;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
// Fits a size to the viewport, keeping the minimum unless the viewport itself is smaller.
const fitSize = (value: number, min: number, available: number) =>
  Math.round(clamp(value, Math.min(min, available), available));

/** A rectangle within the viewport, such as the agent column. */
export interface ViewportArea extends Viewport {
  left: number;
  top: number;
}

/** Default geometry centred over `area` (the whole viewport when omitted), kept inside the viewport; smaller viewports shrink it to fit. */
export function defaultFilesWindow(
  viewport: Viewport,
  area: ViewportArea = { left: 0, top: 0, ...viewport },
): FilesWindowGeometry {
  return clampFilesWindow(
    {
      x: area.left + (area.width - FILES_WINDOW_DEFAULT.width) / 2,
      y: area.top + (area.height - FILES_WINDOW_DEFAULT.height) / 2,
      ...FILES_WINDOW_DEFAULT,
    },
    viewport,
  );
}

/** Fits width/height to the viewport, keeps the whole window inside it, and keeps split within [list min, width - preview min]. */
export function clampFilesWindow(
  geometry: FilesWindowGeometry,
  viewport: Viewport,
): FilesWindowGeometry {
  const width = fitSize(geometry.width, FILES_WINDOW_MIN.width, viewport.width);
  const height = fitSize(geometry.height, FILES_WINDOW_MIN.height, viewport.height);
  const maxSplit = width - FILES_WINDOW_MIN.preview;
  return {
    x: Math.round(clamp(geometry.x, 0, viewport.width - width)),
    y: Math.round(clamp(geometry.y, 0, viewport.height - height)),
    width,
    height,
    split: Math.round(
      maxSplit < FILES_WINDOW_MIN.list
        ? FILES_WINDOW_MIN.list
        : clamp(geometry.split, FILES_WINDOW_MIN.list, maxSplit),
    ),
  };
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Narrows persisted data; malformed or non-finite values yield undefined. */
export function filesWindowGeometry(value: unknown): FilesWindowGeometry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { x, y, width, height, split } = value as Record<string, unknown>;
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height) || !finite(split))
    return undefined;
  return { x, y, width, height, split };
}
