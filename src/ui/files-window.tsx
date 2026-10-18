import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import type { LanguageSettings } from '../core/language-settings.js';
import { FilePreviewPane } from './file-browser.js';
import {
  clampFilesWindow,
  defaultFilesWindow,
  type FilesWindowGeometry,
  type Viewport,
  type ViewportArea,
} from './files-window-geometry.js';
import type { SessionClient } from './session-client.js';
import './files-window.css';

const readViewport = (): Viewport => ({ width: innerWidth, height: innerHeight });
const AGENT_AREA = '.session-column main.app';
/** The agent area beside the Files column that the default window centres over; the whole viewport when absent. */
const readAgentArea = (): ViewportArea | undefined => {
  const rect = document.querySelector(AGENT_AREA)?.getBoundingClientRect();
  return rect && { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
};
const sameArea = (a: ViewportArea | undefined, b: ViewportArea | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height);

/**
 * Tracks the agent area. It is re-read after mount, because the Files column may be added in the same commit
 * that mounts the window; when the area resizes (the column opening or closing, the viewport or sidebar changing);
 * and when the column is added, removed or moves to the other side, which can move the area without resizing it.
 */
function useAgentArea(): ViewportArea | undefined {
  const [area, setArea] = useState(readAgentArea);
  useLayoutEffect(() => {
    const update = () => {
      const next = readAgentArea();
      setArea((current) => (sameArea(current, next) ? current : next));
    };
    update();
    const element = document.querySelector(AGENT_AREA);
    if (!element) return;
    const resized = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    resized?.observe(element);
    const moved = new MutationObserver(update);
    if (element.parentElement)
      moved.observe(element.parentElement, {
        childList: true,
        attributes: true,
        attributeFilter: ['data-side'],
      });
    return () => {
      resized?.disconnect();
      moved.disconnect();
    };
  }, []);
  return area;
}
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

/**
 * Movable, resizable, expandable non-modal popup showing one session file. The docked Files column is the list;
 * choosing another file there swaps this popup's content.
 */
export function FilesWindow({
  client,
  languageSettings,
  path,
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
  path: string;
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
  const agentArea = useAgentArea();
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const resize = () => setViewport(readViewport());
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => closeButton.current?.focus(), []);
  // Stored geometry is unclamped; fit it to the live viewport every render.
  const fitted = geometry
    ? clampFilesWindow(geometry, viewport)
    : defaultFilesWindow(viewport, agentArea);
  const { shown, surface } = useGeometryDrag(fitted, onGeometry);
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
  return (
    <div
      className="files-window"
      role="dialog"
      aria-modal="false"
      aria-label="File preview"
      dir="ltr"
      data-expanded={expanded}
      style={
        expanded ? {} : { left: shown.x, top: shown.y, width: shown.width, height: shown.height }
      }
      onKeyDown={(e) => {
        // The preview's own controls may consume Escape first.
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        if (expanded) setExpanded(false);
        else onClose();
      }}
    >
      <div className="files-window-title" {...(expanded ? {} : surface(moveBy))}>
        <strong title={path}>{path.split('/').at(-1)}</strong>
        <button type="button" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Collapse' : 'Expand'}
        </button>
        <button
          ref={closeButton}
          type="button"
          className="files-window-close"
          onClick={onClose}
          aria-label="Close file preview"
          title="Close file preview"
        >
          ×
        </button>
      </div>
      <div className="files-window-preview">
        <FilePreviewPane
          client={client}
          languageSettings={languageSettings}
          path={path}
          busy={busy}
          attachError={attachError}
          attached={attached}
          onAttach={onAttach}
        />
      </div>
      {!expanded && (
        <div className="files-window-resize" aria-hidden="true" {...surface(resizeBy)} />
      )}
    </div>
  );
}
