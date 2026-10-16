import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { GLOSS_SERVER } from '../agents/claude/channel-names.js';
import { claudeConfigDir } from '../agents/shared.js';
import { recordOf, type JsonRecord } from '../core/json-record.js';
import { channelServerPaths, readClaudeConfigFile } from './claude-config.js';
import { collectProcess, runProcess, type ProcessRunner } from './process-runner.js';

export type RegistrationStatus =
  | { state: 'unregistered' }
  | { state: 'registered' }
  | { state: 'stale'; found: string }
  | { state: 'conflict'; found: string }
  | { state: 'unavailable'; reason: string };
export interface RegistrationService {
  status(): Promise<RegistrationStatus>;
  register(): Promise<RegistrationStatus>;
  remove(): Promise<RegistrationStatus>;
}
/** Trusted host/test options only. Never accept these through HTTP. */
export interface RegistrationOptions {
  /** The verified Claude executable, normally `createClaudeExecutable()`. */
  claude: () => Promise<string>;
  homeDir?: string | undefined;
  configDir?: string | undefined;
  nodePath?: string | undefined;
  cliPath?: string | undefined;
  runner?: ProcessRunner | undefined;
}

/** `claude mcp add-json`/`remove` only edit a JSON file; these bound a hung or chatty CLI. */
const MCP_COMMAND_TIMEOUT_MS = 15_000;
const MCP_COMMAND_ABORT_MS = 20_000;
const MCP_COMMAND_OUTPUT_BYTES = 16_384;
const MCP_COMMAND_DIAGNOSTIC_BYTES = 2048;
const UNDESCRIBED = 'an entry Gloss cannot describe';

/** Where an entry points, without env, headers, argument values or URL credentials, which may hold secrets. */
function describeEntry(entry: JsonRecord | undefined): string {
  if (typeof entry?.url === 'string') {
    try {
      return new URL(entry.url).origin;
    } catch {
      return UNDESCRIBED;
    }
  }
  return typeof entry?.command === 'string' ? entry.command : UNDESCRIBED;
}
/** The paths of an entry Gloss wrote: Electron as Node running cli.js with the channel flag. */
function ownPaths(entry: JsonRecord | undefined): { node: string; cli: string } | undefined {
  const args: unknown = entry?.args;
  if (!entry || (entry.type !== undefined && entry.type !== 'stdio')) return undefined;
  if (typeof entry.command !== 'string' || !Array.isArray(args) || args.length !== 2)
    return undefined;
  const [cli, flag]: unknown[] = args;
  if (typeof cli !== 'string' || flag !== '--claude-channel') return undefined;
  return recordOf(entry.env)?.ELECTRON_RUN_AS_NODE === '1'
    ? { node: entry.command, cli }
    : undefined;
}
const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : 'Claude configuration is unavailable.';

/** The user-scope `gloss` MCP entry that lets any Claude session load the channel with `server:gloss`. */
export function createClaudeRegistration(options: RegistrationOptions): RegistrationService {
  const home = options.homeDir ?? homedir();
  const configDir = resolve(claudeConfigDir(options.configDir, home));
  const defaultConfigDir = join(home, '.claude');
  // Claude keeps user-scope MCP servers in ~/.claude.json, or in $CLAUDE_CONFIG_DIR/.claude.json when that is set.
  const claudeJson =
    configDir === defaultConfigDir ? join(home, '.claude.json') : join(configDir, '.claude.json');
  // Run the CLI against exactly the file read above.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  if (configDir === defaultConfigDir) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = configDir;

  async function run(args: string[]): Promise<void> {
    const result = await collectProcess(
      (options.runner ?? runProcess)(
        await options.claude(),
        args,
        '',
        AbortSignal.timeout(MCP_COMMAND_ABORT_MS),
        {
          env,
          timeoutMs: MCP_COMMAND_TIMEOUT_MS,
          maxOutputBytes: MCP_COMMAND_OUTPUT_BYTES,
          maxDiagnosticBytes: MCP_COMMAND_DIAGNOSTIC_BYTES,
        },
      ),
    );
    // Diagnostics may echo configuration, so they never reach the message.
    if (result.outcome.reason !== 'exited' || result.outcome.code !== 0)
      throw new Error(`Claude did not complete "claude mcp ${args[1] ?? ''}".`);
  }
  async function status(): Promise<RegistrationStatus> {
    try {
      const servers = recordOf((await readClaudeConfigFile(claudeJson))?.mcpServers);
      if (!servers || !Object.hasOwn(servers, GLOSS_SERVER)) return { state: 'unregistered' };
      const entry = recordOf(servers[GLOSS_SERVER]);
      const own = ownPaths(entry);
      if (!own) return { state: 'conflict', found: describeEntry(entry) };
      const { node, cli } = await channelServerPaths(options.nodePath, options.cliPath);
      return own.node === node && own.cli === cli
        ? { state: 'registered' }
        : { state: 'stale', found: own.node };
    } catch (error) {
      return { state: 'unavailable', reason: reasonOf(error) };
    }
  }
  return {
    status,
    async register() {
      const current = await status();
      if (current.state === 'registered') return current;
      if (current.state === 'conflict')
        throw new Error(
          `The name "gloss" is already used by another server in Claude (${current.found}). Remove or rename it in Claude first.`,
        );
      if (current.state === 'unavailable') throw new Error(current.reason);
      const { node, cli } = await channelServerPaths(options.nodePath, options.cliPath);
      if (current.state === 'stale') await run(['mcp', 'remove', '--scope', 'user', GLOSS_SERVER]);
      await run([
        'mcp',
        'add-json',
        '--scope',
        'user',
        GLOSS_SERVER,
        JSON.stringify({
          type: 'stdio',
          command: node,
          args: [cli, '--claude-channel'],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        }),
      ]);
      const after = await status();
      if (after.state !== 'registered')
        throw new Error('Claude did not record the gloss connection server.');
      return after;
    },
    async remove() {
      const current = await status();
      if (current.state === 'unregistered') return current;
      if (current.state === 'conflict')
        throw new Error('The "gloss" server in Claude is not Gloss; it was left unchanged.');
      if (current.state === 'unavailable') throw new Error(current.reason);
      await run(['mcp', 'remove', '--scope', 'user', GLOSS_SERVER]);
      return status();
    },
  };
}
