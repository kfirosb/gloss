import { collectProcess, runProcess, type ProcessRunner } from '../../runtime/process-runner.js';
import { isChannelServer, LEGACY_SERVER } from './channel-names.js';

/** The variable the user-scope registration sets. Per-session files predate it, so its absence means the legacy name. */
export const CHANNEL_SERVER_ENV = 'GLOSS_CHANNEL_SERVER';
const CHANNELS_FLAG = '--dangerously-load-development-channels';
/** Bounds the one `ps` call that reads the parent Claude's command line, in milliseconds. */
const PARENT_COMMAND_TIMEOUT_MS = 2000;
/** macOS ARG_MAX is 1 MiB; leave room for the environment-free `ps args` rendering. */
const PARENT_COMMAND_MAX_BYTES = 1_100_000;

/** The server name this bridge runs as, or undefined when the environment names something that is not ours. */
export function channelServerFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const value = env[CHANNEL_SERVER_ENV];
  if (value === undefined) return LEGACY_SERVER;
  return isChannelServer(value) ? value : undefined;
}

/** Whether a Claude command line (as `ps -o args=` prints it) loads `server:<name>` as a development channel.
 * Accepts `--flag value`, `--flag=value`, and comma- or space-separated lists; stops at `--`, after which only the prompt follows.
 */
export function commandLineEnablesChannel(commandLine: string, name: string): boolean {
  const wanted = `server:${name}`;
  const tokens = commandLine.split(/\s+/).filter(Boolean);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === undefined || token === '--') return false;
    const values: string[] = [];
    if (token === CHANNELS_FLAG) {
      // The flag is variadic: values continue until the next option.
      for (let next = tokens[index + 1]; next !== undefined && !next.startsWith('-');) {
        values.push(next);
        index++;
        next = tokens[index + 1];
      }
    } else if (token.startsWith(`${CHANNELS_FLAG}=`))
      values.push(token.slice(CHANNELS_FLAG.length + 1));
    else continue;
    if (values.some((value) => value.split(',').includes(wanted))) return true;
  }
  return false;
}

/** The parent process's command line, or undefined when it cannot be read. */
export async function readParentCommandLine(
  runner: ProcessRunner = runProcess,
  parentPid: number = process.ppid,
): Promise<string | undefined> {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 1) return undefined;
  const result = await collectProcess(
    runner(
      '/bin/ps',
      ['-ww', '-o', 'args=', '-p', String(parentPid)],
      '',
      AbortSignal.timeout(PARENT_COMMAND_TIMEOUT_MS + 1000),
      {
        env: { ...process.env, LC_ALL: 'C' },
        timeoutMs: PARENT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: PARENT_COMMAND_MAX_BYTES,
        maxLineBytes: PARENT_COMMAND_MAX_BYTES,
        maxDiagnosticBytes: 1024,
      },
    ),
  );
  if (result.outcome.reason !== 'exited' || result.outcome.code !== 0 || !result.lines.length)
    return undefined;
  return result.lines.join('\n');
}

/** The name this bridge may serve as a channel, or undefined when its Claude did not enable it. Fails closed. */
export async function enabledChannelServer(
  env: NodeJS.ProcessEnv,
  readCommandLine: () => Promise<string | undefined>,
): Promise<string | undefined> {
  const name = channelServerFromEnv(env);
  if (!name) return undefined;
  try {
    const commandLine = await readCommandLine();
    return commandLine !== undefined && commandLineEnablesChannel(commandLine, name)
      ? name
      : undefined;
  } catch {
    return undefined;
  }
}
