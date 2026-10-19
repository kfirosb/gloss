import { constants } from 'node:fs';
import { access, lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_SERVER } from '../agents/claude/channel-names.js';
import { recordOf, type JsonRecord } from '../core/json-record.js';
import { collectProcess, runProcess, type ProcessRunner } from './process-runner.js';

/** Largest Claude config file Gloss reads, in bytes. */
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
/** How long a successful (or failed) capability probe of the installed Claude is reused, in milliseconds. */
const EXECUTABLE_PROBE_TTL_MS = 60_000;
const PREFERENCES_DOMAIN = 'com.anthropic.claudecode.plist';

export const isMissingFile = (error: unknown) => recordOf(error)?.code === 'ENOENT';

/** Fails closed: a missing file is undefined; anything unreadable, oversized, linked or not a JSON object throws a fixed message without content. */
export async function readClaudeConfigFile(path: string): Promise<JsonRecord | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) throw new Error('Invalid configuration');
    const value = recordOf(JSON.parse(await file.readFile('utf8')));
    if (!value) throw new Error('Invalid configuration');
    return value;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    // Config may contain tokens; parser diagnostics must never leave this boundary.
    throw new Error(
      'Cannot safely inspect Claude configuration; check local configuration before setup.',
    );
  } finally {
    await file?.close();
  }
}

/** Where Claude keeps user-scope settings such as MCP servers: `$CLAUDE_CONFIG_DIR/.claude.json` whenever a
 * config dir is set (by option or a nonempty env var), even when it names `~/.claude`; otherwise `~/.claude.json`.
 * `configDir` is the explicitly set dir, resolved, or undefined.
 */
export function claudeUserConfigPath(options: { home: string; configDir?: string | undefined }): {
  path: string;
  configDir: string | undefined;
} {
  const explicit = options.configDir ?? (process.env.CLAUDE_CONFIG_DIR || undefined);
  if (explicit === undefined)
    return { path: join(options.home, '.claude.json'), configDir: undefined };
  const configDir = resolve(explicit);
  return { path: join(configDir, '.claude.json'), configDir };
}

/** The executable and cli.js this build runs the channel bridge with. */
export async function channelServerPaths(
  nodePath?: string | undefined,
  cliPath?: string | undefined,
): Promise<{ node: string; cli: string }> {
  const node = await realpath(nodePath ?? process.execPath);
  const cli = await realpath(cliPath ?? fileURLToPath(new URL('./cli.js', import.meta.url))).catch(
    () => {
      throw new Error('Build the application before preparing channel setup.');
    },
  );
  // Claude expands ${...} inside MCP config strings. Reject ambiguous executable paths.
  if ([node, cli].some((path) => path.includes('${')))
    throw new Error(
      'Executable paths containing Claude environment interpolation are unsupported.',
    );
  return { node, cli };
}

export interface ClaudeExecutableOptions {
  homeDir?: string | undefined;
  claudePath?: string | undefined;
  runner?: ProcessRunner | undefined;
  now?: (() => number) | undefined;
}
/** A cached lookup of the installed Claude that accepts development channels. */
export function createClaudeExecutable(
  options: ClaudeExecutableOptions = {},
): () => Promise<string> {
  const home = options.homeDir ?? homedir();
  const now = options.now ?? Date.now;
  let capability: { until: number; promise: Promise<string> } | undefined;
  return () => {
    if (!capability || capability.until < now()) {
      const promise = (async () => {
        let executable = options.claudePath;
        const directories = [
          join(home, '.local', 'bin'),
          ...(process.env.PATH ?? '').split(':').filter(isAbsolute),
        ].filter((directory) => !/(?:^|\/)\.superset(?:-[^/]*)?\/bin\/?$/.test(directory));
        if (!executable)
          for (const directory of directories) {
            try {
              const candidate = join(directory, 'claude');
              await access(candidate, constants.X_OK);
              executable = await realpath(candidate);
              break;
            } catch {
              /* Next PATH entry. */
            }
          }
        if (!executable || !isAbsolute(executable))
          throw new Error(
            'Claude executable unavailable. Install a Claude CLI supporting experimental development channels.',
          );
        const result = await collectProcess(
          (options.runner ?? runProcess)(
            executable,
            ['--dangerously-load-development-channels', 'server:' + LEGACY_SERVER, '--version'],
            '',
            AbortSignal.timeout(5000),
            { timeoutMs: 4000, maxOutputBytes: 8192, maxDiagnosticBytes: 1024 },
          ),
        );
        if (
          result.outcome.code !== 0 ||
          result.outcome.reason !== 'exited' ||
          !result.lines.some((line) => /\b\d+\.\d+\.\d+\b/.test(line))
        )
          throw new Error(
            'Installed Claude did not accept the experimental development-channel capability probe.',
          );
        return executable;
      })();
      capability = { until: now() + EXECUTABLE_PROBE_TTL_MS, promise };
    }
    return capability.promise;
  };
}

/** Where Claude reads administrator-managed policy: a system library folder on macOS, /etc on Linux. */
export const defaultManagedDir = (platform: NodeJS.Platform, library: string) =>
  platform === 'linux' ? '/etc/claude-code' : join(library, 'Application Support', 'ClaudeCode');

/** Managed policy Gloss cannot interpret (a fragment folder or a preferences profile); its presence alone needs administrator review. */
export const opaqueManagedPolicyPaths = (locations: {
  home: string;
  library: string;
  managedDir: string;
  platform: NodeJS.Platform;
}) => [
  join(locations.managedDir, 'managed-settings.d'),
  // Preference profiles are a macOS mechanism; Linux has only the fragment folder.
  ...(locations.platform === 'darwin'
    ? [
        join(locations.library, 'Managed Preferences', PREFERENCES_DOMAIN),
        join(
          locations.library,
          'Managed Preferences',
          basename(locations.home),
          PREFERENCES_DOMAIN,
        ),
        join(locations.library, 'Preferences', PREFERENCES_DOMAIN),
        join(locations.home, 'Library', 'Preferences', PREFERENCES_DOMAIN),
      ]
    : []),
];

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw new Error('Cannot inspect managed Claude policy; administrator review is required.');
  }
}
