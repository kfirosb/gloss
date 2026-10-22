// Update check and one-click install for the main process, kept free of Electron and electron-updater so it can be
// unit tested; main.mjs passes the real `autoUpdater`. The check runs at most once a week (timestamp in desktop.json)
// and only reports a newer version: electron-updater compares it with the running app's version and, on macOS,
// verifies the downloaded zip against the signed release. Linux packages are not self-updating: install opens the
// release page instead.
export const UPDATE_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const RELEASES_URL = 'https://github.com/kfirosb/gloss/releases/latest';
// electron-updater's "this release has nothing for this app" failures (no manifest, no zip for this architecture).
// They are an answer ("no update for you"), not a fault, so they must not surface as an error.
const NO_UPDATE_CODES = new Set([
  'ERR_UPDATER_ASSET_NOT_FOUND',
  'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
  'ERR_UPDATER_ZIP_FILE_NOT_FOUND',
  'ERR_UPDATER_NO_FILES_PROVIDED',
  'ERR_UPDATER_NO_PUBLISHED_VERSIONS',
  'ERR_UPDATER_RELEASE_NOT_FOUND',
]);
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

export function createUpdater({ updater, now, store, platform, openExternal, send }) {
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

  // `quiet` (the weekly check) never shows a failure; a manual check does.
  async function check(quiet) {
    setState({ kind: 'checking' });
    try {
      const result = await updater.checkForUpdates();
      store.setLastCheck(now());
      setState(
        result?.isUpdateAvailable
          ? { kind: 'available', version: result.updateInfo.version }
          : { kind: 'up-to-date' },
      );
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
        openExternal(RELEASES_URL);
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
