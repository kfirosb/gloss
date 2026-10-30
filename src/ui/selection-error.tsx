import { copyCommand } from './claude-move.js';

/** A session-selection failure: the reason, and optionally a command the user can run by hand. */
export type SelectionError = string | { message: string; command: string };

export function SelectionErrorNote({ error }: { error: SelectionError }) {
  if (typeof error === 'string') {
    return (
      <p role="alert" className="error">
        {error}
      </p>
    );
  }
  return (
    <div role="alert" className="error">
      <p>{error.message}</p>
      <p>
        Run it yourself: <code>{error.command}</code>{' '}
        <button type="button" onClick={() => void copyCommand(error.command, null)}>
          Copy
        </button>
      </p>
    </div>
  );
}
