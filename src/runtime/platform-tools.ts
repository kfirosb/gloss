/**
 * Where the host's process-inspection tools live and which platforms may run them. Discovery, liveness and channel
 * identity read the process table through `ps` and `lsof`; their output was verified on macOS and Linux (procps,
 * lsof 4.9x), so only those platforms probe. Everything else fails closed.
 */
const PROBE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set<NodeJS.Platform>(['darwin', 'linux']);

export const PS_PATH = '/bin/ps';
export const PROBES_UNAVAILABLE = 'Process probes are unavailable on this platform';

export function supportsProcessProbes(platform: NodeJS.Platform = process.platform): boolean {
  return PROBE_PLATFORMS.has(platform);
}

/** macOS ships lsof in /usr/sbin; Linux distributions install it in /usr/bin (and often not by default). */
export function lsofPath(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof';
}

/** The system URL/route opener: `open` on macOS, `xdg-open` elsewhere. */
export function urlOpenerPath(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? '/usr/bin/open' : '/usr/bin/xdg-open';
}
