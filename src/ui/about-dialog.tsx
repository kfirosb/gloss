import { BrandMark } from './brand-mark.js';
import type { AboutInfo } from '../runtime/application.js';
import { PanelDialog } from './composer-dialogs.js';
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
export function AboutDialog({
  open,
  close,
  about,
  error,
}: {
  open: boolean;
  close(): void;
  about: AboutInfo | null;
  error?: string | undefined;
}) {
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
      </div>
      <div className="review-actions">
        <button type="button" className="primary" onClick={close}>
          Done
        </button>
      </div>
    </PanelDialog>
  );
}
