/** The thrown error's message, or `fallback` when something other than an Error was thrown. */
export const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;
