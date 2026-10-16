import { accessSync, constants, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const binary = fileURLToPath(new URL('../vendor/tmux/bin/tmux', import.meta.url));
try {
  if (!statSync(binary).isFile()) throw new Error('not a file');
  accessSync(binary, constants.X_OK);
} catch {
  console.error(
    `Bundled tmux is missing or not executable: ${binary}\nRun npm run build:tmux first.`,
  );
  process.exit(1);
}
