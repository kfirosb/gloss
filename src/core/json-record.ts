/** An external JSON object whose individual fields still require validation. */
export type JsonRecord = Record<string, unknown>;

export function recordOf(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

export function textBlocks(value: unknown, types: readonly string[] = ['text']): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const block = recordOf(entry);
    return block &&
      typeof block.type === 'string' &&
      types.includes(block.type) &&
      typeof block.text === 'string'
      ? [block.text]
      : [];
  });
}
