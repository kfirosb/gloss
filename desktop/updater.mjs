// Update check and one-click install for the main process, kept free of Electron and electron-updater so it can be
// unit tested; main.mjs passes the real `autoUpdater`. The check runs at most once a week (timestamp in desktop.json)
// and only reports a newer version: electron-updater compares it with the running app's version and, on macOS,
// verifies the downloaded zip against the signed release. Linux packages are not self-updating: install opens the
// release page instead, and the check there reads GitHub's latest-release endpoint (electron-updater's Linux check
// needs latest-linux*.yml files the deb build does not reliably produce).
import semver from 'semver';

export const UPDATE_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const RELEASES_URL = 'https://github.com/kfirosb/gloss/releases/latest';
// The only electron-updater check-step failures that mean "no release for you" (no manifest, no published release).
// Anything else, including an offline machine or a missing latest release, is a failed check.
const NO_UPDATE_CODES = new Set([
  'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
  'ERR_UPDATER_NO_PUBLISHED_VERSIONS',
]);
// MacUpdater would fall back to the other architecture's zip, so the release must carry a zip built for this one.
// electron-updater itself treats any file whose url contains "arm64" as the arm64 build.
const hasZipForArch = (files, arch) =>
  Array.isArray(files) &&
  files.some(
    (file) =>
      typeof file?.url === 'string' &&
      file.url.endsWith('.zip') &&
      file.url.includes('arm64') === (arch === 'arm64'),
  );
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

export function createUpdater({
  updater,
  now,
  store,
  platform,
  arch,
  currentVersion,
  fetchLatestRelease,
  openExternal,
  send,
}) {
  let state = { kind: 'idle' };
  let inFlight;
  const setState = (next) => {
    state = next;
    send(next);
  };
  updater.on('download-progress', (progress) => {
    if (state.kind === 'downloading')
      setState({ kind: 'downloading', version: state.version, percent: progress.percent });
  });

  // Squirrel.Mac reports a failed install after quitAndInstall as an 'error' event; without a listener it would be
  // thrown in the main process and the page would stay at 100%.
  updater.on('error', (error) => {
    if (state.kind === 'downloading') setState({ kind: 'error', message: messageOf(error) });
  });

  // The newer version on offer, or undefined when there is nothing this install can take.
  async function newerVersion() {
    if (platform !== 'darwin') {
      const latest = await fetchLatestRelease();
      return semver.valid(latest?.version) && semver.gt(latest.version, currentVersion)
        ? latest.version
        : undefined;
    }
    const result = await updater.checkForUpdates();
    if (!result?.isUpdateAvailable) return undefined;
    // null: a newer release exists but has nothing for this install; the weekly check stays silent about it.
    if (!hasZipForArch(result.updateInfo.files, arch)) return null;
    return result.updateInfo.version;
  }

  // `quiet` (the weekly check) never shows a failure; a manual check does.
  async function check(quiet) {
    setState({ kind: 'checking' });
    try {
      const version = await newerVersion();
      store.setLastCheck(now());
      if (version) setState({ kind: 'available', version });
      else setState(quiet && version === null ? { kind: 'idle' } : { kind: 'up-to-date' });
    } catch (error) {
      if (NO_UPDATE_CODES.has(error?.code)) {
        store.setLastCheck(now());
        setState(quiet ? { kind: 'idle' } : { kind: 'up-to-date' });
      } else setState(quiet ? { kind: 'idle' } : { kind: 'error', message: messageOf(error) });
    }
  }
  const run = (quiet) => {
    inFlight ??= check(quiet).finally(() => (inFlight = undefined));
    return inFlight;
  };

  return {
    async maybeCheck() {
      const last = store.lastCheck();
      if (typeof last === 'number' && now() - last < UPDATE_CHECK_INTERVAL_MS) return;
      if (inFlight || state.kind === 'downloading') return;
      await run(true);
    },
    async checkNow() {
      if (state.kind === 'downloading') return;
      await run(false);
    },
    async install() {
      if (state.kind !== 'available') return;
      if (platform !== 'darwin') {
        // Best effort: the page keeps showing the update if the browser cannot be opened.
        await Promise.resolve(openExternal(RELEASES_URL)).catch(() => {});
        return;
      }
      const { version } = state;
      setState({ kind: 'downloading', version, percent: 0 });
      try {
        await updater.downloadUpdate();
      } catch (error) {
        setState({ kind: 'error', message: messageOf(error) });
        return;
      }
      updater.quitAndInstall();
    },
    state: () => state,
  };
}
