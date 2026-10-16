import type { AgentKind } from '../core/contracts.js';
import {
  quotaBreak,
  type ProviderUsage,
  type QuotaWindow,
  type UsageWindow,
} from '../core/usage.js';

export type ReadoutState = 'unknown' | 'healthy' | 'warn' | 'out';
export const WARN_LEFT_FRACTION = 0.2;

export const percentLeft = (window: UsageWindow) =>
  Math.max(0, Math.round((1 - window.usedFraction) * 100));

/** "2h 40m", "4d 4h", "12m": the nearest two units a person would say. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  const days = Math.floor(minutes / 1440),
    hours = Math.floor((minutes % 1440) / 60),
    rest = minutes % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${rest}m`;
  return `${rest}m`;
}
export const formatClock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The header pill's colour and text for one provider. */
export function readout(
  usage: ProviderUsage | undefined,
  now: number,
): { state: ReadoutState; text: string } {
  if (!usage || (!usage.fiveHour && !usage.sevenDay)) return { state: 'unknown', text: 'usage —' };
  const parts: string[] = [];
  let state: ReadoutState = 'healthy';
  const consider = (label: string, window: UsageWindow | undefined) => {
    if (!window) return;
    // The provider has not reported since this window renewed; its old percentage no longer applies.
    if (window.resetsAt <= now) {
      parts.push(`${label} renewed`);
      return;
    }
    if (window.usedFraction >= 1 && window.resetsAt > now) {
      state = 'out';
      parts.push(`${label} quota renews in ${formatCountdown(window.resetsAt - now)}`);
      return;
    }
    if (1 - window.usedFraction < WARN_LEFT_FRACTION && state !== 'out') state = 'warn';
    parts.push(`${label} ${percentLeft(window)}% left`);
  };
  consider('5h', usage.fiveHour);
  consider('week', usage.sevenDay);
  return { state, text: parts.join(' · ') };
}

export const breakEpisodeKey = (
  provider: AgentKind,
  value: { window: QuotaWindow; resetsAt: number },
) => `${provider}:${value.window}:${value.resetsAt}`;
export { quotaBreak };

export interface Suggestion {
  emoji: string;
  text: string;
}
export const FIVE_HOUR_IDEAS: readonly Suggestion[] = [
  { emoji: '🏃', text: 'Go for a run. Your 5-hour window will be fresh when you are back.' },
  { emoji: '🥗', text: 'Lunch break. Eat away from the screen.' },
  { emoji: '📞', text: 'Call someone you love. They will be glad you did.' },
  { emoji: '📚', text: 'Learn something new for an hour. A talk, a chapter, a tutorial.' },
  { emoji: '🗓️', text: 'Plan tomorrow. Three things that matter, in order.' },
  { emoji: '🔍', text: 'Review a teammate’s PR. They are waiting on you.' },
  { emoji: '🧘', text: 'Stretch. Shoulders, neck, back. Then water.' },
  { emoji: '🚶', text: 'Walk outside without headphones.' },
  { emoji: '🧹', text: 'Tidy your desk and close the tabs you will never read.' },
  { emoji: '📝', text: 'Write the README you keep postponing.' },
  { emoji: '☕', text: 'Coffee with a colleague, not at the keyboard.' },
  { emoji: '🎧', text: 'Listen to one album start to finish.' },
  { emoji: '🛒', text: 'Groceries. Dinner tonight will thank you.' },
  { emoji: '💤', text: 'A twenty-minute nap. Set an alarm.' },
  { emoji: '🧠', text: 'Sketch the architecture of the next thing on paper.' },
  { emoji: '🌱', text: 'Water the plants. Check on the ones that look sad.' },
  { emoji: '✉️', text: 'Answer the three emails you have been avoiding.' },
  { emoji: '🎨', text: 'Draw something badly. Nobody is watching.' },
  { emoji: '🚲', text: 'Bike ride. Short and fast or long and slow.' },
  { emoji: '👋', text: 'Say hi to a neighbour.' },
];
export const WEEKLY_IDEAS: readonly Suggestion[] = [
  {
    emoji: '✈️',
    text: 'Go on vacation. Travel somewhere you have never been and come back with stories, not commits.',
  },
  { emoji: '🏔️', text: 'A hike with a summit. Phone on airplane mode.' },
  { emoji: '🏖️', text: 'A beach, a book, no laptop.' },
  { emoji: '🚆', text: 'Take a train somewhere and decide the rest on the way.' },
  { emoji: '👨‍👩‍👧', text: 'Spend the days with family. The backlog keeps.' },
  { emoji: '🏕️', text: 'Camp for a weekend. No signal is a feature.' },
  { emoji: '🍳', text: 'Cook a long, slow meal for people you like.' },
  { emoji: '🌍', text: 'Visit a city you keep saying you will visit.' },
];
/** A random suggestion that differs from the one on screen. */
export function nextSuggestion(
  list: readonly Suggestion[],
  current: Suggestion | undefined,
  random: () => number = Math.random,
): Suggestion {
  const choices = list.filter((item) => item !== current);
  return choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))]!;
}

export function formatUsd(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(2).replace(/0$/, '')}`;
  if (value >= 0.001) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}
