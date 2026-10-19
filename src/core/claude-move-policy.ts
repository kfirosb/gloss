/**
 * How long Gloss watches a reopened session for its record, another session's record or its pane closing, in
 * milliseconds. Task 1 measured 681 ms from `--resume` to the record; max(15 000, 2 × that) rounded up to 1 000.
 * The server's check (src/runtime/claude-move.ts) and the browser's watch of a move it started share it.
 */
export const MOVE_RESUME_CHECK_MS = 15_000;
