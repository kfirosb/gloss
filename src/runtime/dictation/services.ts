import { join } from 'node:path';
import { createDictationBridge, type DictationBridge } from './bridge.js';
import { createDictationEngine, locateWhisper } from './engine.js';
import { createModelStore } from './model.js';

/** Where the speech model lives under the app's data root; kept across app versions. */
export const modelsDirectory = (root: string) => join(root, 'models');
/** Exit codes for the signals that end the CLI: 128 + the signal number. */
const SIGNAL_EXIT_CODES = [
  ['SIGTERM', 143],
  ['SIGINT', 130],
  ['SIGHUP', 129],
] as const;

/** Wires the model store, the whisper engine and the dictation bridge for the server. With `attachSignals` (only when running as the
 * real CLI entry) the detached whisper-server is stopped on SIGTERM/SIGINT/SIGHUP (then the process exits with that signal's code)
 * and on 'exit', which covers a crash or a normal exit; close() is synchronous (it signals the engine's process group), so it is safe
 * there. Only dictation stops here; tmux-backed sessions are left running on purpose. */
export function createDictationServices(options: {
  root: string;
  capability: () => string;
  log: (line: string) => void;
  attachSignals: boolean;
}): DictationBridge {
  const model = createModelStore({ directory: modelsDirectory(options.root) });
  const bridge = createDictationBridge({
    engine: createDictationEngine({ binary: locateWhisper(), model, log: options.log }),
    model,
    capability: options.capability,
    log: options.log,
  });
  if (options.attachSignals) {
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      bridge.close();
    };
    for (const [signal, code] of SIGNAL_EXIT_CODES)
      process.once(signal, () => {
        stop();
        process.exit(code);
      });
    process.once('exit', stop);
  }
  return bridge;
}
