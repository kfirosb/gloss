import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessRunner } from '../../src/runtime/process-runner.js';
import {
  channelServerPaths,
  createClaudeExecutable,
  readClaudeConfigFile,
} from '../../src/runtime/claude-config.js';

const clean: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of clean.splice(0)) await close();
});
async function folder() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-config-')));
  clean.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

it('reads Claude JSON fail-closed without echoing its content', async () => {
  const root = await folder();
  expect(await readClaudeConfigFile(join(root, 'missing.json'))).toBeUndefined();
  await writeFile(join(root, 'ok.json'), '{"a":1}');
  expect(await readClaudeConfigFile(join(root, 'ok.json'))).toEqual({ a: 1 });
  for (const [name, content] of [
    ['secret.json', '{SECRET_DO_NOT_PRINT'],
    ['array.json', '[]'],
  ] as const) {
    await writeFile(join(root, name), content);
    const error = await readClaudeConfigFile(join(root, name)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('SECRET_DO_NOT_PRINT');
  }
  await symlink(join(root, 'ok.json'), join(root, 'link.json'));
  await expect(readClaudeConfigFile(join(root, 'link.json'))).rejects.toThrow();
});

it('resolves the bridge paths canonically and rejects Claude interpolation', async () => {
  const root = await folder();
  const cli = join(root, 'cli.js');
  await writeFile(cli, '// fixture');
  expect(await channelServerPaths(process.execPath, cli)).toEqual({
    node: await realpath(process.execPath),
    cli,
  });
  const odd = join(root, '${HOME}');
  await mkdir(odd);
  await writeFile(join(odd, 'cli.js'), '// fixture');
  await expect(channelServerPaths(process.execPath, join(odd, 'cli.js'))).rejects.toThrow(
    /interpolation/,
  );
});

it('probes the installed Claude once per minute with the legacy server name', async () => {
  let now = 0;
  const calls: string[][] = [];
  const runner: ProcessRunner = async function* (_exe, args) {
    calls.push(args);
    yield { type: 'line', line: '2.1.301 (Claude Code)' };
    yield { type: 'exit', outcome: { code: 0, signal: null, reason: 'exited', diagnostics: '' } };
  };
  const claude = createClaudeExecutable({ claudePath: '/bin/echo', runner, now: () => now });
  expect(await claude()).toBe('/bin/echo');
  expect(await claude()).toBe('/bin/echo');
  expect(calls).toEqual([
    ['--dangerously-load-development-channels', 'server:language-assistant', '--version'],
  ]);
  now += 60_001;
  await claude();
  expect(calls).toHaveLength(2);
});
