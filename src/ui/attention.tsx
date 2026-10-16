/** One shared cue vocabulary: red = the agent stopped and needs you; amber spinner = working. Blue rings and green flashes are CSS classes (.attn-ring, .attn-flash) applied by the panels. */
export function AttentionBadge({
  count,
  label,
  small,
}: {
  count: number;
  label: string;
  small?: boolean;
}) {
  if (count <= 0) return null;
  return (
    <span
      className={'attn-badge' + (small ? ' small' : '')}
      role="img"
      aria-label={label}
      title={label}
    >
      {count}
    </span>
  );
}
export function AttentionDot({ label }: { label: string }) {
  return <span className="attn-dot" role="img" aria-label={label} title={label} />;
}
export function Spinner({ label }: { label: string }) {
  return <span className="attn-spinner" role="img" aria-label={label} title={label} />;
}
