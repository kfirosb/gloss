import { readFileSync, readlinkSync } from 'node:fs';

/** The two reads Claude Code combines into a Linux pid domain. */
export interface PidDomainReads {
  readFileSync(path: string, encoding: 'utf8'): string;
  readlinkSync(path: string): string;
}

/**
 * The process table a pid belongs to, written by Claude Code into every session record as `pidDomain`: plain
 * `darwin` on macOS and `darwin:<machine-id>:<pid namespace>` on Linux (Claude keeps the `darwin:` prefix there;
 * a missing machine id or namespace is an empty field). A record's `procStart` is comparable with this host's `ps`
 * only when its domain equals this one.
 */
export function ownPidDomain(
  platform: NodeJS.Platform = process.platform,
  fs: PidDomainReads = { readFileSync, readlinkSync },
): string {
  if (platform === 'darwin') return 'darwin';
  if (platform !== 'linux') return platform;
  const read = (op: () => string) => {
    try {
      return op();
    } catch {
      return '';
    }
  };
  const machineId = read(() => fs.readFileSync('/etc/machine-id', 'utf8').trim());
  const pidNamespace = read(() => fs.readlinkSync('/proc/self/ns/pid'));
  return `darwin:${machineId}:${pidNamespace}`;
}

/** This process's own pid domain; a Claude record with any other domain cannot be matched against `ps` here. */
export const OWN_PID_DOMAIN = ownPidDomain();
