import { describe, expect, it } from 'vitest';
import { parseClaudeRateLimit, parseCodexRateLimits, parseClaudeSpend, parseCodexSpend, priceSpend, CODEX_PRICES, quotaBreak, UsageTracker, type ProviderUsage } from '../../src/core/usage.js';

const claudeEvent = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1791973200, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.37, resetsAt: 1791973200 }, seven_day: { utilization: 0.43, resetsAt: 1792335600 } } } };
const codexLimits = { limit_id: 'codex', primary: { used_percent: 95, window_minutes: 300, resets_at: 1791812736 }, secondary: { used_percent: 43, window_minutes: 10080, resets_at: 1792309531 } };

describe('rate limit parsing', () => {
  it('reads both Claude windows from a rate_limit_event, in milliseconds', () => {
    expect(parseClaudeRateLimit(claudeEvent, 1000)).toEqual({ provider: 'claude', observedAt: 1000, fiveHour: { usedFraction: 0.37, resetsAt: 1791973200000 }, sevenDay: { usedFraction: 0.43, resetsAt: 1792335600000 } });
    expect(parseClaudeRateLimit({ type: 'assistant' }, 1000)).toBeUndefined();
    expect(parseClaudeRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, 1000)).toBeUndefined();
  });
  it('treats a rejected Claude status as an exhausted window even when utilization is below one', () => {
    const rejected = { ...claudeEvent, rate_limit_info: { ...claudeEvent.rate_limit_info, status: 'rejected', rateLimitType: 'seven_day' } };
    expect(parseClaudeRateLimit(rejected, 5)?.sevenDay).toEqual({ usedFraction: 1, resetsAt: 1792335600000 });
  });
  it('maps Codex primary and secondary windows by their duration', () => {
    expect(parseCodexRateLimits(codexLimits, 7)).toEqual({ provider: 'codex', observedAt: 7, fiveHour: { usedFraction: 0.95, resetsAt: 1791812736000 }, sevenDay: { usedFraction: 0.43, resetsAt: 1792309531000 } });
    expect(parseCodexRateLimits({ primary: { used_percent: 10, window_minutes: 60, resets_at: 1 } }, 7)).toEqual({ provider: 'codex', observedAt: 7 });
    expect(parseCodexRateLimits(null, 7)).toBeUndefined();
    expect(parseCodexRateLimits({ primary: { used_percent: 'x', window_minutes: 300, resets_at: 1 } }, 7)).toEqual({ provider: 'codex', observedAt: 7 });
  });
});

describe('spend parsing', () => {
  it('reads Claude cost and tokens from a result event, counting cached input as input', () => {
    expect(parseClaudeSpend({ type: 'result', total_cost_usd: 0.00013934, usage: { input_tokens: 2, cache_creation_input_tokens: 574, cache_read_input_tokens: 2234, output_tokens: 4 } })).toEqual({ usd: 0.00013934, inputTokens: 2810, outputTokens: 4 });
    expect(parseClaudeSpend({ type: 'assistant' })).toBeUndefined();
  });
  it('reads Codex tokens from turn.completed with no dollar figure', () => {
    expect(parseCodexSpend({ type: 'turn.completed', usage: { input_tokens: 16812, cached_input_tokens: 12288, output_tokens: 5 } })).toEqual({ inputTokens: 16812, cachedInputTokens: 12288, outputTokens: 5 });
    expect(parseCodexSpend({ type: 'turn.completed' })).toBeUndefined();
  });
});

describe('Codex dollar estimate', () => {
  it('prices fresh input, cached input and output at the dated table rate', () => {
    expect(CODEX_PRICES['gpt-5.6-sol']).toEqual({ input: 4, cachedInput: 0.4, output: 20, asOf: '2026-10-14' });
    // (4,524 fresh × $4 + 12,288 cached × $0.40 + 5 output × $20) / 1M = $0.0231112.
    expect(priceSpend('codex', 'gpt-5.6-sol', { inputTokens: 16812, cachedInputTokens: 12288, outputTokens: 5 })).toEqual({ usd: 0.0231112, inputTokens: 16812, cachedInputTokens: 12288, outputTokens: 5 });
  });
  it('leaves Claude costs, unknown models and already priced spend untouched', () => {
    const tokens = { inputTokens: 10, outputTokens: 2 };
    expect(priceSpend('codex', 'unknown-model', tokens)).toEqual(tokens);
    expect(priceSpend('claude', 'haiku', { usd: 0.1, ...tokens })).toEqual({ usd: 0.1, ...tokens });
  });
});

describe('usage tracker', () => {
  const usage = (observedAt: number, used = 0.5): ProviderUsage => ({ provider: 'claude', observedAt, fiveHour: { usedFraction: used, resetsAt: 10 } });
  it('keeps the newest observation per provider and notifies subscribers', () => {
    const tracker = new UsageTracker();
    const seen: unknown[] = []; tracker.subscribe(value => seen.push(value));
    tracker.observe(usage(2)); tracker.observe(usage(1, 0.9)); tracker.observe({ provider: 'codex', observedAt: 3 });
    expect(tracker.snapshot()).toEqual({ claude: usage(2), codex: { provider: 'codex', observedAt: 3 } });
    expect(seen).toHaveLength(2);
  });
});

describe('quota break', () => {
  const at = 1_000_000;
  it('prefers the weekly window, requires a future reset, and ignores healthy windows', () => {
    expect(quotaBreak({ provider: 'claude', observedAt: 1, fiveHour: { usedFraction: 1, resetsAt: at + 5 }, sevenDay: { usedFraction: 1, resetsAt: at + 9 } }, at)).toEqual({ window: 'seven_day', resetsAt: at + 9 });
    expect(quotaBreak({ provider: 'claude', observedAt: 1, fiveHour: { usedFraction: 1, resetsAt: at + 5 }, sevenDay: { usedFraction: 0.2, resetsAt: at + 9 } }, at)).toEqual({ window: 'five_hour', resetsAt: at + 5 });
    expect(quotaBreak({ provider: 'claude', observedAt: 1, fiveHour: { usedFraction: 1, resetsAt: at - 1 } }, at)).toBeUndefined();
    expect(quotaBreak({ provider: 'claude', observedAt: 1, fiveHour: { usedFraction: 0.99, resetsAt: at + 5 } }, at)).toBeUndefined();
  });
});
