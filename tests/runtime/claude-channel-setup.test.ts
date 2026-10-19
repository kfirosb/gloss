import { afterEach, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createApplication } from '../../src/runtime/application.js';
import { startServer } from '../../src/runtime/http-server.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import type { Target } from '../../src/core/contracts.js';
import { WorkspaceController } from '../../src/ui/use-workspace.js';
import { recordOf } from '../../src/core/json-record.js';
import { defaultWorkspace, WorkspaceConflict } from '../../src/core/session-contracts.js';
import type { RegistrationStatus } from '../../src/runtime/claude-registration.js';
const clean: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of clean.splice(0).reverse()) await close();
});
const native = '11111111-1111-4111-8111-111111111111';
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'channel-setup-')));
  clean.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project ' ;$(touch INJECTED) `echo bad` שלום");
  await mkdir(project);
  return {
    root,
    project,
    target: { agent: 'claude', sessionRef: native, projectId: project } as Target,
  };
}
async function service(registered = true, platform: NodeJS.Platform = 'darwin') {
  const f = await fixture();
  const { createClaudeChannelSetup } = await import('../../src/runtime/claude-channel-setup.js');
  let connected = false;
  let now = Date.now();
  const runner = vi.fn(async function* (_exe: string, args: string[]) {
    expect(args).toEqual([
      '--dangerously-load-development-channels',
      'server:language-assistant',
      '--version',
    ]);
    yield { type: 'line' as const, line: '2.1.293 (Claude Code)' };
    yield {
      type: 'exit' as const,
      outcome: { code: 0, signal: null, reason: 'exited' as const, diagnostics: '' },
    };
  });
  const registration = {
    status: async (): Promise<RegistrationStatus> =>
      registered ? { state: 'registered' } : { state: 'unregistered' },
  };
  const options = {
    stateDir: join(f.root, "app ' ;$(touch INJECTED)"),
    homeDir: f.root,
    configDir: join(f.root, '.claude'),
    managedDir: join(f.root, 'managed'),
    systemLibraryDir: join(f.root, 'system-library'),
    platform,
    cliPath: join(f.root, "cli ' ;$(touch INJECTED).js"),
    nodePath: process.execPath,
    claudePath: '/bin/echo',
    runner,
    now: () => now,
    registry: {
      resolveChannel: async (target: Target) =>
        connected && target.sessionRef === native ? { target } : undefined,
    },
    registration,
  };
  await writeFile(options.cliPath, '// fixture');
  await mkdir(options.configDir);
  const setup = createClaudeChannelSetup(options);
  return {
    ...f,
    setup,
    options,
    runner,
    connect: (v: boolean) => {
      connected = v;
    },
    advance: () => {
      now += 120_000;
    },
  };
}
it('authenticates both routes and rejects unknown IDs before setup', async () => {
  const { root, target } = await fixture();
  const setup = {
    status: vi.fn(async () => ({ state: 'setup-required' as const })),
    createChannelSetup: vi.fn(async () => ({
      kind: 'command' as const,
      command: 'safe',
      cdCommand: "cd '/p' && safe",
      folder: '/p',
    })),
  };
  const app = createApplication({
    store: new SqliteStore(':memory:'),
    agents: [],
    languageBackends: {},
    capability: 'cap',
    attachmentRoot: join(root, 'uploads'),
    channelSetup: setup,
  });
  clean.push(() => app.close());
  await app.sessions!.register(target, 'A');
  await app.sessions!.register(
    { ...target, sessionRef: '22222222-2222-4222-8222-222222222222' },
    'B',
  );
  const server = await startServer(app);
  clean.push(() => server.close());
  const request = (id: string, method = 'GET', auth = true, body?: unknown) =>
    fetch(new URL('/api/sessions/' + id + '/claude-channel', server.url), {
      method,
      headers: {
        ...(auth ? { authorization: 'Bearer cap' } : {}),
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  for (const method of ['GET', 'POST']) {
    expect((await request('A', method, false)).status).toBe(401);
    expect((await request('missing', method)).status).toBe(404);
  }
  expect(setup.createChannelSetup).not.toHaveBeenCalled();
  expect((await request('A')).status).toBe(200);
  expect(setup.status).toHaveBeenCalledWith(target);
  expect(setup.createChannelSetup).not.toHaveBeenCalled();
  expect(
    (
      await request('A', 'POST', true, {
        target: { ...target, projectId: '/foreign' },
        stateDir: '/foreign',
      })
    ).status,
  ).toBe(400);
  expect((await request('B', 'POST')).status).toBe(200);
  expect(setup.createChannelSetup).toHaveBeenCalledExactlyOnceWith({
    ...target,
    sessionRef: '22222222-2222-4222-8222-222222222222',
  });
});
it('keeps GET read-only and reports setup, connected, disconnected independently', async () => {
  const f = await service();
  expect(await f.setup.status(f.target)).toMatchObject({
    state: 'setup-required',
    reason: expect.stringContaining('Connect this session to Gloss'),
  });
  await f.setup.createChannelSetup(f.target);
  expect((await f.setup.status(f.target)).state).toBe('setup-required');
  await expect(stat(f.options.stateDir)).rejects.toMatchObject({ code: 'ENOENT' });
  f.connect(true);
  expect((await f.setup.status(f.target)).state).toBe('connected');
  f.connect(false);
  expect((await f.setup.status(f.target)).state).toBe('disconnected');
  const g = await service(false);
  expect(await g.setup.status(g.target)).toMatchObject({
    state: 'setup-required',
    reason: expect.stringContaining('Register Gloss'),
  });
});
it('reports a session with a per-session file from an older build as connecting, then disconnected', async () => {
  const f = await service();
  // Older builds wrote one 0600 file per session; repairConfigs() keeps their mtime fresh.
  const setupDir = join(f.options.stateDir, 'claude-channel-setup');
  await mkdir(setupDir, { recursive: true, mode: 0o700 });
  const name =
    createHash('sha256')
      .update(JSON.stringify([f.target.projectId, f.target.sessionRef]))
      .digest('hex') + '.json';
  await writeFile(join(setupDir, name), '{}', { mode: 0o600 });
  expect(await f.setup.status(f.target)).toMatchObject({ state: 'connecting' });
  f.advance();
  expect(await f.setup.status(f.target)).toMatchObject({ state: 'disconnected' });
});
it('uses the Claude executable lookup the host shares with registration', async () => {
  const f = await service();
  const { createClaudeChannelSetup } = await import('../../src/runtime/claude-channel-setup.js');
  const claude = vi.fn(async () => '/shared/claude');
  const setup = createClaudeChannelSetup({ ...f.options, claude });
  expect((await setup.prepareNewSessionConfig(f.project)).claude).toBe('/shared/claude');
  expect(claude).toHaveBeenCalledOnce();
  expect(f.runner).not.toHaveBeenCalled();
});
it('gives a registered user the short exact-id command and writes no file', async () => {
  const f = await service();
  const before = await readdir(f.root);
  const result = await f.setup.createChannelSetup(f.target);
  if (result.kind !== 'command') throw new Error('expected a command, got ' + result.kind);
  expect(result.folder).toBe(f.project);
  expect(result.command).toBe(
    `claude --resume ${native} --dangerously-load-development-channels server:gloss`,
  );
  // The cd prefix survives the hostile folder name: run it with a stub `claude` that prints its cwd and argv.
  const args = JSON.parse(
    execFileSync(
      '/bin/sh',
      [
        '-c',
        'claude() { "$CHANNEL_TEST_NODE"' +
          ' -e \'console.log(JSON.stringify([process.cwd(), ...process.argv.slice(1)]))\' -- "$@"; }; ' +
          result.cdCommand,
      ],
      { encoding: 'utf8', env: { ...process.env, CHANNEL_TEST_NODE: process.execPath } },
    ),
  );
  expect(args).toEqual([
    f.project,
    '--resume',
    native,
    '--dangerously-load-development-channels',
    'server:gloss',
  ]);
  expect((await readdir(f.root)).sort()).toEqual(before.sort());
  expect(await readdir(f.project)).toEqual([]);
});
it('asks an unregistered user to register before showing a command', async () => {
  const f = await service(false);
  expect(await f.setup.createChannelSetup(f.target)).toEqual({
    kind: 'registration-required',
    registration: { state: 'unregistered' },
  });
});
it('generates a private new-session config and shell arguments without execution or global writes', async () => {
  const f = await service();
  const before = await readdir(f.root);
  const result = await f.setup.newSessionSetup(f.project);
  expect(result.experimental).toBe(true);
  // Replace only the executable with a shell function that prints argv; never launch Claude.
  const command = result.command.replace("'/bin/echo'", 'capture');
  const args: unknown = JSON.parse(
    execFileSync(
      '/bin/sh',
      [
        '-c',
        'capture() { "$CHANNEL_TEST_NODE"' +
          ' -e \'console.log(JSON.stringify(process.argv.slice(1)))\' -- "$@"; }; ' +
          command,
      ],
      { encoding: 'utf8', env: { ...process.env, CHANNEL_TEST_NODE: process.execPath } },
    ),
  );
  if (!Array.isArray(args)) throw new Error('expected argv');
  expect(args[0]).toBe('Reply with READY only. Do not use tools.');
  expect(args.slice(3)).toEqual([
    '--dangerously-load-development-channels',
    'server:language-assistant',
  ]);
  const path = args[2];
  if (typeof path !== 'string') throw new Error('expected a config path');
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
    mcpServers: {
      'language-assistant': {
        command: await realpath(process.execPath),
        args: [f.options.cliPath, '--claude-channel'],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    },
  });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(f.options.stateDir, 'claude-channel-setup'))).mode & 0o777).toBe(0o700);
  expect((await readdir(f.root)).sort()).toEqual([...before, "app ' ;$(touch INJECTED)"].sort());
  expect(await readdir(f.project)).toEqual([]);
  expect(result.command).not.toMatch(/strict-mcp|setting-sources|--resume/);
});
it('discloses one model request only for explicitly requested new-session setup', async () => {
  const f = await service();
  await expect(f.setup.newSessionSetup('relative/project')).rejects.toThrow(
    /absolute project path/i,
  );
  const result = await f.setup.newSessionSetup(f.project);
  expect(result.command).not.toContain('--resume');
  expect(result.command).toContain('Reply with READY only. Do not use tools.');
  // Variadic options must not swallow the prompt, so it directly follows the executable.
  expect(result.command).toMatch(
    /&& '[^']*' 'Reply with READY only\. Do not use tools\.' '--mcp-config'/,
  );
  expect(result.instructions).toMatch(/one model request/i);
});
it('rejects malformed identities before allocating files and rejects unsafe setup directories', async () => {
  const f = await service();
  await expect(
    f.setup.createChannelSetup({ ...f.target, sessionRef: 'bad; echo secret' }),
  ).rejects.toThrow(/identity/i);
  await expect(stat(f.options.stateDir)).rejects.toMatchObject({ code: 'ENOENT' });
  await mkdir(f.options.stateDir, { mode: 0o700 });
  await symlink(f.project, join(f.options.stateDir, 'claude-channel-setup'));
  await expect(f.setup.newSessionSetup(f.project)).rejects.toThrow(/private|unsafe/i);
  expect(await readdir(f.project)).toEqual([]);
});
it.each(['user', 'local', 'project', 'managed'])(
  'rejects %s name conflicts without changing config or exposing secrets',
  async (scope) => {
    const f = await service();
    const entry = { 'language-assistant': { env: { SECRET: 'DO_NOT_PRINT' } } };
    const path =
      scope === 'project'
        ? join(f.project, '.mcp.json')
        : scope === 'managed'
          ? join(f.options.managedDir, 'managed-mcp.json')
          : // The config dir is set (to ~/.claude), so Claude's user file is inside it.
            join(f.options.configDir, '.claude.json');
    if (scope === 'managed') await mkdir(f.options.managedDir);
    const content = JSON.stringify(
      scope === 'local'
        ? { projects: { [f.project]: { mcpServers: entry } } }
        : { mcpServers: entry },
    );
    await writeFile(path, content);
    const status = await f.setup.status(f.target);
    expect(status.state).toBe('unsupported');
    expect(status.reason).not.toContain('DO_NOT_PRINT');
    await expect(f.setup.createChannelSetup(f.target)).rejects.toThrow(/conflict|managed/i);
    expect(await readFile(path, 'utf8')).toBe(content);
    await expect(stat(f.options.stateDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.runner).not.toHaveBeenCalled();
  },
);

it('reconciles atomic release revisions while retaining edits made during release and after reload', async () => {
  let saved = {
    sessionId: 'A',
    revision: 0,
    data: {
      ...defaultWorkspace(),
      composer: 'original',
      composerAttempt: { requestId: 'old', text: 'original', attachmentIds: [] as string[] } as any,
    },
  };
  const storage = new Map<string, string>();
  const local = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  };
  const transport = {
    loadWorkspace: async () => structuredClone(saved),
    saveWorkspace: async (revision: number, data: any) => {
      if (revision !== saved.revision) throw new WorkspaceConflict(structuredClone(saved));
      saved = { sessionId: 'A', revision: revision + 1, data: structuredClone(data) };
      return structuredClone(saved);
    },
  };
  const snapshot = {
    id: 'A',
    codingState: 'idle' as const,
    codingMessages: [],
    discussion: [],
    deliveries: [],
    language: 'he',
    languageSessionId: '',
    languageModel: '',
    sourceRevision: 0,
  };
  const workspace = new WorkspaceController('A', transport, local, 'release');
  await workspace.hydrate(snapshot, 'A');
  let finish!: () => void;
  const pending = workspace.releaseComposer('old', async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    saved = {
      ...saved,
      revision: saved.revision + 1,
      data: { ...saved.data, composerAttempt: null },
    };
  });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  workspace.update((data) => {
    data.composer = 'עריכה בזמן שחרור';
    data.attachmentIds = ['new-reference'];
  });
  finish();
  await pending;
  await workspace.flush();
  expect(workspace.conflict).toBeNull();
  expect(saved.data.composerAttempt).toBeNull();
  expect(saved.data).toMatchObject({
    composer: 'עריכה בזמן שחרור',
    attachmentIds: ['new-reference'],
  });
  const reload = new WorkspaceController('A', transport, local, 'release');
  await reload.hydrate(snapshot, 'A');
  expect(reload.record.data.composerAttempt).toBeNull();
  expect(reload.record.data.composer).toBe('עריכה בזמן שחרור');
});

it('never restores a released attempt from unsaved recovery even when other remote edits conflict', async () => {
  const old = { requestId: 'old', text: 'earlier', attachmentIds: [] };
  const record = {
    sessionId: 'A',
    revision: 1,
    data: { ...defaultWorkspace(), composer: 'local edit', composerAttempt: old },
  };
  const saved = {
    sessionId: 'A',
    revision: 3,
    data: { ...defaultWorkspace(), composer: 'remote edit' },
  };
  const values = new Map([
    [
      'workspace:stale:A',
      JSON.stringify({ record, unsaved: true, migrated: true, recoveredReview: null }),
    ],
  ]);
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
  };
  const client = {
    loadWorkspace: async () => saved,
    saveWorkspace: async (revision: number, data: any) => ({
      ...saved,
      revision: revision + 1,
      data,
    }),
  };
  const workspace = new WorkspaceController('A', client, storage, 'stale');
  await workspace.hydrate(
    {
      id: 'A',
      codingState: 'idle',
      codingMessages: [],
      discussion: [],
      deliveries: [
        {
          id: 'r',
          draftId: 'composer-old',
          revision: 1,
          target: { agent: 'claude', sessionRef: native, projectId: '/project' },
          state: 'unconfirmed',
          englishText: 'earlier',
        },
      ],
      language: 'he',
      languageSessionId: '',
      languageModel: '',
      sourceRevision: 0,
    },
    'A',
  );
  expect(workspace.record.data.composerAttempt).toBeNull();
  expect(workspace.record.data.composer).toBe('local edit');
  expect(workspace.conflict).not.toBeNull();
  await workspace.resolveKeepLocal();
  expect(workspace.record.data.composerAttempt).toBeNull();
});

it('rejects unsupported capability without setup writes and accepts future CLI versions', async () => {
  const f = await service();
  const { createClaudeChannelSetup } = await import('../../src/runtime/claude-channel-setup.js');
  const bad = createClaudeChannelSetup({
    ...f.options,
    runner: async function* () {
      yield {
        type: 'exit',
        outcome: { code: 1, signal: null, reason: 'exited', diagnostics: 'secret diagnostic' },
      };
    },
  });
  expect(await bad.status(f.target)).toMatchObject({ state: 'unsupported' });
  await expect(bad.createChannelSetup(f.target)).rejects.toThrow(/capability probe/);
  await expect(stat(f.options.stateDir)).rejects.toMatchObject({ code: 'ENOENT' });
  const future = createClaudeChannelSetup({
    ...f.options,
    runner: async function* () {
      yield { type: 'line', line: '9.0.1 (Claude Code)' };
      yield { type: 'exit', outcome: { code: 0, signal: null, reason: 'exited', diagnostics: '' } };
    },
  });
  expect((await future.status(f.target)).state).toBe('setup-required');
});

it('distinguishes equal project names and refuses malformed config without exposing its content', async () => {
  const f = await service();
  const parent = join(f.root, 'other');
  await mkdir(parent);
  const project = join(parent, f.project.split('/').at(-1)!);
  await mkdir(project);
  const first = await f.setup.createChannelSetup(f.target);
  const second = await f.setup.createChannelSetup({ ...f.target, projectId: project });
  if (first.kind !== 'command' || second.kind !== 'command') throw new Error('expected commands');
  expect(first.cdCommand).not.toBe(second.cdCommand);
  await writeFile(join(f.options.configDir, '.claude.json'), '{SECRET_DO_NOT_PRINT');
  const status = await f.setup.status(f.target);
  expect(status.state).toBe('unsupported');
  expect(status.reason).not.toContain('SECRET_DO_NOT_PRINT');
});

it('uses the native install instead of a terminal-host wrapper in PATH', async () => {
  const f = await service();
  const bin = join(f.root, '.local', 'bin');
  await mkdir(bin, { recursive: true });
  await symlink('/bin/echo', join(bin, 'claude'));
  const wrapper = join(f.root, '.superset', 'bin');
  await mkdir(wrapper, { recursive: true });
  await writeFile(join(wrapper, 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  vi.stubEnv('PATH', wrapper);
  const { createClaudeChannelSetup } = await import('../../src/runtime/claude-channel-setup.js');
  const { claudePath: _omit, ...options } = f.options;
  const setup = createClaudeChannelSetup(options);
  const result = await setup.newSessionSetup(f.project);
  expect(result.command).toContain("'/bin/echo'");
  expect(result.command).not.toContain('.superset');
});

it('reports managed policy fragments as unsupported without executing policy helpers', async () => {
  const f = await service();
  await mkdir(join(f.options.managedDir, 'managed-settings.d'), { recursive: true });
  await writeFile(
    join(f.options.managedDir, 'managed-settings.d', '20-mcp.json'),
    JSON.stringify({ managedMcpServers: { 'language-assistant': { command: 'never execute' } } }),
  );
  expect((await f.setup.status(f.target)).state).toBe('unsupported');
  await expect(f.setup.createChannelSetup(f.target)).rejects.toThrow(/managed/i);
  expect(f.runner).not.toHaveBeenCalled();
});

it('requires administrator review for an OS managed preference document without reading secrets', async () => {
  const f = await service();
  const library = join(f.root, 'system-library');
  await mkdir(join(library, 'Managed Preferences'), { recursive: true });
  await writeFile(
    join(library, 'Managed Preferences', 'com.anthropic.claudecode.plist'),
    'DO_NOT_PRINT',
  );
  const { createClaudeChannelSetup } = await import('../../src/runtime/claude-channel-setup.js');
  const setup = createClaudeChannelSetup({ ...f.options, systemLibraryDir: library });
  const status = await setup.status(f.target);
  expect(status.state).toBe('unsupported');
  expect(status.reason).not.toContain('DO_NOT_PRINT');
  expect(f.runner).not.toHaveBeenCalled();
});
it('points saved setup configs from a renamed or older app at this build and leaves foreign files alone', async () => {
  const f = await service();
  const setupDir = join(f.options.stateDir, 'claude-channel-setup');
  expect(await f.setup.repairConfigs()).toEqual({ repaired: 0 });
  await expect(stat(setupDir)).rejects.toMatchObject({ code: 'ENOENT' });
  await f.setup.prepareNewSessionConfig(f.project);
  const [current] = await readdir(setupDir);
  const fresh = await readFile(join(setupDir, current!), 'utf8');
  const stale = (name: string, content: unknown, mode = 0o600) =>
    writeFile(
      join(setupDir, name),
      typeof content === 'string' ? content : JSON.stringify(content),
      { mode },
    );
  const old = {
    mcpServers: {
      'language-assistant': {
        command: '/Applications/Language Assistant.app/Contents/MacOS/Language Assistant',
        args: [
          '/Applications/Language Assistant.app/Contents/Resources/app/dist/server/runtime/cli.js',
          '--claude-channel',
        ],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    },
  };
  await stale('a'.repeat(64) + '.json', old);
  const foreign = {
    mcpServers: {
      'language-assistant': old.mcpServers['language-assistant'],
      other: { command: '/bin/sh', args: [] },
    },
  };
  await stale('b'.repeat(64) + '.json', foreign);
  await stale('c'.repeat(64) + '.json', '{not json');
  await stale('d'.repeat(64) + '.json', old, 0o644);
  await stale('notes.json', old);
  expect(await f.setup.repairConfigs()).toEqual({ repaired: 1 });
  expect(await readFile(join(setupDir, 'a'.repeat(64) + '.json'), 'utf8')).toBe(fresh);
  expect((await stat(join(setupDir, 'a'.repeat(64) + '.json'))).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(join(setupDir, 'b'.repeat(64) + '.json'), 'utf8'))).toEqual(
    foreign,
  );
  expect(await readFile(join(setupDir, 'c'.repeat(64) + '.json'), 'utf8')).toBe('{not json');
  expect(JSON.parse(await readFile(join(setupDir, 'd'.repeat(64) + '.json'), 'utf8'))).toEqual(old);
  expect(JSON.parse(await readFile(join(setupDir, 'notes.json'), 'utf8'))).toEqual(old);
  expect(await readFile(join(setupDir, current!), 'utf8')).toBe(fresh);
  expect((await readdir(setupDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  expect(await f.setup.repairConfigs()).toEqual({ repaired: 0 });
  expect(f.runner).toHaveBeenCalledTimes(1);
});
it('keeps the legacy language-assistant key in repaired files even when gloss is registered at user scope', async () => {
  const f = await service();
  const gloss = {
    command: process.execPath,
    args: [f.options.cliPath, '--claude-channel'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
  await writeFile(
    join(f.options.configDir, '.claude.json'),
    JSON.stringify({ mcpServers: { gloss } }),
  );
  const setupDir = join(f.options.stateDir, 'claude-channel-setup');
  await f.setup.prepareNewSessionConfig(f.project);
  const name = 'e'.repeat(64) + '.json';
  const old = {
    mcpServers: {
      'language-assistant': {
        command: '/Applications/Old.app/Contents/MacOS/Old',
        args: ['/Applications/Old.app/cli.js', '--claude-channel'],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    },
  };
  await writeFile(join(setupDir, name), JSON.stringify(old), { mode: 0o600 });
  expect(await f.setup.repairConfigs()).toEqual({ repaired: 1 });
  const repaired = recordOf(JSON.parse(await readFile(join(setupDir, name), 'utf8')));
  const servers = recordOf(repaired?.mcpServers);
  expect(Object.keys(servers ?? {})).toEqual(['language-assistant']);
  expect(recordOf(servers?.['language-assistant'])?.command).toBe(await realpath(process.execPath));
});

it('prepares channel setup on Linux', async () => {
  const f = await service(true, 'linux');
  expect(await f.setup.createChannelSetup(f.target)).toMatchObject({ kind: 'command' });
});
