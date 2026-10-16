import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordOf } from '../../src/core/json-record.js';
import { createClaudeRegistration } from '../../src/runtime/claude-registration.js';
import type { ProcessRunner } from '../../src/runtime/process-runner.js';

const clean: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of clean.splice(0)) await close();
});

async function fixture(initial?: unknown) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'registration-')));
  clean.push(() => rm(home, { recursive: true, force: true }));
  const cliPath = join(home, 'cli.js');
  await writeFile(cliPath, '// fixture');
  const claudeJson = join(home, '.claude.json');
  if (initial !== undefined) await writeFile(claudeJson, JSON.stringify(initial));
  const calls: string[][] = [];
  const envs: (NodeJS.ProcessEnv | undefined)[] = [];
  // Fake `claude mcp`: applies add-json/remove to ~/.claude.json the way the real CLI does.
  const runner: ProcessRunner = async function* (_exe, args, _input, _signal, options) {
    calls.push(args);
    envs.push(options?.env);
    const current =
      recordOf(JSON.parse(await readFile(claudeJson, 'utf8').catch(() => '{}'))) ?? {};
    const servers = { ...recordOf(current.mcpServers) };
    const [, command, , , name, json] = args;
    if (command === 'add-json' && name && json) servers[name] = JSON.parse(json);
    if (command === 'remove' && name) delete servers[name];
    await writeFile(claudeJson, JSON.stringify({ ...current, mcpServers: servers }));
    yield { type: 'exit', outcome: { code: 0, signal: null, reason: 'exited', diagnostics: '' } };
  };
  const node = await realpath(process.execPath); // registration compares canonical paths
  const registration = createClaudeRegistration({
    claude: async () => '/bin/claude',
    homeDir: home,
    configDir: join(home, '.claude'),
    nodePath: process.execPath,
    cliPath,
    runner,
  });
  return { home, cliPath, claudeJson, calls, envs, registration, node };
}

it('registers gloss once at user scope and reports it registered', async () => {
  const f = await fixture();
  expect(await f.registration.status()).toEqual({ state: 'unregistered' });
  expect(await f.registration.register()).toEqual({ state: 'registered' });
  expect(f.calls).toEqual([
    [
      'mcp',
      'add-json',
      '--scope',
      'user',
      'gloss',
      JSON.stringify({
        type: 'stdio',
        command: f.node,
        args: [f.cliPath, '--claude-channel'],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      }),
    ],
  ]);
  // The CLI must edit the same file Gloss reads.
  expect(f.envs[0]?.HOME).toBe(f.home);
  expect(f.envs[0]?.CLAUDE_CONFIG_DIR).toBeUndefined();
  expect(await f.registration.register()).toEqual({ state: 'registered' });
  expect(f.calls).toHaveLength(1);
});

it('replaces a stale entry left by a moved app instead of failing on a duplicate name', async () => {
  const f = await fixture({
    mcpServers: {
      gloss: {
        command: '/Users/x/Downloads/Gloss.app/Contents/MacOS/Gloss',
        args: ['/Users/x/Downloads/Gloss.app/cli.js', '--claude-channel'],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    },
  });
  expect(await f.registration.status()).toEqual({
    state: 'stale',
    found: '/Users/x/Downloads/Gloss.app/Contents/MacOS/Gloss',
  });
  expect(await f.registration.register()).toEqual({ state: 'registered' });
  expect(f.calls.map((c) => c[1])).toEqual(['remove', 'add-json']);
});

it('reports a foreign gloss entry as a conflict and never removes or overwrites it', async () => {
  const foreign = {
    mcpServers: { gloss: { command: '/usr/local/bin/gloss-docs', args: ['serve'] } },
  };
  const f = await fixture(foreign);
  expect(await f.registration.status()).toEqual({
    state: 'conflict',
    found: '/usr/local/bin/gloss-docs',
  });
  await expect(f.registration.register()).rejects.toThrow(/already used by another server/);
  await expect(f.registration.remove()).rejects.toThrow(/not Gloss/);
  expect(f.calls).toEqual([]);
  expect(JSON.parse(await readFile(f.claudeJson, 'utf8'))).toEqual(foreign);
});

it('describes a foreign entry by command path or URL origin only, never by its secrets', async () => {
  const cases = [
    [
      {
        command: '/usr/local/bin/tool',
        args: ['--token', 'DO_NOT_PRINT'],
        env: { SECRET: 'DO_NOT_PRINT' },
      },
      '/usr/local/bin/tool',
    ],
    [
      {
        type: 'http',
        url: 'https://user:DO_NOT_PRINT@api.example.com/mcp?key=DO_NOT_PRINT',
        headers: { Authorization: 'Bearer DO_NOT_PRINT' },
      },
      'https://api.example.com',
    ],
    ['DO_NOT_PRINT', 'an entry Gloss cannot describe'],
  ] as const;
  for (const [entry, found] of cases) {
    const f = await fixture({ mcpServers: { gloss: entry } });
    const status = await f.registration.status();
    expect(status).toEqual({ state: 'conflict', found });
    const error = await f.registration.register().catch((e: unknown) => e);
    expect(JSON.stringify(status) + String(error)).not.toContain('DO_NOT_PRINT');
  }
});

it('removes only its own entry', async () => {
  const f = await fixture();
  await f.registration.register();
  expect(await f.registration.remove()).toEqual({ state: 'unregistered' });
  expect(f.calls.at(-1)).toEqual(['mcp', 'remove', '--scope', 'user', 'gloss']);
  expect(await f.registration.remove()).toEqual({ state: 'unregistered' });
  expect(f.calls).toHaveLength(2);
});

it('reports an unreadable ~/.claude.json as unavailable without echoing it or running claude', async () => {
  const f = await fixture();
  await writeFile(f.claudeJson, '{SECRET_DO_NOT_PRINT');
  const status = await f.registration.status();
  expect(status).toMatchObject({ state: 'unavailable' });
  expect(JSON.stringify(status)).not.toContain('SECRET_DO_NOT_PRINT');
  await expect(f.registration.register()).rejects.toThrow();
  expect(f.calls).toEqual([]);
});
