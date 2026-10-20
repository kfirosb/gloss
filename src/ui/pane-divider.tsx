import { useEffect, useRef, useState } from 'react';
import { LAYOUT_SIZE_MAX, LAYOUT_SIZE_MIN } from '../core/session-contracts.js';
/** True while the window is wide enough for side-by-side panes; below it responsive dividers stack. */
export function useWideLayout() {
  const [wide, setWide] = useState(() => window.matchMedia('(min-width:761px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(min-width:761px)');
    const update = () => setWide(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return wide;
}
export function PaneDivider({
  name,
  value,
  change,
  responsive = false,
}: {
  name: string;
  value: number;
  change(value: number): void;
  responsive?: boolean;
}) {
  const wide = useWideLayout();
  const drag = useRef<{
    id: number;
    startX: number;
    startY: number;
    value: number;
    length: number;
    horizontal: boolean;
    /** The first pane sits on the right in a right-to-left workspace, so pointer movement is mirrored. */
    rtl: boolean;
    selection: string;
  } | null>(null);
  const isRtl = (element: HTMLElement) => getComputedStyle(element).direction === 'rtl';
  const finish = () => {
    if (drag.current) document.documentElement.style.userSelect = drag.current.selection;
    drag.current = null;
  };
  useEffect(() => finish, []);
  return (
    <div
      className={`pane-divider ${responsive ? 'workspace-divider' : 'row-divider'}`}
      role="separator"
      tabIndex={0}
      aria-label={name}
      aria-orientation={responsive && wide ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(value)}
      aria-valuemin={LAYOUT_SIZE_MIN}
      aria-valuemax={LAYOUT_SIZE_MAX}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const parent = e.currentTarget.parentElement!;
        const rect = (
          parent.className.startsWith('divider-') ? parent.parentElement! : parent
        ).getBoundingClientRect();
        const horizontal = responsive && window.matchMedia('(min-width:761px)').matches;
        drag.current = {
          id: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          value,
          length: horizontal ? rect.width : rect.height,
          horizontal,
          rtl: isRtl(e.currentTarget),
          selection: document.documentElement.style.userSelect,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
        e.currentTarget.focus();
        document.documentElement.style.userSelect = 'none';
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d?.id === e.pointerId)
          change(
            d.value +
              (100 *
                (d.horizontal
                  ? d.rtl
                    ? d.startX - e.clientX
                    : e.clientX - d.startX
                  : e.clientY - d.startY)) /
                d.length,
          );
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={() => change(50)}
      onKeyDown={(e) => {
        const horizontal = responsive && window.matchMedia('(min-width:761px)').matches;
        const toward = isRtl(e.currentTarget) ? -1 : 1;
        const delta = horizontal
          ? { ArrowLeft: -5 * toward, ArrowRight: 5 * toward }
          : { ArrowDown: 5, ArrowUp: -5 };
        if (e.key === 'Home' || e.key === 'End' || e.key in delta) {
          e.preventDefault();
          change(
            e.key === 'Home'
              ? LAYOUT_SIZE_MIN
              : e.key === 'End'
                ? LAYOUT_SIZE_MAX
                : value + (delta[e.key as keyof typeof delta] ?? 0),
          );
        }
      }}
    >
      <span aria-hidden="true" />
    </div>
  );
}
