// Fails when the Linux vendor binaries (built by scripts/build-linux-vendor.sh) are missing for a requested arch.
import { accessSync, constants, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const arches = process.argv.slice(2).length ? process.argv.slice(2) : ['x64', 'arm64'];
const missing = [];
for (const arch of arches) {
  for (const relative of ['bin/tmux', 'bin/whisper-server', 'node-pty/pty.node']) {
    const path = fileURLToPath(new URL(`../vendor/linux-${arch}/${relative}`, import.meta.url));
    try {
      if (!statSync(path).isFile()) throw new Error('not a file');
      accessSync(path, constants.X_OK);
    } catch {
      missing.push(path);
    }
  }
}
if (missing.length) {
  console.error(
    `Linux vendor binaries are missing or not executable:\n  ${missing.join('\n  ')}\nRun sh scripts/build-linux-vendor.sh <arch> first.`,
  );
  process.exit(1);
}
