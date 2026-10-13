// node-pty ships its prebuilt spawn-helper without the execute bit; restore it (idempotent).
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../node_modules/node-pty/prebuilds/', import.meta.url));
if (existsSync(root)) {
  for (const dir of readdirSync(root)) {
    const helper = join(root, dir, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
