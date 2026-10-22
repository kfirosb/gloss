import { updatesBridge, type UpdateState } from './update-state.js';

/** The footer mark beside the version label; renders nothing when there is no update to act on. */
export function UpdateNotice({ state, install }: { state: UpdateState; install(): void }) {
  if (state.kind === 'available') {
    return (
      <button
        type="button"
        className="update-mark"
        aria-label={`Update to ${state.version}`}
        title={`Update to ${state.version}`}
        onClick={install}
      >
        <span className="update-dot" aria-hidden="true" />
      </button>
    );
  }
  if (state.kind === 'downloading') {
    return (
      <span className="update-progress" role="status">
        Downloading {Math.round(state.percent)}%
      </span>
    );
  }
  if (state.kind === 'error') {
    return (
      <span className="update-error" role="status">
        <span>{state.message}</span>
        <button
          type="button"
          className="update-retry"
          onClick={() => void updatesBridge()?.check()}
        >
          Try again
        </button>
      </span>
    );
  }
  return null;
}
