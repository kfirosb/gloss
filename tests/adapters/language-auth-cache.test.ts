import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessRunner } from '../../src/runtime/process-runner';
import { ClaudeLanguageBackend } from '../../src/language/claude';
import { CodexLanguageBackend } from '../../src/language/codex';
import {
  SUBSCRIPTION_FAILURE_TTL_MS,
  SUBSCRIPTION_SUCCESS_TTL_MS,
} from '../../src/language/shared';

/** A fake `claude auth status --json` whose login state and release the test controls. */
function fakeAuth() {
  const state = { loggedIn: false, runs: 0, gate: Promise.resolve() };
  const runner: ProcessRunner = async function* (_exe, args) {
    if (!args.includes('auth')) throw new Error(`unexpected worker run: ${args.join(' ')}`);
    state.runs++;
    await state.gate;
    yield {
      type: 'line',
      line: JSON.stringify({
        loggedIn: state.loggedIn,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
      }),
    };
    yield {
      type: 'exit',
      outcome: { code: state.loggedIn ? 0 : 1, signal: null, reason: 'exited', diagnostics: '' },
    };
  };
  return { state, runner };
}

describe('subscription check cache', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shares one in-flight check between concurrent opens', async () => {
    const { state, runner } = fakeAuth();
    state.loggedIn = true;
    let release!: () => void;
    state.gate = new Promise((resolve) => (release = resolve));
    const backend = new ClaudeLanguageBackend({ runner });
    const opens = [backend.open('haiku'), backend.open('haiku'), backend.open('haiku')];
    await vi.waitFor(() => expect(state.runs).toBe(1));
    release();
    const sessions = await Promise.all(opens);
    expect(state.runs).toBe(1);
    await Promise.all(sessions.map((session) => session.close()));
  });

  it('shares one in-flight failed check between concurrent opens', async () => {
    const { state, runner } = fakeAuth();
    const backend = new ClaudeLanguageBackend({ runner });
    const results = await Promise.allSettled([backend.open('haiku'), backend.open('haiku')]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(state.runs).toBe(1);
  });

  it('does not rerun a failed check within the back-off, and picks up a login after it', async () => {
    const { state, runner } = fakeAuth();
    const backend = new ClaudeLanguageBackend({ runner });
    await expect(backend.open('haiku')).rejects.toMatchObject({ code: 'login-required' });
    expect(state.runs).toBe(1);

    state.loggedIn = true;
    vi.advanceTimersByTime(SUBSCRIPTION_FAILURE_TTL_MS - 1);
    await expect(backend.open('haiku')).rejects.toMatchObject({ code: 'login-required' });
    expect(state.runs).toBe(1);

    vi.advanceTimersByTime(1);
    const session = await backend.open('haiku');
    expect(state.runs).toBe(2);
    await session.close();
  });

  it('caches a successful check until its TTL expires', async () => {
    const { state, runner } = fakeAuth();
    state.loggedIn = true;
    const backend = new ClaudeLanguageBackend({ runner });
    await (await backend.open('haiku')).close();
    vi.advanceTimersByTime(SUBSCRIPTION_SUCCESS_TTL_MS - 1);
    await (await backend.open('haiku')).close();
    expect(state.runs).toBe(1);

    vi.advanceTimersByTime(1);
    state.loggedIn = false;
    await expect(backend.open('haiku')).rejects.toMatchObject({ code: 'login-required' });
    expect(state.runs).toBe(2);
  });

  it('applies the same back-off to Codex login checks', async () => {
    let runs = 0;
    const runner: ProcessRunner = async function* () {
      runs++;
      yield {
        type: 'exit',
        outcome: { code: 1, signal: null, reason: 'exited', diagnostics: 'Not logged in' },
      };
    };
    const backend = new CodexLanguageBackend({ runner });
    await expect(backend.open('model')).rejects.toMatchObject({ code: 'login-required' });
    await expect(backend.open('model')).rejects.toMatchObject({ code: 'login-required' });
    expect(runs).toBe(1);
    vi.advanceTimersByTime(SUBSCRIPTION_FAILURE_TTL_MS);
    await expect(backend.open('model')).rejects.toMatchObject({ code: 'login-required' });
    expect(runs).toBe(2);
  });
});
