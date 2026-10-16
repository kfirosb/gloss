import type { WorkspaceData } from '../core/session-contracts.js';
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  type ReactNode,
  type CSSProperties,
} from 'react';
import { PaneDivider } from './pane-divider.js';
export type PanelId = 'live' | 'assistant' | 'composer';
const names: Record<PanelId, string> = {
  live: 'Live Conversation',
  assistant: 'Language Assistant',
  composer: 'Chat with the Language Assistant',
};
const initial: PanelId[] = ['live', 'assistant', 'composer'];
const MoveContext = createContext<{ id: PanelId; swap(other: PanelId): void } | null>(null);
export function PanelMoveControl() {
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  const move = useContext(MoveContext);
  const [open, setOpen] = useState(false);
  const control = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        handle.current?.focus();
      }
    };
    const outside = (e: PointerEvent) => {
      if (!control.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', outside);
    };
  }, [open]);
  if (!move) return null;
  return (
    <div ref={control} className="panel-move-control">
      <button
        ref={handle}
        type="button"
        aria-label={`Move ${names[move.id]}`}
        title="Drag this handle onto another panel to swap positions"
        aria-expanded={open}
        onPointerDown={(e) => {
          pointer.current = { x: e.clientX, y: e.clientY };
          moved.current = false;
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (
            pointer.current &&
            Math.hypot(e.clientX - pointer.current.x, e.clientY - pointer.current.y) > 8
          )
            moved.current = true;
        }}
        onPointerUp={(e) => {
          if (moved.current) {
            const target = document
              .elementFromPoint(e.clientX, e.clientY)
              ?.closest('[data-panel-id]')
              ?.getAttribute('data-panel-id') as PanelId;
            if (target && initial.includes(target)) move.swap(target);
            setOpen(false);
          }
          pointer.current = null;
        }}
        onPointerCancel={() => {
          pointer.current = null;
          moved.current = false;
        }}
        onClick={() => {
          if (!moved.current) setOpen((v) => !v);
          moved.current = false;
        }}
      >
        ⠿
      </button>
      {open && (
        <div className="panel-move-menu">
          {initial
            .filter((id) => id !== move.id)
            .map((id) => (
              <button
                key={id}
                onClick={() => {
                  move.swap(id);
                  setOpen(false);
                }}
              >
                Swap with {names[id]}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
export function MovableWorkspace({
  panels,
  assistantMode = 'full',
  toolbar,
  layout: controlled,
  onLayout,
  liveSize,
  discussionSize,
  setLiveSize,
  setDiscussionSize,
}: {
  assistantMode?: 'full' | 'compact';
  toolbar?: ReactNode;
  layout: WorkspaceData['layout'];
  onLayout(value: WorkspaceData['layout']): void;
  panels: Record<PanelId, ReactNode>;
  liveSize: number;
  discussionSize: number;
  setLiveSize(n: number): void;
  setDiscussionSize(n: number): void;
}) {
  const { order, mode: layout } = controlled;
  const [hover, setHover] = useState<PanelId | null>(null);
  const saveOrder = (next: PanelId[]) => onLayout({ ...controlled, order: next });
  const swap = (a: PanelId, b: PanelId) =>
    saveOrder(order.map((id) => (id === a ? b : id === b ? a : id)));
  const changeLayout = (next: string) =>
    onLayout({
      ...controlled,
      mode: next as WorkspaceData['layout']['mode'],
      order: next === 'bottom' ? [...order.filter((id) => id !== 'composer'), 'composer'] : order,
    });
  return (
    <>
      <div className="layout-controls">
        {toolbar}
        {assistantMode === 'full' && (
          <>
            <label>
              Layout{' '}
              <select
                aria-label="Panel layout"
                value={layout}
                onChange={(e) => changeLayout(e.target.value)}
              >
                <option value="split">Split</option>
                <option value="columns">Columns</option>
                <option value="rows">Rows</option>
                <option value="bottom">Chat across bottom</option>
              </select>
            </label>
            <button
              onClick={() => {
                onLayout({ mode: 'split', order: initial, liveSize: 50, discussionSize: 60 });
              }}
            >
              Reset layout
            </button>
          </>
        )}
      </div>
      <div
        data-assistant-mode={assistantMode}
        className={`workspace movable-workspace layout-${layout}`}
        style={
          {
            '--first-min':
              order[0] === 'composer'
                ? 'var(--input-min)'
                : order[0] === 'assistant'
                  ? '110px'
                  : '65px',
            '--second-min':
              order[1] === 'composer'
                ? 'var(--input-min)'
                : order[1] === 'assistant'
                  ? '110px'
                  : '65px',
            '--third-min':
              order[2] === 'composer'
                ? 'var(--input-min)'
                : order[2] === 'assistant'
                  ? '110px'
                  : '65px',
            '--live-size': `${liveSize}fr`,
            '--other-size': `${100 - liveSize}fr`,
            '--discussion-size': `${discussionSize}fr`,
            '--composer-size': `${100 - discussionSize}fr`,
          } as CSSProperties
        }
      >
        {initial.map((id) => (
          <div
            key={id}
            className={`movable-cell slot-${order.indexOf(id)}${hover === id ? ' drop-target' : ''}`}
            data-panel-id={id}
            data-slot={order.indexOf(id)}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('text/x-panel')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setHover(id);
              }
            }}
            onDragLeave={() => setHover(null)}
            onDrop={(e) => {
              e.preventDefault();
              setHover(null);
              const source = e.dataTransfer.getData('text/x-panel') as PanelId;
              if (initial.includes(source)) swap(source, id);
            }}
          >
            <MoveContext.Provider value={{ id, swap: (other) => swap(id, other) }}>
              {panels[id]}
            </MoveContext.Provider>
          </div>
        ))}
        <div className="divider-first">
          <PaneDivider
            name="Resize Live Conversation"
            value={liveSize}
            change={setLiveSize}
            responsive={layout !== 'rows'}
          />
        </div>
        <div className="divider-second">
          <PaneDivider
            name="Resize Language Assistant"
            value={discussionSize}
            change={setDiscussionSize}
            responsive={layout === 'columns'}
          />
        </div>
      </div>
    </>
  );
}
