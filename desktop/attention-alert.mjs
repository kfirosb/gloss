// Alert rule for the main process, kept free of Electron so it can be unit tested. The page is not trusted: only
// listed sounds of the host platform play, from fixed system locations.
const MAC_SOUNDS = [
  'Basso',
  'Blow',
  'Bottle',
  'Frog',
  'Funk',
  'Glass',
  'Hero',
  'Morse',
  'Ping',
  'Pop',
  'Purr',
  'Sosumi',
  'Submarine',
  'Tink',
];
// The freedesktop sound theme (package sound-theme-freedesktop), present on most Linux desktops.
const FREEDESKTOP_SOUNDS = [
  'bell',
  'complete',
  'message',
  'dialog-information',
  'dialog-warning',
  'window-attention',
  'service-login',
];
/** The sound names the platform's shell can play; the UI offers exactly these. */
export function alertSoundNames(platform) {
  return platform === 'darwin' ? MAC_SOUNDS : FREEDESKTOP_SOUNDS;
}
/** The file for a listed sound name, or undefined for anything else. */
export function alertSoundPath(name, platform) {
  if (!alertSoundNames(platform).includes(name)) return undefined;
  return platform === 'darwin'
    ? `/System/Library/Sounds/${name}.aiff`
    : `/usr/share/sounds/freedesktop/stereo/${name}.oga`;
}
export function createAlertHandler({ playSound, bounce, isFocused, platform = process.platform }) {
  return {
    handle(payload) {
      if (!payload || typeof payload !== 'object') return;
      const path = typeof payload.sound === 'string' && alertSoundPath(payload.sound, platform);
      if (path) playSound(path);
      if (payload.bounce === true && !isFocused()) bounce();
    },
  };
}
