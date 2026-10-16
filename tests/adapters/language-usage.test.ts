import { expect, it } from 'vitest';
import type { ProcessRunner } from '../../src/runtime/process-runner';
import { ClaudeLanguageBackend } from '../../src/language/claude';
import { CodexLanguageBackend } from '../../src/language/codex';
import type { LanguageObserver } from '../../src/language/shared';

const signal = () => new AbortController().signal;
const rateLimit = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    unifiedWindows: {
      five_hour: { utilization: 0.37, resetsAt: 1791973200 },
      seven_day: { utilization: 0.43, resetsAt: 1792335600 },
    },
  },
};
const claudeResult = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'שלום',
  total_cost_usd: 0.0001,
  usage: { input_tokens: 2, cache_read_input_tokens: 8, output_tokens: 4 },
};
function fixture(events: unknown[], prompts: string[] = []): ProcessRunner {
  return async function* (_exe, args, prompt) {
    if (args.includes('auth')) {
      yield {
        type: 'line',
        line: JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
        }),
      };
      yield { type: 'exit', outcome: { code: 0, signal: null, reason: 'exited', diagnostics: '' } };
      return;
    }
    if (args.includes('login')) {
      yield {
        type: 'exit',
        outcome: {
          code: 0,
          signal: null,
          reason: 'exited',
          diagnostics: 'Logged in using ChatGPT',
        },
      };
      return;
    }
    prompts.push(prompt);
    for (const event of events) yield { type: 'line', line: JSON.stringify(event) };
    yield { type: 'exit', outcome: { code: 0, signal: null, reason: 'exited', diagnostics: '' } };
  };
}
function observer() {
  const usage: unknown[] = [];
  const spend: unknown[] = [];
  const value: LanguageObserver = { usage: (u) => usage.push(u), spend: (s) => spend.push(s) };
  return { value, usage, spend };
}

it('reports Claude rate limits and the cost of each call, attributed to the session scope', async () => {
  const seen = observer();
  const backend = new ClaudeLanguageBackend({
    runner: fixture([rateLimit, claudeResult]),
    observer: seen.value,
    now: () => 42,
  });
  const session = await backend.open('haiku', undefined, { scope: 'session-A' });
  expect(await session.translate('hello', 'Hebrew', signal())).toBe('שלום');
  expect(seen.usage).toEqual([
    {
      provider: 'claude',
      observedAt: 42,
      fiveHour: { usedFraction: 0.37, resetsAt: 1791973200000 },
      sevenDay: { usedFraction: 0.43, resetsAt: 1792335600000 },
    },
  ]);
  expect(seen.spend).toEqual([
    {
      provider: 'claude',
      model: 'haiku',
      scope: 'session-A',
      spend: { usd: 0.0001, inputTokens: 10, outputTokens: 4 },
    },
  ]);
  await session.close();
});
it('reports Codex token spend without a dollar figure and no rate-limit observation', async () => {
  const seen = observer();
  const backend = new CodexLanguageBackend({
    runner: fixture([
      { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'שלום' } },
      { type: 'turn.completed', usage: { input_tokens: 30, output_tokens: 5 } },
    ]),
    observer: seen.value,
  });
  const session = await backend.open('test', undefined, { scope: 'session-B' });
  await session.translate('hello', 'Hebrew', signal());
  expect(seen.usage).toEqual([]);
  expect(seen.spend).toEqual([
    {
      provider: 'codex',
      model: 'test',
      scope: 'session-B',
      spend: { inputTokens: 30, outputTokens: 5 },
    },
  ]);
  await session.close();
});
it('refreshes Claude usage with a one-word probe billed to the probe scope', async () => {
  const seen = observer();
  const prompts: string[] = [];
  const backend = new ClaudeLanguageBackend({
    runner: fixture([rateLimit, { ...claudeResult, result: 'OK' }], prompts),
    observer: seen.value,
    now: () => 7,
  });
  await backend.refreshUsage(signal());
  expect(prompts).toHaveLength(1);
  expect(prompts[0]!.length).toBeLessThan(80);
  expect(seen.usage).toMatchObject([{ provider: 'claude', observedAt: 7 }]);
  expect(seen.spend).toMatchObject([{ scope: 'usage-probe', model: 'haiku' }]);
});
