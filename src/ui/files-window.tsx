import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { LanguageSettings } from '../core/language-settings.js';
import { FileBrowser, FilePreviewPane } from './file-browser.js';
import {
  clampFilesWindow,
  defaultFilesWindow,
  FILES_WINDOW_MIN,
  type FilesWindowGeometry,
  type Viewport,
} from './files-window-geometry.js';
import type { SessionClient } from './session-client.js';
import './files-window.css';

/** Pixels the split handle moves per arrow key, matching the sidebar divider. */
const SPLIT_KEY_STEP = 20;

const readViewport = (): Viewport => ({ width: innerWidth, height: innerHeight });
const splitLimits = (paneWidth: number) => ({
  min: FILES_WINDOW_MIN.list,
  max: Math.max(FILES_WINDOW_MIN.list, paneWidth - FILES_WINDOW_MIN.preview),
});
const clampSplit = (split: number, paneWidth: number) => {
  const { min, max } = splitLimits(paneWidth);
  return Math.round(Math.min(Math.max(split, min), max));
};

/** Maps the pointer offset since the drag started to the geometry shown for it. */
type DragApply = (start: FilesWindowGeometry, dx: number, dy: number) => FilesWindowGeometry;

/**
 * Shared pointer handling for the window's drag surfaces: the drag is shown live and committed once,
 * when the pointer is released or the drag is cancelled.
 */
function useGeometryDrag(base: FilesWindowGeometry, commit: (next: FilesWindowGeometry) => void) {
  const [live, setLive] = useState<FilesWindowGeometry | null>(null);
  const drag = useRef<{
    x: number;
    y: number;
    start: FilesWindowGeometry;
    latest: FilesWindowGeometry;
  } | null>(null);
  const shown = live ?? base;
  const finish = () => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    setLive(null);
    if (current.latest !== current.start) commit(current.latest);
  };
  const surface = (apply: DragApply) => ({
    onPointerDown(e: PointerEvent<HTMLElement>) {
      // Buttons inside a drag surface (the title bar's Expand and Close) keep their own clicks.
      if (e.button !== 0 || (e.target instanceof Element && e.target.closest('button'))) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { x: e.clientX, y: e.clientY, start: shown, latest: shown };
    },
    onPointerMove(e: PointerEvent<HTMLElement>) {
      const current = drag.current;
      if (!current) return;
      current.latest = apply(current.start, e.clientX - current.x, e.clientY - current.y);
      setLive(current.latest);
    },
    onPointerUp: finish,
    onPointerCancel: finish,
  });
  return { shown, surface };
}

/** Movable, resizable, expandable non-modal window with the session file list beside the preview. */
export function FilesWindow({
  client,
  languageSettings,
  revealedFile,
  path,
  onSelect,
  onClose,
  busy,
  attachError,
  attached,
  onAttach,
  geometry,
  onGeometry,
}: {
  client: SessionClient;
  languageSettings: LanguageSettings;
  revealedFile: string;
  path: string | null;
  onSelect(path: string): void;
  onClose(): void;
  busy: boolean;
  attachError: string;
  attached: string;
  onAttach(): void;
  geometry: FilesWindowGeometry | undefined;
  onGeometry(next: FilesWindowGeometry): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [viewport, setViewport] = useState(readViewport);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const resize = () => setViewport(readViewport());
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => closeButton.current?.focus(), []);
  // Stored geometry is unclamped; fit it to the live viewport every render.
  const base = geometry ? clampFilesWindow(geometry, viewport) : defaultFilesWindow(viewport);
  const { shown, surface } = useGeometryDrag(base, onGeometry);
  const paneWidth = expanded ? viewport.width : shown.width;
  const split = clampSplit(shown.split, paneWidth);
  const limits = splitLimits(paneWidth);
  const moveBy: DragApply = (start, dx, dy) =>
    clampFilesWindow({ ...start, x: start.x + dx, y: start.y + dy }, viewport);
  const resizeBy: DragApply = (start, dx, dy) =>
    clampFilesWindow(
      {
        ...start,
        width: Math.min(start.width + dx, viewport.width - start.x),
        height: Math.min(start.height + dy, viewport.height - start.y),
      },
      viewport,
    );
  const splitBy: DragApply = (start, dx) => ({
    ...start,
    split: clampSplit(clampSplit(start.split, paneWidth) + dx, paneWidth),
  });
  const splitKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next =
      e.key === 'Home'
        ? limits.min
        : e.key === 'End'
          ? limits.max
          : e.key === 'ArrowLeft'
            ? split - SPLIT_KEY_STEP
            : e.key === 'ArrowRight'
              ? split + SPLIT_KEY_STEP
              : undefined;
    if (next === undefined) return;
    e.preventDefault();
    onGeometry({ ...shown, split: clampSplit(next, paneWidth) });
  };
  return (
    <div
      className="files-window"
      role="dialog"
      aria-modal="false"
      aria-label="Files"
      dir="ltr"
      data-expanded={expanded}
      style={
        {
          '--files-split': split + 'px',
          ...(expanded
            ? {}
            : { left: shown.x, top: shown.y, width: shown.width, height: shown.height }),
        } as React.CSSProperties
      }
      onKeyDown={(e) => {
        // The tree, inputs and the preview may consume Escape first.
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        if (expanded) setExpanded(false);
        else onClose();
      }}
    >
      <div className="files-window-title" {...(expanded ? {} : surface(moveBy))}>
        <strong>Files</strong>
        <button type="button" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Collapse' : 'Expand'}
        </button>
        <button
          ref={closeButton}
          type="button"
          className="files-window-close"
          onClick={onClose}
          aria-label="Close files"
          title="Close files"
        >
          ×
        </button>
      </div>
      <div className="files-window-list">
        <FileBrowser client={client} revealedFile={revealedFile} onPreview={onSelect} />
      </div>
      <div
        className="files-window-split"
        role="separator"
        tabIndex={0}
        aria-label="File list width"
        aria-orientation="vertical"
        aria-valuemin={limits.min}
        aria-valuemax={limits.max}
        aria-valuenow={split}
        title="Drag to resize · Arrow keys also work"
        {...surface(splitBy)}
        onKeyDown={splitKey}
      />
      <div className="files-window-preview">
        {path === null ? (
          <p className="files-window-empty">Select a file to preview</p>
        ) : (
          <FilePreviewPane
            client={client}
            languageSettings={languageSettings}
            path={path}
            busy={busy}
            attachError={attachError}
            attached={attached}
            onAttach={onAttach}
          />
        )}
      </div>
      {!expanded && (
        <div className="files-window-resize" aria-hidden="true" {...surface(resizeBy)} />
      )}
    </div>
  );
}
