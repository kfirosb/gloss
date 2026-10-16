import { constants } from 'node:fs';
import { recordOf, type JsonRecord } from '../core/json-record.js';
import { access, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Target } from '../core/contracts.js';
import { CLAUDE_SETUP_PROMPT } from '../core/session-contracts.js';
import type { ChannelRecord, ChannelStatus } from '../agents/claude/channel-types.js';
import { createChannelRegistry } from '../agents/claude/channel-registry.js';
import { validateTarget } from '../agents/shared.js';
import { collectProcess, runProcess, type ProcessRunner } from './process-runner.js';

export interface ChannelSetup {
  command: string;
  experimental: true;
  instructions: string;
}
export interface ChannelSetupService {
  status(target: Target): Promise<ChannelStatus>;
  createChannelSetup(target?: Target, newProject?: string): Promise<ChannelSetup>;
}
export interface NewSessionChannelSetupService extends ChannelSetupService {
  prepareNewSessionConfig(project: string): Promise<{ claude: string; mcpConfigPath: string }>;
}
/** Trusted host/test options only. Never accept these through HTTP. */
export interface ChannelSetupOptions {
  stateDir?: string;
  homeDir?: string;
  configDir?: string;
  managedDir?: string;
  systemLibraryDir?: string;
  nodePath?: string;
  cliPath?: string;
  claudePath?: string;
  platform?: NodeJS.Platform;
  runner?: ProcessRunner;
  now?: () => number;
  registry?: {
    resolveChannel(target: Target): Promise<Pick<ChannelRecord, 'target'> | undefined>;
  };
}
export { CLAUDE_SETUP_PROMPT };
const serverName = 'language-assistant';
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
async function jsonConfig(path: string): Promise<JsonRecord | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('Invalid configuration');
    const value = recordOf(JSON.parse(await file.readFile('utf8')));
    if (!value) throw new Error('Invalid configuration');
    return value;
  } catch (error) {
    if (absent(error)) return undefined;
    // Config may contain tokens; parser diagnostics must never leave this boundary.
    throw new Error(
      'Cannot safely inspect Claude configuration; check local configuration before setup.',
    );
  } finally {
    await file?.close();
  }
}
async function privateDirectory(path: string) {
  await mkdir(path, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o777) !== 0o700 ||
    info.uid !== process.getuid?.()
  )
    throw new Error('Unsafe setup directory; a private app-owned directory is required.');
}
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (absent(error)) return false;
    throw new Error('Cannot inspect managed Claude policy; administrator review is required.');
  }
}
export function createClaudeChannelSetup(
  options: ChannelSetupOptions = {},
): NewSessionChannelSetupService {
  const home = options.homeDir ?? homedir();
  const stateDir = resolve(options.stateDir ?? join(home, '.language-assistant'));
  const setupDir = join(stateDir, 'claude-channel-setup');
  const configDir = resolve(
    options.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'),
  );
  const library = options.systemLibraryDir ?? '/Library';
  const managedDir = options.managedDir ?? join(library, 'Application Support', 'ClaudeCode');
  const registry =
    options.registry ??
    createChannelRegistry({ registryDir: join(stateDir, 'claude-channels'), configDir });
  const now = options.now ?? Date.now;
  const seen = new Set<string>();
  const configPath = (project: string, session: string) =>
    join(
      setupDir,
      createHash('sha256')
        .update(JSON.stringify([project, session]))
        .digest('hex') + '.json',
    );
  let capability: { until: number; promise: Promise<string> } | undefined;
  async function executable() {
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
            ['--dangerously-load-development-channels', 'server:' + serverName, '--version'],
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
      capability = { until: now() + 60_000, promise };
    }
    return capability.promise;
  }
  async function projectFor(target?: Target, newProject?: string) {
    if (target) validateTarget(target, 'claude');
    const path = target?.projectId ?? newProject;
    if (!path || !isAbsolute(path)) throw new Error('An absolute project path is required.');
    const project = await realpath(path).catch(() => {
      throw new Error('Project directory is unavailable.');
    });
    if (!(await lstat(project)).isDirectory() || (target && project !== target.projectId))
      throw new Error('Invalid canonical project identity.');
    return project;
  }
  async function preflight(project: string) {
    if ((options.platform ?? process.platform) !== 'darwin')
      throw new Error('Experimental Claude channels are supported on macOS only.');
    const global = await jsonConfig(join(home, '.claude.json'));
    const alternate =
      configDir !== join(home, '.claude')
        ? await jsonConfig(join(configDir, '.claude.json'))
        : undefined;
    const projectConfig = await jsonConfig(join(project, '.mcp.json'));
    const managed = await jsonConfig(join(managedDir, 'managed-mcp.json'));
    if (managed)
      throw new Error(
        'Managed MCP configuration is unsupported by automatic setup; ask your administrator.',
      );
    const domain = 'com.anthropic.claudecode.plist';
    for (const path of [
      join(managedDir, 'managed-settings.d'),
      join(library, 'Managed Preferences', domain),
      join(library, 'Managed Preferences', basename(home), domain),
      join(library, 'Preferences', domain),
      join(home, 'Library', 'Preferences', domain),
    ]) {
      if (await exists(path))
        throw new Error(
          'Managed Claude policy requires administrator review before channel setup.',
        );
    }
    for (const settingsPath of [
      join(managedDir, 'managed-settings.json'),
      join(configDir, 'settings.json'),
      join(project, '.claude', 'settings.json'),
      join(project, '.claude', 'settings.local.json'),
    ]) {
      const settings = await jsonConfig(settingsPath);
      if (
        settings &&
        [
          'managedMcpServers',
          'allowedMcpServers',
          'deniedMcpServers',
          'allowManagedMcpServersOnly',
        ].some((key) => key in settings)
      )
        throw new Error('Managed MCP policy requires administrator review before channel setup.');
    }
    for (const config of [
      global,
      alternate,
      projectConfig,
      recordOf(recordOf(global?.projects)?.[project]),
      recordOf(recordOf(alternate?.projects)?.[project]),
    ]) {
      if (config?.mcpServers && Object.hasOwn(config.mcpServers, serverName))
        throw new Error(
          'Claude MCP server name conflict: language-assistant already exists. Resolve it explicitly before setup.',
        );
    }
    return executable();
  }
  async function prepareConfig(project: string, session?: string) {
    const claude = await preflight(project);
    const node = await realpath(options.nodePath ?? process.execPath);
    const cli = await realpath(
      options.cliPath ?? fileURLToPath(new URL('./cli.js', import.meta.url)),
    ).catch(() => {
      throw new Error('Build the application before preparing channel setup.');
    });
    // Claude expands ${...} inside MCP config strings. Reject ambiguous executable paths.
    if ([node, cli].some((path) => path.includes('${')))
      throw new Error(
        'Executable paths containing Claude environment interpolation are unsupported.',
      );
    await privateDirectory(stateDir);
    await privateDirectory(setupDir);
    const path = configPath(project, session ?? 'new-' + randomUUID());
    const temporary = join(setupDir, randomUUID() + '.tmp');
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      // The desktop build uses Electron's bundled Node executable; plain Node ignores this flag.
      await file.writeFile(
        JSON.stringify(
          {
            mcpServers: {
              [serverName]: {
                command: node,
                args: [cli, '--claude-channel'],
                env: { ELECTRON_RUN_AS_NODE: '1' },
              },
            },
          },
          null,
          2,
        ) + '\n',
      );
      await file.sync();
      await file.close();
      await rename(temporary, path);
    } finally {
      await file.close();
      await unlink(temporary).catch(() => {});
    }
    seen.delete(path);
    return { claude, mcpConfigPath: path };
  }
  async function prepareNewSessionConfig(project: string) {
    return prepareConfig(await projectFor(undefined, project));
  }
  return {
    prepareNewSessionConfig,
    async status(target) {
      try {
        const project = await projectFor(target);
        await preflight(project);
        const path = configPath(project, target.sessionRef);
        if (await registry.resolveChannel(target)) {
          seen.add(path);
          return { state: 'connected' };
        }
        if (seen.has(path))
          return {
            state: 'disconnected',
            reason: 'The exact session no longer has a verified ready channel.',
          };
        try {
          const prepared = await lstat(path);
          if (!prepared.isFile() || prepared.isSymbolicLink() || (prepared.mode & 0o777) !== 0o600)
            throw new Error('Unsafe setup configuration.');
          return now() - prepared.mtimeMs < 90_000
            ? {
                state: 'connecting',
                reason:
                  'Setup prepared; waiting for you to resume and accept Claude consent. No ready channel verified yet.',
              }
            : {
                state: 'disconnected',
                reason:
                  'Setup was prepared, but no ready channel is verified. Resume the exact session and accept consent.',
              };
        } catch (error) {
          if (!absent(error)) throw error;
        }
        return { state: 'setup-required', reason: 'Discovery alone does not enable sending.' };
      } catch (error) {
        return {
          state: 'unsupported',
          reason: error instanceof Error ? error.message : 'Channel setup unavailable.',
        };
      }
    },
    async createChannelSetup(target, newProject) {
      const project = await projectFor(target, newProject);
      const { claude, mcpConfigPath: path } = await (target
        ? prepareConfig(project, target.sessionRef)
        : prepareNewSessionConfig(project));
      // The prompt must directly follow the executable: the later options are variadic and would swallow a trailing positional.
      const args = [
        claude,
        ...(!target ? [CLAUDE_SETUP_PROMPT] : []),
        ...(target ? ['--resume', target.sessionRef] : []),
        '--mcp-config',
        path,
        '--dangerously-load-development-channels',
        'server:' + serverName,
      ];
      return {
        command: 'cd ' + quote(project) + ' && ' + args.map(quote).join(' '),
        experimental: true,
        instructions:
          (target
            ? 'Stop the existing Claude process normally first, then run this command to resume that exact session. '
            : 'This starts a new session when you run it. The disclosed setup prompt “' +
              CLAUDE_SETUP_PROMPT +
              '” makes one model request to initialize its transcript. ') +
          'Accept Claude’s experimental per-launch consent. Account or organization policy may still prevent connection. This prepares instructions only; nothing has been launched.',
      };
    },
  };
}
export const createChannelSetup = (target?: Target, newProject?: string) =>
  createClaudeChannelSetup().createChannelSetup(target, newProject);

export const prepareNewSessionConfig = (project: string) =>
  createClaudeChannelSetup().prepareNewSessionConfig(project);
