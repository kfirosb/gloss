import type { KeyboardEvent, ReactNode } from 'react';

export interface ViewOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  title?: string | undefined;
  badge?: ReactNode;
}
/** A segmented radio group: one tab stop, arrow keys move between the enabled options. */
export function ViewRadios<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ViewOption<T>[];
  value: T;
  onChange(value: T): void;
}) {
  const enabled = options.filter((o) => !o.disabled);
  const move = (event: KeyboardEvent<HTMLElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step || enabled.length === 0) return;
    event.preventDefault();
    const at = enabled.findIndex((o) => o.value === value);
    const next = enabled[(at + step + enabled.length) % enabled.length];
    if (!next) return;
    onChange(next.value);
    event.currentTarget.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus();
  };
  return (
    <span className="view-radios" role="radiogroup" aria-label={label} dir="ltr" onKeyDown={move}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          data-value={o.value}
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.badge}
        </button>
      ))}
    </span>
  );
}
