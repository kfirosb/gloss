import { updatesBridge, type UpdateState } from './update-state.js';

/** The accent button that installs an available update; shared by the footer and About. */
export function UpdateButton({ version, install }: { version: string; install(): void }) {
  const label = `Update to ${version}`;
  return (
    <button type="button" className="update-mark" title={label} onClick={install}>
      <span className="update-dot" aria-hidden="true" />
      {label}
    </button>
  );
}

const retry = () => void updatesBridge()?.check();

/**
 * The footer mark beside the version label; renders nothing when there is no update to act on.
 * `compact` is the collapsed rail: a dot or ring whose title carries what the text would say.
 */
export function UpdateNotice({
  state,
  install,
  compact = false,
}: {
  state: UpdateState;
  install(): void;
  compact?: boolean;
}) {
  if (state.kind === 'available') {
    if (!compact) return <UpdateButton version={state.version} install={install} />;
    const label = `Update to ${state.version}`;
    return (
      <button
        type="button"
        className="update-mark"
        aria-label={label}
        title={label}
        onClick={install}
      >
        <span className="update-dot" aria-hidden="true" />
      </button>
    );
  }
  if (state.kind === 'downloading') {
    const label = `Downloading ${Math.round(state.percent)}%`;
    if (compact) {
      return <span className="update-ring" role="status" aria-label={label} title={label} />;
    }
    return (
      <span className="update-progress" role="status">
        {label}
      </span>
    );
  }
  if (state.kind === 'error') {
    if (compact) {
      const label = `${state.message} \u2014 click to try again`;
      return (
        <button
          type="button"
          className="update-mark update-mark-error"
          aria-label={label}
          title={label}
          onClick={retry}
        >
          <span className="update-dot" aria-hidden="true" />
        </button>
      );
    }
    return (
      <span className="update-error" role="status">
        <span className="update-error-text" title={state.message}>
          {state.message}
        </span>
        <button type="button" className="update-retry" onClick={retry}>
          Try again
        </button>
      </span>
    );
  }
  return null;
}
