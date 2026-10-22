import { recordOf } from '../core/json-record.js';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { existingDataDir, legacyDataDir } from './data-dir.js';
import type { Target } from '../core/contracts.js';
import { CLAUDE_SETUP_PROMPT } from '../core/session-contracts.js';
import type { ChannelRecord, ChannelStatus } from '../agents/claude/channel-types.js';
import { createChannelRegistry } from '../agents/claude/channel-registry.js';
import { claudeConfigDir, validateTarget } from '../agents/shared.js';
import {
  CHANNEL_REGISTRY_DIR,
  GLOSS_SERVER,
  LEGACY_SERVER,
} from '../agents/claude/channel-names.js';
import { shellQuote } from '../core/command-text.js';
import { writeFileAtomic } from './atomic-file.js';
import {
  channelServerPaths,
  claudeUserConfigPath,
  createClaudeExecutable,
  defaultManagedDir,
  isMissingFile,
  opaqueManagedPolicyPaths,
  pathExists,
  readClaudeConfigFile,
} from './claude-config.js';
import {
  createClaudeRegistration,
  type RegistrationService,
  type RegistrationStatus,
} from './claude-registration.js';
import type { ProcessRunner } from './process-runner.js';
import { supportsProcessProbes } from './platform-tools.js';
import { ensurePrivateDirectory, isPrivateDirectory } from './private-directory.js';

/** What an existing session needs to connect. Producing it writes nothing. */
export type ChannelSetup =
  | {
      kind: 'registration-required';
      registration: Exclude<RegistrationStatus, { state: 'registered' }>;
    }
  | { kind: 'command'; command: string; cdCommand: string; folder: string };
/** The legacy launch command for a new session (the `--prepare-claude-channel` CLI path). */
export interface NewSessionSetup {
  command: string;
  experimental: true;
  instructions: string;
}
export interface ChannelSetupService {
  status(target: Target): Promise<ChannelStatus>;
  createChannelSetup(target: Target): Promise<ChannelSetup>;
}
export interface NewSessionChannelSetupService extends ChannelSetupService {
  newSessionSetup(project: string): Promise<NewSessionSetup>;
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
  /** The verified Claude executable lookup, shared with registration; built from `claudePath` when absent. */
  claude?: (() => Promise<string>) | undefined;
  platform?: NodeJS.Platform;
  runner?: ProcessRunner;
  now?: () => number;
  registry?: {
    resolveChannel(target: Target): Promise<Pick<ChannelRecord, 'target'> | undefined>;
  };
  registration?: Pick<RegistrationService, 'status'> | undefined;
}
export { CLAUDE_SETUP_PROMPT };
// Per-session files and the commands users saved with them name the legacy server. Never change this key:
// a file keyed `gloss` under a saved `server:language-assistant` command makes Claude ignore the channel.
const serverName = LEGACY_SERVER;
const privateDirectory = (path: string) =>
  ensurePrivateDirectory(
    path,
    'Unsafe setup directory; a private app-owned directory is required.',
  );
export function createClaudeChannelSetup(
  options: ChannelSetupOptions = {},
): NewSessionChannelSetupService {
  const home = options.homeDir ?? homedir();
  // `--prepare-claude-channel` runs before any move: it must not create the new folder beside the old one.
  const stateDir = resolve(options.stateDir ?? existingDataDir(home));
  const setupDir = join(stateDir, 'claude-channel-setup');
  const configDir = resolve(claudeConfigDir(options.configDir, home));
  const userConfigPath = claudeUserConfigPath({ home, configDir: options.configDir }).path;
  const platform = options.platform ?? process.platform;
  const library = options.systemLibraryDir ?? '/Library';
  const managedDir = options.managedDir ?? defaultManagedDir(platform, library);
  const registry =
    options.registry ??
    createChannelRegistry({
      registryDir: join(stateDir, CHANNEL_REGISTRY_DIR),
      // Only with the real data folder: an injected one has no old counterpart.
      ...(options.stateDir === undefined
        ? { legacyRegistryDir: join(legacyDataDir(home), CHANNEL_REGISTRY_DIR) }
        : {}),
      configDir,
    });
  const now = options.now ?? Date.now;
  const seen = new Set<string>();
  const configPath = (project: string, session: string) =>
    join(
      setupDir,
      createHash('sha256')
        .update(JSON.stringify([project, session]))
        .digest('hex') + '.json',
    );
  const executable =
    options.claude ??
    createClaudeExecutable({
      homeDir: home,
      claudePath: options.claudePath,
      runner: options.runner,
      now,
    });
  const registration =
    options.registration ??
    createClaudeRegistration({
      claude: executable,
      homeDir: home,
      // Unresolved: whether a config dir was set decides which .claude.json Claude uses.
      configDir: options.configDir,
      nodePath: options.nodePath,
      cliPath: options.cliPath,
      runner: options.runner,
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
    if (!supportsProcessProbes(platform))
      throw new Error('Experimental Claude channels are supported on macOS and Linux only.');
    const user = await readClaudeConfigFile(userConfigPath);
    const projectConfig = await readClaudeConfigFile(join(project, '.mcp.json'));
    const managed = await readClaudeConfigFile(join(managedDir, 'managed-mcp.json'));
    if (managed)
      throw new Error(
        'Managed MCP configuration is unsupported by automatic setup; ask your administrator.',
      );
    for (const path of opaqueManagedPolicyPaths({ home, library, managedDir, platform })) {
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
    for (const config of [user, projectConfig, recordOf(recordOf(user?.projects)?.[project])]) {
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
        const registered = (await registration.status()).state === 'registered';
        return {
          state: 'setup-required',
          reason: registered
            ? 'Close the session and run the command in "Connect this session to Gloss".'
            : 'Register Gloss with Claude once, then run the connect command.',
        };
      } catch (error) {
        return {
          state: 'unsupported',
          reason: error instanceof Error ? error.message : 'Channel setup unavailable.',
        };
      }
    },
    async createChannelSetup(target) {
      const project = await projectFor(target);
      await preflight(project);
      const current = await registration.status();
      if (current.state !== 'registered')
        return { kind: 'registration-required', registration: current };
      // The id is a validated UUID and the server name a constant; only the folder needs quoting.
      const command = [
        'claude',
        '--resume',
        target.sessionRef,
        '--dangerously-load-development-channels',
        'server:' + GLOSS_SERVER,
      ].join(' ');
      return {
        kind: 'command',
        command,
        cdCommand: 'cd ' + shellQuote(project) + ' && ' + command,
        folder: project,
      };
    },
    async newSessionSetup(newProject) {
      const project = await projectFor(undefined, newProject);
      const { claude, mcpConfigPath } = await prepareConfig(project);
      // The prompt must directly follow the executable: the later options are variadic and would swallow a trailing positional.
      const args = [
        claude,
        CLAUDE_SETUP_PROMPT,
        '--mcp-config',
        mcpConfigPath,
        '--dangerously-load-development-channels',
        'server:' + serverName,
      ];
      return {
        command: 'cd ' + shellQuote(project) + ' && ' + args.map(shellQuote).join(' '),
        experimental: true,
        instructions:
          'This starts a new session when you run it. The disclosed setup prompt “' +
          CLAUDE_SETUP_PROMPT +
          '” makes one model request to initialize its transcript. Accept Claude’s experimental per-launch consent. Account or organization policy may still prevent connection. This prepares instructions only; nothing has been launched.',
      };
    },
  };
}
export const createNewSessionSetup = (project: string) =>
  createClaudeChannelSetup().newSessionSetup(project);

export const prepareNewSessionConfig = (project: string) =>
  createClaudeChannelSetup().prepareNewSessionConfig(project);
