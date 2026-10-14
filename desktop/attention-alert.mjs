// Alert rule for the main process, kept free of Electron so it can be unit tested. The page is not trusted: only listed system sounds play.
const SOUNDS = new Set(['Basso', 'Blow', 'Bottle', 'Frog', 'Funk', 'Glass', 'Hero', 'Morse', 'Ping', 'Pop', 'Purr', 'Sosumi', 'Submarine', 'Tink']);
export function createAlertHandler({ playSound, bounce, isFocused }) {
  return {
    handle(payload) {
      if (!payload || typeof payload !== 'object') return;
      if (typeof payload.sound === 'string' && SOUNDS.has(payload.sound)) playSound(`/System/Library/Sounds/${payload.sound}.aiff`);
      if (payload.bounce === true && !isFocused()) bounce();
    },
  };
}
