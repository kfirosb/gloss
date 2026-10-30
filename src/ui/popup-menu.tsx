import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface PopupMenuItem {
  key: string;
  content: ReactNode;
  current?: boolean;
  disabled?: boolean;
  /** Focusable but not choosable: arrows still reach it, and its context menu and action still work. */
  unavailable?: boolean;
  onChoose(): void;
  /** A secondary button beside the item, outside arrow-key order (its context menu offers the same action). */
  action?: { label: ReactNode; ariaLabel: string; disabled?: boolean; onAction(): void };
  onContext?(anchor: { x: number; y: number }): void;
  data?: Record<string, string | undefined>;
}
// Accessible popup menu: focus enters on open, arrows/Home/End move, Escape and choice return focus to the trigger.
// `controlled` lets a caller open the menu from elsewhere (a context menu): the trigger is then not rendered and `restoreFocus` says where focus returns.
export interface PopupMenuControl {
  open: boolean;
  onOpenChange(open: boolean): void;
  restoreFocus(): void;
}
export function PopupMenu({
  label,
  description,
  resetKey,
  items,
  className = '',
  menuClassName = '',
  controlled,
  menuLabel,
  triggerLabel,
  triggerClassName,
  triggerDisabled,
  onOpen,
}: {
  label: ReactNode;
  description?: string | undefined;
  resetKey?: string | undefined;
  items: PopupMenuItem[];
  className?: string;
  menuClassName?: string;
  controlled?: PopupMenuControl;
  menuLabel?: string;
  triggerLabel?: string;
  triggerClassName?: string;
  triggerDisabled?: boolean | undefined;
  onOpen?: (() => void) | undefined;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlled ? controlled.open : ownOpen;
  const setOpen = (value: boolean | ((v: boolean) => boolean)) => {
    const next = typeof value === 'function' ? value(open) : value;
    if (controlled) controlled.onOpenChange(next);
    else setOwnOpen(next);
  };
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const descId = useId();
  const enabled = () => [
    ...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []),
  ];
  // A controlled menu is closed by its owner, so a reset key (or the initial strict-mode pass) must not close it.
  useEffect(() => {
    if (!controlled) setOwnOpen(false);
  }, [resetKey]);
  useEffect(() => {
    if (open) enabled()[0]?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const close = () => {
    setOpen(false);
    if (controlled) controlled.restoreFocus();
    else trigger.current?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (!menu.current?.contains(e.target as Node)) return;
    const list = enabled();
    const at = list.indexOf(e.target as HTMLElement);
    const next =
      e.key === 'ArrowDown'
        ? list[(at + 1) % list.length]
        : e.key === 'ArrowUp'
          ? list[(at - 1 + list.length) % list.length]
          : e.key === 'Home'
            ? list[0]
            : e.key === 'End'
              ? list.at(-1)
              : undefined;
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };
  return (
    <div ref={root} className={'popup-menu ' + className} onKeyDown={onKeyDown}>
      {!controlled && (
        <button
          ref={trigger}
          type="button"
          {...(triggerLabel ? { 'aria-label': triggerLabel, title: triggerLabel } : {})}
          {...(triggerClassName ? { className: triggerClassName } : {})}
          aria-haspopup="menu"
          aria-expanded={open}
          {...(description ? { 'aria-describedby': descId } : {})}
          disabled={triggerDisabled}
          onClick={() => {
            if (!open) onOpen?.();
            setOpen(!open);
          }}
        >
          {label}
        </button>
      )}
      {description && (
        <span id={descId} className="visually-hidden">
          {description}
        </span>
      )}
      {open && (
        <div
          ref={menu}
          role="menu"
          {...(menuLabel ? { 'aria-label': menuLabel } : {})}
          className={menuClassName}
        >
          {items.map((item) => {
            const choice = (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={item.disabled}
                aria-disabled={item.unavailable || undefined}
                aria-current={item.current ? 'true' : undefined}
                data-session-key={item.data?.['sessionKey']}
                data-session-id={item.data?.['sessionId']}
                onClick={() => {
                  if (item.unavailable) return;
                  close();
                  item.onChoose();
                }}
                onContextMenu={
                  item.onContext
                    ? (e) => {
                        e.preventDefault();
                        item.onContext!({ x: e.clientX, y: e.clientY });
                      }
                    : undefined
                }
                onKeyDown={
                  item.onContext
                    ? (e) => {
                        if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
                          e.preventDefault();
                          e.stopPropagation();
                          const box = e.currentTarget.getBoundingClientRect();
                          item.onContext!({ x: box.left + 16, y: box.bottom });
                        }
                      }
                    : undefined
                }
              >
                {item.content}
              </button>
            );
            const action = item.action;
            if (!action) return choice;
            // The action is a sibling of the item because a button cannot contain another button.
            return (
              <div key={item.key} role="none" className="popup-menu-row">
                {choice}
                <button
                  type="button"
                  className="popup-menu-action"
                  tabIndex={-1}
                  aria-label={action.ariaLabel}
                  title={action.ariaLabel}
                  disabled={action.disabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    action.onAction();
                  }}
                >
                  {action.label}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
