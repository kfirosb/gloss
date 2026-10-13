// electron-builder afterPack hook: give the Mac bundle a complete ad-hoc signature.
//
// Without a Developer ID (`mac.identity: null`) electron-builder leaves only the linker's signature on the main
// executable and seals no resources. A copy downloaded on another Mac is quarantined, and Gatekeeper reports such a
// bundle as "damaged and can't be opened". A full ad-hoc signature (`codesign --sign -`) is still unverified by Apple,
// but the dialog becomes the ordinary "cannot verify" one, with "Open Anyway" in System Settings > Privacy & Security.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
const run = promisify(execFile);
export default async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  await run('codesign', ['--force', '--deep', '--sign', '-', app]);
  await run('codesign', ['--verify', '--deep', '--strict', app]);
  console.log(`  • ad-hoc signed ${app}`);
}
