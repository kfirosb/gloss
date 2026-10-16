import { describe, expect, it } from 'vitest';
import {
  channelServerFromEnv,
  commandLineEnablesChannel,
  enabledChannelServer,
  readParentCommandLine,
} from '../../src/agents/claude/channel-activation.js';
import type { ProcessEvent, ProcessRunner } from '../../src/runtime/process-runner.js';

const claude = '/Users/me/.local/share/claude/versions/2.1.301';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const flag = '--dangerously-load-development-channels';

describe('which channel the parent Claude enabled', () => {
  it.each([
    ['enabled gloss', `${claude} --resume ${id} ${flag} server:gloss`, 'gloss', true],
    [
      'enabled language-assistant',
      `${claude} --resume ${id} --mcp-config /x.json ${flag} server:language-assistant`,
      'language-assistant',
      true,
    ],
    [
      'language-assistant asking for gloss',
      `${claude} ${flag} server:language-assistant`,
      'gloss',
      false,
    ],
    [
      'gloss asking for language-assistant',
      `${claude} ${flag} server:gloss`,
      'language-assistant',
      false,
    ],
    [
      'flags for another server only',
      `${claude} ${flag} server:other ${flag} server:else`,
      'gloss',
      false,
    ],
    ['flag absent', `${claude} --session-id ${id}`, 'gloss', false],
    ['plain resume', `claude --resume ${id}`, 'gloss', false],
    ['= form', `${claude} ${flag}=server:gloss --resume ${id}`, 'gloss', true],
    ['comma list', `${claude} ${flag} server:other,server:gloss`, 'gloss', true],
    ['= comma list', `${claude} ${flag}=server:other,server:gloss`, 'gloss', true],
    ['space list', `${claude} ${flag} server:other server:gloss --resume ${id}`, 'gloss', true],
    ['repeated flag', `${claude} ${flag} server:other ${flag} server:gloss`, 'gloss', true],
    ['value ends at the next option', `${claude} ${flag} --resume server:gloss`, 'gloss', false],
    ['prefix only', `${claude} ${flag} server:glossy`, 'gloss', false],
    [
      'prompt text after --',
      `${claude} --session-id ${id} -- ${flag} server:gloss`,
      'gloss',
      false,
    ],
  ])('%s', (_name, commandLine, name, expected) => {
    expect(commandLineEnablesChannel(commandLine, name)).toBe(expected);
  });

  it('reads the server name from the registration env, defaulting to the legacy name', () => {
    expect(channelServerFromEnv({})).toBe('language-assistant');
    expect(channelServerFromEnv({ GLOSS_CHANNEL_SERVER: 'gloss' })).toBe('gloss');
    expect(channelServerFromEnv({ GLOSS_CHANNEL_SERVER: 'language-assistant' })).toBe(
      'language-assistant',
    );
    expect(channelServerFromEnv({ GLOSS_CHANNEL_SERVER: 'other' })).toBeUndefined();
    expect(channelServerFromEnv({ GLOSS_CHANNEL_SERVER: '' })).toBeUndefined();
  });

  it('fails closed on an unknown name, an unreadable command line, or a reader error', async () => {
    const line = async () => `${claude} ${flag} server:gloss`;
    expect(await enabledChannelServer({ GLOSS_CHANNEL_SERVER: 'gloss' }, line)).toBe('gloss');
    expect(await enabledChannelServer({ GLOSS_CHANNEL_SERVER: 'nope' }, line)).toBeUndefined();
    expect(await enabledChannelServer({}, line)).toBeUndefined();
    expect(
      await enabledChannelServer({ GLOSS_CHANNEL_SERVER: 'gloss' }, async () => undefined),
    ).toBeUndefined();
    expect(
      await enabledChannelServer({ GLOSS_CHANNEL_SERVER: 'gloss' }, async () => {
        throw new Error('ps failed');
      }),
    ).toBeUndefined();
  });

  it('reads the parent command line with a bounded, shell-free ps call', async () => {
    const calls: { executable: string; args: string[]; timeoutMs: number | undefined }[] = [];
    const runner = (lines: string[], code = 0): ProcessRunner =>
      async function* (executable, args, _input, _signal, options): AsyncGenerator<ProcessEvent> {
        calls.push({ executable, args, timeoutMs: options?.timeoutMs });
        for (const line of lines) yield { type: 'line', line };
        yield {
          type: 'exit',
          outcome: { code, signal: null, reason: 'exited', diagnostics: '' },
        };
      };
    expect(await readParentCommandLine(runner([`${claude} ${flag} server:gloss`]), 4242)).toBe(
      `${claude} ${flag} server:gloss`,
    );
    expect(calls[0]).toEqual({
      executable: '/bin/ps',
      args: ['-ww', '-o', 'args=', '-p', '4242'],
      timeoutMs: expect.any(Number),
    });
    expect(await readParentCommandLine(runner([], 1), 4242)).toBeUndefined();
    expect(await readParentCommandLine(runner(['x']), 1)).toBeUndefined();
  });
});
