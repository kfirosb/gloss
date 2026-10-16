import { useRef, useState, type ReactNode } from 'react';
export const SIDEBAR_MIN = 240,
  SIDEBAR_MAX = 440;
const clamp = (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)));
/** Holds the sidebar at `width` with a draggable, keyboard-operable divider; the width is committed when a drag ends. */
export function SidebarFrame({
  width,
  onWidth,
  collapsed,
  children,
}: {
  width: number;
  onWidth(width: number): void;
  collapsed: boolean;
  children: ReactNode;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const shown = dragging ?? width;
  const fromPointer = (x: number) => clamp(x - (frame.current?.getBoundingClientRect().left ?? 0));
  return (
    <div
      ref={frame}
      className="sidebar-frame"
      data-collapsed={collapsed}
      style={collapsed ? undefined : ({ '--sidebar-width': shown + 'px' } as React.CSSProperties)}
    >
      {children}
      {!collapsed && (
        <div
          className="sidebar-resize"
          role="separator"
          tabIndex={0}
          aria-label="Sidebar width"
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_MIN}
          aria-valuemax={SIDEBAR_MAX}
          aria-valuenow={shown}
          title="Drag to resize · Arrow keys also work"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(fromPointer(e.clientX));
          }}
          onPointerMove={(e) => {
            if (dragging !== null) setDragging(fromPointer(e.clientX));
          }}
          onPointerUp={(e) => {
            if (dragging === null) return;
            const w = fromPointer(e.clientX);
            setDragging(null);
            onWidth(w);
          }}
          onPointerCancel={() => {
            if (dragging !== null) onWidth(dragging);
            setDragging(null);
          }}
          onKeyDown={(e) => {
            const next =
              e.key === 'Home'
                ? SIDEBAR_MIN
                : e.key === 'End'
                  ? SIDEBAR_MAX
                  : e.key === 'ArrowLeft'
                    ? width - 20
                    : e.key === 'ArrowRight'
                      ? width + 20
                      : undefined;
            if (next === undefined) return;
            e.preventDefault();
            onWidth(clamp(next));
          }}
        />
      )}
    </div>
  );
}
