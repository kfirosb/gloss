import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  send: undefined as undefined | ((message: any) => Promise<void>),
  delivered: vi.fn(),
  register: vi.fn(),
  prepare: vi.fn(async () => ({
    command: 'quoted command',
    experimental: true,
    instructions: 'This makes one model request when run.',
  })),
  migration: vi.fn(async (): Promise<{ kind: string }> => ({ kind: 'already-new' })),
  opened: vi.fn(),
}));
// Never run the real migration from a test: it would act on the real home folder.
vi.mock('../../src/runtime/data-migration.js', () => ({
  migrateDataDir: state.migration,
  stateDbInUse: async () => false,
}));
vi.mock('../../src/runtime/claude-channel-setup.js', () => ({
  createNewSessionSetup: state.prepare,
}));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn() }));
vi.mock('../../src/storage/sqlite-store.js', () => ({
  SqliteStore: class {
    constructor(path: string) {
      state.opened(path);
    }
  },
}));
vi.mock('../../src/agents/claude/index.js', () => ({ createClaudeAdapter: () => ({}) }));
vi.mock('../../src/agents/codex/index.js', () => ({
  createCodexAdapter: (options: any) => {
    state.send = options.sourceSink.send;
    return {};
  },
}));
vi.mock('../../src/agents/source-sink.js', () => ({
  createHttpSourceSink: () => ({ send: state.delivered }),
}));
vi.mock('../../src/runtime/launch-services.js', () => ({
  createLaunchServices: () => ({ launcher: {}, terminals: {}, attention: {} }),
}));
vi.mock('../../src/runtime/http-server.js', () => ({
  startServer: async () => ({ url: 'http://127.0.0.1:1234/#capability=cap' }),
}));
vi.mock('../../src/runtime/application.js', () => ({
  createApplication: () => ({
    capability: 'cap',
    snapshot: () => ({ snapshot: { id: 'launch' } }),
    sessions: { register: state.register },
    restore: async () => {
      await state.send!({ agent: 'codex', sourceSessionId: 'native' });
    },
  }),
}));
import { launch } from '../../src/runtime/cli.js';
it('prepares a new-session command and exits without panel or session startup', async () => {
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  state.register.mockClear();
  state.delivered.mockClear();
  try {
    await launch(['--prepare-claude-channel', '--project', '/tmp/exact project']);
    expect(state.prepare).toHaveBeenCalledWith('/tmp/exact project');
    expect(output).toHaveBeenCalledWith(expect.stringContaining('one model request'));
    expect(output).toHaveBeenCalledWith(expect.stringContaining('quoted command'));
    expect(state.register).not.toHaveBeenCalled();
    expect(state.delivered).not.toHaveBeenCalled();
    await expect(launch(['--prepare-claude-channel'])).rejects.toThrow(/--project/);
    await expect(
      launch(['--prepare-claude-channel', '--project', '/tmp/p', '--session', 'native']),
    ).rejects.toThrow(/saved session UI/);
  } finally {
    output.mockRestore();
  }
});
it('installs the local source sink before registered adapters replay', async () => {
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    await launch(['--agent', 'codex', '--session', 'native']);
    expect(state.register).toHaveBeenCalledWith(
      { agent: 'codex', sessionRef: 'native', projectId: process.cwd() },
      'launch',
    );
    expect(state.delivered).toHaveBeenCalledWith({ agent: 'codex', sourceSessionId: 'native' });
  } finally {
    output.mockRestore();
  }
});
it('migrates the data folder before opening the database, and stops while it is in use', async () => {
  state.migration.mockClear();
  state.opened.mockClear();
  state.migration.mockResolvedValueOnce({ kind: 'in-use' });
  await expect(launch(['--agent', 'codex', '--session', 'native'])).rejects.toThrow(
    /Another copy of Gloss is still running/,
  );
  expect(state.migration).toHaveBeenCalledWith(
    expect.objectContaining({ home: expect.any(String) }),
  );
  expect(state.opened).not.toHaveBeenCalled();
});
