import { BrandMark } from './brand-mark.js';
import type { AboutInfo } from '../runtime/application.js';
import { PanelDialog } from './composer-dialogs.js';
import { UpdateButton } from './update-notice.js';
import { updatesBridge, type UpdateState } from './update-state.js';
const platformName = (p: string) =>
  p === 'darwin' ? 'macOS' : p === 'win32' ? 'Windows' : p === 'linux' ? 'Linux' : p;
const archName = (a: string, p: string) =>
  a === 'arm64' && p === 'darwin'
    ? 'Apple Silicon'
    : a === 'x64'
      ? p === 'darwin'
        ? 'Intel'
        : 'x64'
      : a;
const updateResult = (state: UpdateState): string | null => {
  switch (state.kind) {
    case 'checking':
      return 'Checking…';
    case 'up-to-date':
      return 'Gloss is up to date';
    case 'available':
      return `Version ${state.version} is available`;
    case 'downloading':
      return `Downloading ${Math.round(state.percent)}%`;
    case 'error':
      return state.message;
    case 'idle':
      return null;
  }
};
export function AboutDialog({
  open,
  close,
  about,
  error,
  update = null,
  install,
}: {
  open: boolean;
  close(): void;
  about: AboutInfo | null;
  error?: string | undefined;
  /** The desktop update state; null in the browser, where there is nothing to check. */
  update?: UpdateState | null;
  install?(): void;
}) {
  const updateState = update;
  const result = updateState && updateResult(updateState);
  return (
    <PanelDialog
      title="About Gloss"
      className="sidebar-panel-dialog"
      dir="ltr"
      open={open}
      close={close}
    >
      <div className="review-body about-body">
        <BrandMark />
        <div className="about-name">Gloss</div>
        <p className="review-hint">A quieter place to work with your coding agents.</p>
        {about ? (
          <dl className="about-grid">
            <dt>App version</dt>
            <dd>{about.version}</dd>
            <dt>Platform</dt>
            <dd>
              {platformName(about.platform)} · {archName(about.arch, about.platform)}
            </dd>
          </dl>
        ) : (
          <p role="status">{error ?? 'Loading version…'}</p>
        )}
        {updateState && (
          <div className="about-update">
            <button
              type="button"
              disabled={updateState.kind === 'checking' || updateState.kind === 'downloading'}
              onClick={() => void updatesBridge()?.check()}
            >
              Check for updates
            </button>
            {result && <p role="status">{result}</p>}
            {updateState.kind === 'available' && install && (
              <UpdateButton version={updateState.version} install={install} />
            )}
          </div>
        )}
      </div>
      <div className="review-actions">
        <button type="button" className="primary" onClick={close}>
          Done
        </button>
      </div>
    </PanelDialog>
  );
}
