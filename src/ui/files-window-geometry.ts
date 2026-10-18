/** Geometry of the movable file preview window, in CSS pixels. */
export interface FilesWindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Viewport {
  width: number;
  height: number;
}
export const FILES_WINDOW_MIN = { width: 360, height: 240 } as const;
export const FILES_WINDOW_DEFAULT = { width: 760, height: 620 } as const;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
// Fits a size to the viewport, keeping the minimum unless the viewport itself is smaller.
const fitSize = (value: number, min: number, available: number) =>
  Math.round(clamp(value, Math.min(min, available), available));

/** A rectangle within the viewport, such as the agent area beside the Files column. */
export interface ViewportArea extends Viewport {
  left: number;
  top: number;
}

/**
 * Default geometry centred over `area` (the whole viewport when omitted). It narrows to fit an area smaller than
 * the default, down to the minimum size, so it does not cover what lies beside the area; it is kept inside the viewport.
 */
export function defaultFilesWindow(
  viewport: Viewport,
  area: ViewportArea = { left: 0, top: 0, ...viewport },
): FilesWindowGeometry {
  const width = Math.max(Math.min(FILES_WINDOW_DEFAULT.width, area.width), FILES_WINDOW_MIN.width);
  const height = Math.max(
    Math.min(FILES_WINDOW_DEFAULT.height, area.height),
    FILES_WINDOW_MIN.height,
  );
  return clampFilesWindow(
    {
      x: area.left + (area.width - width) / 2,
      y: area.top + (area.height - height) / 2,
      width,
      height,
    },
    viewport,
  );
}

/** Fits width/height to the viewport and keeps the whole window inside it. */
export function clampFilesWindow(
  geometry: FilesWindowGeometry,
  viewport: Viewport,
): FilesWindowGeometry {
  const width = fitSize(geometry.width, FILES_WINDOW_MIN.width, viewport.width);
  const height = fitSize(geometry.height, FILES_WINDOW_MIN.height, viewport.height);
  return {
    x: Math.round(clamp(geometry.x, 0, viewport.width - width)),
    y: Math.round(clamp(geometry.y, 0, viewport.height - height)),
    width,
    height,
  };
}

/** The docked Files column's horizontal extent and the edge it sits on. */
export interface FilesColumn {
  left: number;
  right: number;
  side: 'left' | 'right';
}
/** Left and right insets of the expanded window, in CSS pixels from each viewport edge. */
export interface ExpandedInsets {
  left: number;
  right: number;
}

/**
 * Expanded fills the viewport beside the Files column, so the column stays usable. Without a column, or when what
 * is left beside it is narrower than the minimum window (a narrow viewport, where the column floats), it fills
 * the whole viewport.
 */
export function expandedFilesWindow(viewport: Viewport, column?: FilesColumn): ExpandedInsets {
  if (!column) return { left: 0, right: 0 };
  const insets =
    column.side === 'left'
      ? { left: Math.round(Math.max(column.right, 0)), right: 0 }
      : { left: 0, right: Math.round(Math.max(viewport.width - column.left, 0)) };
  return viewport.width - insets.left - insets.right < FILES_WINDOW_MIN.width
    ? { left: 0, right: 0 }
    : insets;
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * Narrows persisted data; malformed or non-finite values yield undefined. Blobs from 0.14.0 also carry the list
 * width as `split`, which is ignored.
 */
export function filesWindowGeometry(value: unknown): FilesWindowGeometry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { x, y, width, height } = value as Record<string, unknown>;
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return undefined;
  return { x, y, width, height };
}
