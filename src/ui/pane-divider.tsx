import { useEffect, useRef, useState } from 'react';
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
  const [wide, setWide] = useState(() => window.matchMedia('(min-width:761px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(min-width:761px)');
    const update = () => setWide(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const drag = useRef<{
    id: number;
    startX: number;
    startY: number;
    value: number;
    length: number;
    horizontal: boolean;
    selection: string;
  } | null>(null);
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
      aria-valuemin={10}
      aria-valuemax={90}
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
              (100 * (d.horizontal ? d.startX - e.clientX : e.clientY - d.startY)) / d.length,
          );
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={() => change(50)}
      onKeyDown={(e) => {
        const horizontal = responsive && window.matchMedia('(min-width:761px)').matches;
        const delta = horizontal ? { ArrowLeft: 5, ArrowRight: -5 } : { ArrowDown: 5, ArrowUp: -5 };
        if (e.key === 'Home' || e.key === 'End' || e.key in delta) {
          e.preventDefault();
          change(
            e.key === 'Home'
              ? 10
              : e.key === 'End'
                ? 90
                : value + (delta[e.key as keyof typeof delta] ?? 0),
          );
        }
      }}
    >
      <span aria-hidden="true" />
    </div>
  );
}
