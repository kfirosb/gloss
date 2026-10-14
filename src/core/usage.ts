import type { AgentKind } from './contracts.js';

/** One rolling quota window as the provider reports it: how much is used, and when it renews (epoch ms). */
export interface UsageWindow { usedFraction: number; resetsAt: number }
/** Account-level usage for one provider; the same account serves the live agent and Gloss's own language calls. */
export interface ProviderUsage { provider: AgentKind; observedAt: number; fiveHour?: UsageWindow; sevenDay?: UsageWindow }
export type UsageSnapshot = Partial<Record<AgentKind, ProviderUsage>>;
/** What one language call cost. Claude reports an API-equivalent dollar figure; Codex reports tokens only. */
export interface Spend { usd?: number; inputTokens: number; outputTokens: number }
export type QuotaWindow = 'five_hour' | 'seven_day';
/** Running totals of Gloss's own language calls, keyed by scope: `session:<id>`, `day:<YYYY-MM-DD>` and `all`. */
export interface SpendStore {
  addSpend(scope: string, provider: AgentKind | string, spend: Spend): void;
  readSpend(scope: string, provider: AgentKind | string): Spend | undefined;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const window = (utilization: unknown, resetsAtSeconds: unknown): UsageWindow | undefined =>
  finite(utilization) && finite(resetsAtSeconds) ? { usedFraction: Math.min(1, Math.max(0, utilization)), resetsAt: Math.round(resetsAtSeconds * 1000) } : undefined;

/** Claude Code emits `rate_limit_event` on every `-p` call; a rejected status marks its window as fully used. */
export function parseClaudeRateLimit(event: Record<string, any>, observedAt: number): ProviderUsage | undefined {
  if (event?.type !== 'rate_limit_event') return undefined;
  const info = event.rate_limit_info; const windows = info?.unifiedWindows;
  const fiveHour = window(windows?.five_hour?.utilization, windows?.five_hour?.resetsAt);
  const sevenDay = window(windows?.seven_day?.utilization, windows?.seven_day?.resetsAt);
  if (!fiveHour && !sevenDay) return undefined;
  if (info.status === 'rejected') { const hit = info.rateLimitType === 'seven_day' ? sevenDay : fiveHour; if (hit) hit.usedFraction = 1; }
  return { provider: 'claude', observedAt, ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) };
}

/** Codex rollouts carry `rate_limits` on every token_count event; windows are matched by duration, not position. */
export function parseCodexRateLimits(limits: any, observedAt: number): ProviderUsage | undefined {
  if (!limits || typeof limits !== 'object') return undefined;
  const usage: ProviderUsage = { provider: 'codex', observedAt };
  for (const entry of [limits.primary, limits.secondary]) {
    if (!entry || typeof entry !== 'object' || !finite(entry.used_percent)) continue;
    const value = window(entry.used_percent / 100, entry.resets_at); if (!value) continue;
    if (entry.window_minutes === 300) usage.fiveHour = value;
    else if (entry.window_minutes === 10080) usage.sevenDay = value;
  }
  return usage;
}

export function parseClaudeSpend(event: Record<string, any>): Spend | undefined {
  if (event?.type !== 'result' || !event.usage || typeof event.usage !== 'object') return undefined;
  const u = event.usage; const count = (value: unknown) => finite(value) ? value : 0;
  return { ...(finite(event.total_cost_usd) ? { usd: event.total_cost_usd } : {}), inputTokens: count(u.input_tokens) + count(u.cache_creation_input_tokens) + count(u.cache_read_input_tokens), outputTokens: count(u.output_tokens) };
}
export function parseCodexSpend(event: Record<string, any>): Spend | undefined {
  if (event?.type !== 'turn.completed' || !event.usage || typeof event.usage !== 'object') return undefined;
  return { inputTokens: finite(event.usage.input_tokens) ? event.usage.input_tokens : 0, outputTokens: finite(event.usage.output_tokens) ? event.usage.output_tokens : 0 };
}

/** Latest observation per provider; older observations never overwrite newer ones. */
export class UsageTracker {
  private readonly current: UsageSnapshot = {};
  private readonly listeners = new Set<(snapshot: UsageSnapshot) => void>();
  observe(usage: ProviderUsage): void {
    const previous = this.current[usage.provider];
    if (previous && previous.observedAt > usage.observedAt) return;
    this.current[usage.provider] = structuredClone(usage);
    for (const listener of this.listeners) listener(this.snapshot());
  }
  snapshot(): UsageSnapshot { return structuredClone(this.current); }
  subscribe(listener: (snapshot: UsageSnapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}

/** The window that is currently used up, weekly first; a window whose reset already passed is not a break. */
export function quotaBreak(usage: ProviderUsage | undefined, now: number): { window: QuotaWindow; resetsAt: number } | undefined {
  for (const [key, value] of [['seven_day', usage?.sevenDay], ['five_hour', usage?.fiveHour]] as const)
    if (value && value.usedFraction >= 1 && value.resetsAt > now) return { window: key, resetsAt: value.resetsAt };
  return undefined;
}
