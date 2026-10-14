import { accessSync, constants, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const binary = fileURLToPath(new URL('../vendor/whisper/bin/whisper-server', import.meta.url));
try {
  if (!statSync(binary).isFile()) throw new Error('not a file');
  accessSync(binary, constants.X_OK);
} catch {
  console.error(`Bundled whisper-server is missing or not executable: ${binary}\nRun npm run build:whisper first.`);
  process.exit(1);
}
