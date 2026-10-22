/**
 * Where the host's process-inspection tools live and which platforms may run them. Discovery, liveness and channel
 * identity read the process table through `ps` and `lsof`; their output was verified on macOS and Linux (procps,
 * lsof 4.9x), so only those platforms probe. Everything else fails closed.
 */
const PROBE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set<NodeJS.Platform>(['darwin', 'linux']);

export function supportsProcessProbes(platform: NodeJS.Platform = process.platform): boolean {
  return PROBE_PLATFORMS.has(platform);
}

/** macOS ships lsof in /usr/sbin; Linux distributions install it in /usr/bin (and often not by default). */
export function lsofPath(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof';
}

// lsof reports a path that does not exist (a stale socket, a database without a WAL) this way and exits 1; it is not a
// probe failure. Any other diagnostic is.
const LSOF_MISSING_PATH_DIAGNOSTIC = /^lsof: status error on .+: No such file or directory$/;

/** True when lsof's stderr holds nothing but missing-path notices, so its pid output can be trusted. */
export function lsofDiagnosticsClean(diagnostics: string): boolean {
  return diagnostics
    .split('\n')
    .every((line) => !line.trim() || LSOF_MISSING_PATH_DIAGNOSTIC.test(line.trim()));
}

/** A probe that could not start because `lsof` is absent: the one Linux failure the user can fix in a minute. */
export class LsofMissing extends Error {
  constructor(platform: NodeJS.Platform = process.platform) {
    super(
      `lsof is not installed (${lsofPath(platform)}); install it with your package manager (for example apt install lsof)`,
    );
  }
}

/** The system URL/route opener: `open` on macOS, `xdg-open` elsewhere. */
export function urlOpenerPath(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? '/usr/bin/open' : '/usr/bin/xdg-open';
}
