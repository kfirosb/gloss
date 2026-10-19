// electron-builder afterPack hook: ad-hoc sign the Mac bundle when no Developer ID will.
//
// electron-builder signs after this hook with the Developer ID Application identity it finds in the keychain
// (hardened runtime, entitlements from build/entitlements.mac.plist, then notarization when the APPLE_API_* variables
// are set). When no such identity is available it signs nothing, which leaves only the linker's signature on the main
// executable and seals no resources; a copy downloaded on another Mac is then quarantined and Gatekeeper reports it as
// "damaged and can't be opened". A full ad-hoc signature (`codesign --sign -`) is still unverified by Apple, but the
// dialog becomes the ordinary "cannot verify" one, with "Open Anyway" in System Settings > Privacy & Security.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
const run = promisify(execFile);

const developerIdentity = /"Developer ID Application: [^"]+"/;

// Decides whether the ad-hoc fallback is needed, from electron-builder's identity setting, the CSC_IDENTITY_AUTO_DISCOVERY
// variable (electron-builder skips the keychain search when it is "false") and `security find-identity -v -p codesigning`.
export function needsAdhocSignature({ identity, autoDiscovery, identities }) {
  if (identity === null) return true;
  if (typeof identity === 'string') return identity === '-';
  if (autoDiscovery === 'false') return true;
  return !developerIdentity.test(identities);
}

async function validIdentities() {
  try {
    const { stdout } = await run('security', ['find-identity', '-v', '-p', 'codesigning']);
    return stdout;
  } catch {
    return '';
  }
}

export default async function signMac(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const identity = context.packager.platformSpecificBuildOptions.identity;
  const adhoc = needsAdhocSignature({
    identity,
    autoDiscovery: process.env.CSC_IDENTITY_AUTO_DISCOVERY,
    identities: await validIdentities(),
  });
  if (!adhoc) {
    console.log(`  • Developer ID found; electron-builder signs ${app}`);
    return;
  }
  await run('codesign', ['--force', '--deep', '--sign', '-', app]);
  await run('codesign', ['--verify', '--deep', '--strict', app]);
  console.log(`  • ad-hoc signed ${app} (no Developer ID Application identity in the keychain)`);
}
