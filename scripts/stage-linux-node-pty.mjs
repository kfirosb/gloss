// node-pty publishes no Linux prebuilds; copy the Docker-built addon into the prebuilds folder node-pty loads from,
// so electron-builder packages it with the module (idempotent; node_modules is not tracked).
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const prebuilds = join(root, 'node_modules', 'node-pty', 'prebuilds');
for (const arch of ['x64', 'arm64']) {
  const source = join(root, 'vendor', `linux-${arch}`, 'node-pty');
  if (!existsSync(source)) continue;
  const target = join(prebuilds, `linux-${arch}`);
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) {
    copyFileSync(join(source, name), join(target, name));
    chmodSync(join(target, name), 0o755);
  }
  console.log(`staged node-pty prebuilds for linux-${arch}`);
}
