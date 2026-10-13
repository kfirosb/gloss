/** The Gloss mark: two interlocking half-rings with chevron tails, the same shape as assets/logo.svg. */
export function BrandMark({ className = 'brand-mark' }: { className?: string }) {
  const half = <><path d="M250 500A250 250 0 0 1 750 500L610 500A110 110 0 0 0 390 500Z" /><path d="M537 93L945 500L537 500Z" /></>;
  return <span className={className} aria-hidden="true"><svg viewBox="0 0 1000 1000" width="18" height="18" fill="currentColor">{half}<g transform="rotate(180 500 500)">{half}</g></svg></span>;
}
