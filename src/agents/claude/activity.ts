import type { CodingState } from '../../core/contracts.js';

/**
 * Claude's session record → Gloss's coding state. Approval statuses come first; then `status: "waiting"` or any
 * `waitingFor` (Claude 2.1.300 writes "dialog open") means a dialog is open in the terminal.
 */
export function claudeActivity(status: unknown, waitingFor?: unknown): CodingState {
  if (status === 'approval-required' || status === 'waiting_for_approval')
    return 'approval-required';
  if (
    status === 'waiting' ||
    (waitingFor !== undefined && waitingFor !== null && waitingFor !== '')
  )
    return 'dialog-open';
  if (status === 'idle') return 'idle';
  return 'working';
}
