import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordOf } from '../../src/core/json-record.js';
import { createClaudeRegistration } from '../../src/runtime/claude-registration.js';
import type { ProcessRunner } from '../../src/runtime/process-runner.js';

const clean: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of clean.splice(0)) await close();
});

/** `configDir: undefined` leaves the config dir unset (Claude's default); by default a temp `~/.claude` is set explicitly. */
async function fixture(initial?: unknown, dir: { configDir?: string | undefined } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'registration-')));
  clean.push(() => rm(home, { recursive: true, force: true }));
  const cliPath = join(home, 'cli.js');
  await writeFile(cliPath, '// fixture');
  const configDir = 'configDir' in dir ? dir.configDir : join(home, '.claude');
  // Claude reads $CLAUDE_CONFIG_DIR/.claude.json whenever the dir is set, else ~/.claude.json.
  const claudeJson = join(configDir ?? home, '.claude.json');
  if (configDir) await mkdir(configDir, { recursive: true });
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
  let time = 0;
  const registration = createClaudeRegistration({
    now: () => time,
    claude: async () => '/bin/claude',
    homeDir: home,
    configDir,
    nodePath: process.execPath,
    cliPath,
    runner,
  });
  const advance = (ms: number) => {
    time += ms;
  };
  return { home, configDir, cliPath, claudeJson, calls, envs, registration, node, advance };
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
        env: { ELECTRON_RUN_AS_NODE: '1', GLOSS_CHANNEL_SERVER: 'gloss' },
      }),
    ],
  ]);
  // The CLI must edit the same file Gloss reads.
  expect(f.envs[0]?.HOME).toBe(f.home);
  expect(f.envs[0]?.CLAUDE_CONFIG_DIR).toBe(f.configDir);
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

it('treats an own entry without the server-name env as stale so Update adds it', async () => {
  const node = await realpath(process.execPath);
  const f = await fixture();
  await writeFile(
    f.claudeJson,
    JSON.stringify({
      mcpServers: {
        gloss: {
          type: 'stdio',
          command: node,
          args: [f.cliPath, '--claude-channel'],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        },
      },
    }),
  );
  expect(await f.registration.status()).toEqual({ state: 'stale', found: node });
  expect(await f.registration.register()).toEqual({ state: 'registered' });
  expect(f.calls.map((c) => c[1])).toEqual(['remove', 'add-json']);
});

it('reads and edits ~/.claude.json only when no config dir is set', async () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  const f = await fixture(undefined, { configDir: undefined });
  expect(await f.registration.register()).toEqual({ state: 'registered' });
  expect(f.envs[0]?.CLAUDE_CONFIG_DIR).toBeUndefined();
  expect(
    Object.keys(recordOf(JSON.parse(await readFile(f.claudeJson, 'utf8')))?.mcpServers ?? {}),
  ).toEqual(['gloss']);
});

it('reads and edits $CLAUDE_CONFIG_DIR/.claude.json for a non-default config dir', async () => {
  const f = await fixture(undefined, {
    configDir: join(await realpath(tmpdir()), `registration-config-${process.pid}-${Date.now()}`),
  });
  clean.push(() => rm(f.configDir ?? '', { recursive: true, force: true }));
  expect(await f.registration.register()).toEqual({ state: 'registered' });
  expect(f.envs[0]?.CLAUDE_CONFIG_DIR).toBe(f.configDir);
  expect(f.claudeJson).toBe(join(f.configDir ?? '', '.claude.json'));
  expect(await f.registration.status()).toEqual({ state: 'registered' });
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

it('reuses a status briefly while .claude.json is unchanged, and re-reads after a change, a register or a remove', async () => {
  const f = await fixture({ mcpServers: { glosx: {} } });
  const fixedTime = 1_700_000_000; // seconds
  await utimes(f.claudeJson, fixedTime, fixedTime);
  expect(await f.registration.status()).toEqual({ state: 'unregistered' });
  // Same size and mtime: an unchanged file is not parsed again within the cache window.
  await writeFile(f.claudeJson, '{"mcpServers":{"gloss":{}}}');
  await utimes(f.claudeJson, fixedTime, fixedTime);
  expect(await f.registration.status()).toEqual({ state: 'unregistered' });
  f.advance(10_000);
  expect(await f.registration.status()).toMatchObject({ state: 'conflict' });
  // A changed file is read at once.
  await writeFile(f.claudeJson, '{"mcpServers":{}}');
  expect(await f.registration.status()).toEqual({ state: 'unregistered' });
  expect(await f.registration.register()).toEqual({ state: 'registered' });
  expect(await f.registration.status()).toEqual({ state: 'registered' });
  expect(await f.registration.remove()).toEqual({ state: 'unregistered' });
  expect(await f.registration.status()).toEqual({ state: 'unregistered' });
});
