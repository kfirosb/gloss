import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentKind, LanguageBackend } from '../core/contracts.js';
import {
  pricesFor,
  priceSpend,
  UsageTracker,
  type ProviderUsage,
  type Spend,
  type SpendStore,
  type TokenPrices,
  type UsageSnapshot,
} from '../core/usage.js';
import type { LanguageObserver } from '../language/shared.js';
import { readLatestCodexUsage } from '../agents/codex/usage.js';

export interface SessionUsageReport {
  provider: AgentKind;
  model: string;
  usage: ProviderUsage | null;
  spend: { session: Spend | null; today: Spend | null; allTime: Spend | null };
  /** Set when the dollar figures are Gloss's own estimate from a dated price table rather than the provider's reported cost. */
  prices: TokenPrices | null;
}
export interface UsageService {
  readonly tracker: UsageTracker;
  /** Given to the language backends; every call they make lands here. */
  readonly observer: LanguageObserver;
  report(sessionId: string, provider: AgentKind, model: string): SessionUsageReport;
  refresh(
    provider: AgentKind,
    backends: Partial<Record<AgentKind, LanguageBackend>>,
    signal: AbortSignal,
  ): Promise<UsageSnapshot>;
}
export interface UsageServiceOptions {
  store?: Partial<SpendStore>;
  codexHome?: string;
  now?: () => number;
}

const dayKey = (at: number) => {
  const d = new Date(at);
  return `day:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function createUsageService(options: UsageServiceOptions = {}): UsageService {
  const tracker = new UsageTracker();
  const now = options.now ?? Date.now;
  const store = options.store;
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const read = (scope: string, provider: AgentKind, model: string) => {
    const spend = store?.readSpend?.(scope, provider);
    return spend ? priceSpend(provider, model, spend) : null;
  };
  return {
    tracker,
    observer: {
      usage: (usage) => tracker.observe(usage),
      // Codex tokens are stored unpriced and priced when read, so every total uses one dated rate.
      spend: (entry) => {
        for (const scope of [`session:${entry.scope}`, dayKey(now()), 'all'])
          store?.addSpend?.(scope, entry.provider, entry.spend);
      },
    },
    report(sessionId, provider, model) {
      return {
        provider,
        model,
        usage: tracker.snapshot()[provider] ?? null,
        spend: {
          session: read(`session:${sessionId}`, provider, model),
          today: read(dayKey(now()), provider, model),
          allTime: read('all', provider, model),
        },
        prices: pricesFor(provider, model) ?? null,
      };
    },
    async refresh(provider, backends, signal) {
      if (provider === 'codex') {
        const usage = await readLatestCodexUsage(codexHome);
        if (usage) tracker.observe(usage);
      } else await backends[provider]?.refreshUsage?.(signal);
      return tracker.snapshot();
    },
  };
}
