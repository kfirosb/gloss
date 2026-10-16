/** Display-only metadata; never used to establish session identity. */
export function normalizeSessionTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return (
    value
      .replace(/[\x00-\x1f\x7f]/g, '')
      .trim()
      .slice(0, 200) || undefined
  );
}
