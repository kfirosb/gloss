// electron-builder beforePack hook: refuse to package a Mac build whose bundled tmux and whisper-server are missing,
// not executable, or built for another architecture. `scripts/build-tmux.sh <arch>` and `scripts/build-whisper.sh <arch>`
// write them to vendor/<tool>/<arch>/bin; the extraResources entries in package.json pick the same ${arch} directory.
import { accessSync, constants, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import appBuilderLib from 'app-builder-lib';

const machArch = { arm64: 'arm64', x64: 'x86_64' };
const bundled = [
  { tool: 'tmux', binary: 'tmux', script: 'build:tmux' },
  { tool: 'whisper', binary: 'whisper-server', script: 'build:whisper' },
];

export default function checkVendor(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const arch = appBuilderLib.Arch[context.arch];
  const expected = machArch[arch];
  if (!expected) throw new Error(`Mac packaging supports arm64 and x64, not ${arch}`);
  for (const { tool, binary, script } of bundled) {
    const path = fileURLToPath(new URL(`../vendor/${tool}/${arch}/bin/${binary}`, import.meta.url));
    try {
      if (!statSync(path).isFile()) throw new Error('not a file');
      accessSync(path, constants.X_OK);
    } catch {
      throw new Error(
        `Bundled ${binary} for ${arch} is missing or not executable: ${path}\nRun npm run ${script} -- ${arch} first.`,
      );
    }
    try {
      execFileSync('lipo', [path, '-verify_arch', expected], { stdio: 'pipe' });
    } catch {
      throw new Error(
        `Bundled ${binary} at ${path} is not a ${expected} binary.\nRun npm run ${script} -- ${arch} to rebuild it.`,
      );
    }
  }
  console.log(`  • bundled tmux and whisper-server verified for ${arch}`);
}
