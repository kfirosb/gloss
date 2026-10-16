import { expect, test } from 'vitest';
import {
  formatCountdown,
  readout,
  breakEpisodeKey,
  nextSuggestion,
  FIVE_HOUR_IDEAS,
  WEEKLY_IDEAS,
  formatUsd,
  formatTokens,
} from '../../src/ui/usage.js';
import type { ProviderUsage } from '../../src/core/usage.js';

const at = Date.parse('2026-10-14T14:03:00Z');
const usage = (five: number, week: number, resetIn = 2.67 * 3600_000): ProviderUsage => ({
  provider: 'claude',
  observedAt: at,
  fiveHour: { usedFraction: five, resetsAt: at + resetIn },
  sevenDay: { usedFraction: week, resetsAt: at + 4.5 * 86400_000 },
});

test('countdowns read like a person would say them', () => {
  expect(formatCountdown(2.67 * 3600_000)).toBe('2h 40m');
  expect(formatCountdown(4.17 * 86400_000)).toBe('4d 4h');
  expect(formatCountdown(12 * 60_000 + 5000)).toBe('12m');
  expect(formatCountdown(40_000)).toBe('under a minute');
  expect(formatCountdown(-5)).toBe('now');
});
test('the header readout turns amber under 20% left, red when a window is out, and grey without data', () => {
  expect(readout(undefined, at)).toEqual({ state: 'unknown', text: 'usage —' });
  expect(readout(usage(0.37, 0.43), at)).toEqual({
    state: 'healthy',
    text: '5h 63% left · week 57% left',
  });
  expect(readout(usage(0.95, 0.43), at)).toEqual({
    state: 'warn',
    text: '5h 5% left · week 57% left',
  });
  expect(readout(usage(0.5, 0.85), at)).toEqual({
    state: 'warn',
    text: '5h 50% left · week 15% left',
  });
  expect(readout(usage(1, 0.43), at)).toEqual({
    state: 'out',
    text: '5h quota renews in 2h 40m · week 57% left',
  });
  expect(
    readout(
      { provider: 'codex', observedAt: at, fiveHour: { usedFraction: 0.2, resetsAt: at + 60_000 } },
      at,
    ),
  ).toEqual({ state: 'healthy', text: '5h 80% left' });
});
test('a window whose reset already passed reads as renewed instead of its stale percentage', () => {
  expect(
    readout(
      {
        provider: 'codex',
        observedAt: at - 3 * 3600_000,
        fiveHour: { usedFraction: 0.84, resetsAt: at - 60_000 },
        sevenDay: { usedFraction: 0.03, resetsAt: at + 86400_000 },
      },
      at,
    ),
  ).toEqual({ state: 'healthy', text: '5h renewed · week 97% left' });
  expect(
    readout(
      {
        provider: 'codex',
        observedAt: at - 3 * 3600_000,
        fiveHour: { usedFraction: 1, resetsAt: at - 60_000 },
      },
      at,
    ),
  ).toEqual({ state: 'healthy', text: '5h renewed' });
});
test('break episodes are keyed by provider, window and reset time so a dismissed break stays dismissed', () => {
  expect(breakEpisodeKey('claude', { window: 'five_hour', resetsAt: 123 })).toBe(
    'claude:five_hour:123',
  );
});
test('suggestions rotate without repeating the current one', () => {
  expect(FIVE_HOUR_IDEAS.length).toBeGreaterThanOrEqual(20);
  expect(WEEKLY_IDEAS.length).toBeGreaterThanOrEqual(8);
  const first = nextSuggestion(FIVE_HOUR_IDEAS, undefined, () => 0);
  expect(first).toBe(FIVE_HOUR_IDEAS[0]);
  expect(nextSuggestion(FIVE_HOUR_IDEAS, first, () => 0)).toBe(FIVE_HOUR_IDEAS[1]);
});
test('money and tokens format compactly', () => {
  expect(formatUsd(0.00013934)).toBe('$0.0001');
  expect(formatUsd(0.004)).toBe('$0.004');
  expect(formatUsd(0.31)).toBe('$0.31');
  expect(formatUsd(12.5)).toBe('$12.50');
  expect(formatTokens(950)).toBe('950');
  expect(formatTokens(41_200)).toBe('41.2k');
  expect(formatTokens(1_200_000)).toBe('1.2M');
});
