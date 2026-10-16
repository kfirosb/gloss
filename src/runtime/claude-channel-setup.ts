import { recordOf } from '../core/json-record.js';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Target } from '../core/contracts.js';
import { CLAUDE_SETUP_PROMPT } from '../core/session-contracts.js';
import type { ChannelRecord, ChannelStatus } from '../agents/claude/channel-types.js';
import { createChannelRegistry } from '../agents/claude/channel-registry.js';
import { claudeConfigDir, validateTarget } from '../agents/shared.js';
import { LEGACY_SERVER } from '../agents/claude/channel-names.js';
import { writeFileAtomic } from './atomic-file.js';
import {
  channelServerPaths,
  createClaudeExecutable,
  isMissingFile,
  opaqueManagedPolicyPaths,
  pathExists,
  readClaudeConfigFile,
} from './claude-config.js';
import type { ProcessRunner } from './process-runner.js';
import { ensurePrivateDirectory, isPrivateDirectory } from './private-directory.js';

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
  /** Points every prepared config at this build, so saved commands survive an app rename or move. */
  repairConfigs(): Promise<{ repaired: number }>;
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
// Per-session files and the commands users saved with them name the legacy server. Never change this key:
// a file keyed `gloss` under a saved `server:language-assistant` command makes Claude ignore the channel.
const serverName = LEGACY_SERVER;
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const privateDirectory = (path: string) =>
  ensurePrivateDirectory(
    path,
    'Unsafe setup directory; a private app-owned directory is required.',
  );
export function createClaudeChannelSetup(
  options: ChannelSetupOptions = {},
): NewSessionChannelSetupService {
  const home = options.homeDir ?? homedir();
  const stateDir = resolve(options.stateDir ?? join(home, '.language-assistant'));
  const setupDir = join(stateDir, 'claude-channel-setup');
  const configDir = resolve(claudeConfigDir(options.configDir, home));
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
  const executable = createClaudeExecutable({
    homeDir: home,
    claudePath: options.claudePath,
    runner: options.runner,
    now,
  });
  const serverPaths = () => channelServerPaths(options.nodePath, options.cliPath);
  const writeConfig = (path: string, node: string, cli: string) =>
    // The desktop build uses Electron's bundled Node executable; plain Node ignores this flag.
    writeFileAtomic(
      path,
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
      0o600,
    );
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
    const global = await readClaudeConfigFile(join(home, '.claude.json'));
    const alternate =
      configDir !== join(home, '.claude')
        ? await readClaudeConfigFile(join(configDir, '.claude.json'))
        : undefined;
    const projectConfig = await readClaudeConfigFile(join(project, '.mcp.json'));
    const managed = await readClaudeConfigFile(join(managedDir, 'managed-mcp.json'));
    if (managed)
      throw new Error(
        'Managed MCP configuration is unsupported by automatic setup; ask your administrator.',
      );
    for (const path of opaqueManagedPolicyPaths({ home, library, managedDir })) {
      if (await pathExists(path))
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
      const settings = await readClaudeConfigFile(settingsPath);
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
    const { node, cli } = await serverPaths();
    await privateDirectory(stateDir);
    await privateDirectory(setupDir);
    const path = configPath(project, session ?? 'new-' + randomUUID());
    await writeConfig(path, node, cli);
    seen.delete(path);
    return { claude, mcpConfigPath: path };
  }
  async function repairConfigs() {
    // A saved command keeps its config path forever, so a config naming an older or renamed
    // app would start that build's channel helper. Only files this module wrote are touched.
    try {
      if (!isPrivateDirectory(await lstat(setupDir))) return { repaired: 0 };
    } catch (error) {
      if (isMissingFile(error)) return { repaired: 0 };
      throw error;
    }
    const { node, cli } = await serverPaths();
    let repaired = 0;
    for (const name of await readdir(setupDir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = join(setupDir, name);
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) continue;
        const config = await readClaudeConfigFile(path);
        const servers = recordOf(config?.mcpServers);
        const server = recordOf(servers?.[serverName]);
        if (
          !config ||
          !servers ||
          Object.keys(config).length !== 1 ||
          Object.keys(servers).length !== 1 ||
          !server ||
          typeof server.command !== 'string' ||
          !Array.isArray(server.args) ||
          server.args.length !== 2 ||
          server.args[1] !== '--claude-channel'
        )
          continue;
        if (server.command === node && server.args[0] === cli) continue;
        await writeConfig(path, node, cli);
        repaired++;
      } catch {
        /* One unreadable config must not block repairing the rest. */
      }
    }
    return { repaired };
  }
  async function prepareNewSessionConfig(project: string) {
    return prepareConfig(await projectFor(undefined, project));
  }
  return {
    prepareNewSessionConfig,
    repairConfigs,
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
          if (!isMissingFile(error)) throw error;
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
