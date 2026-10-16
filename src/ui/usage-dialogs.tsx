import { useEffect, useRef, useState } from 'react';
import type { AgentKind } from '../core/contracts.js';
import type { ProviderUsage, Spend, UsageWindow } from '../core/usage.js';
import type { SessionUsageReport } from '../runtime/usage.js';
import { PanelDialog } from './composer-dialogs.js';
import { sessionRequest } from './session-client.js';
import {
  breakEpisodeKey,
  FIVE_HOUR_IDEAS,
  formatClock,
  formatCountdown,
  formatTokens,
  formatUsd,
  nextSuggestion,
  percentLeft,
  quotaBreak,
  readout,
  WARN_LEFT_FRACTION,
  WEEKLY_IDEAS,
  type Suggestion,
} from './usage.js';

const PLAN_URL: Record<AgentKind, string> = {
  claude: 'https://claude.ai/upgrade',
  codex: 'https://chatgpt.com/pricing',
};
const AGENT_NAME: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex' };
const DISMISSED_KEY = 'gloss:quota-breaks-dismissed:v1';

/** Re-renders every `ms` so countdowns tick. */
function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

function WindowBar({ label, window, now }: { label: string; window: UsageWindow; now: number }) {
  const renewed = window.resetsAt <= now;
  const left = percentLeft(window);
  const out = window.usedFraction >= 1 && !renewed;
  const tone = renewed
    ? 'healthy'
    : out
      ? 'out'
      : 1 - window.usedFraction < WARN_LEFT_FRACTION
        ? 'warn'
        : 'healthy';
  return (
    <div className="usage-window">
      <div className="usage-window-label">
        <b>{label}</b>
        <span>{renewed ? 'Renewed' : out ? 'Used up' : `${left}% left`}</span>
      </div>
      {!renewed && (
        <div
          className={`usage-bar ${tone}`}
          role="progressbar"
          aria-label={`${label} used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(window.usedFraction * 100)}
        >
          <div style={{ width: `${Math.min(100, window.usedFraction * 100)}%` }} />
        </div>
      )}
      <div className="usage-reset">
        {window.resetsAt > now
          ? `Renews in ${formatCountdown(window.resetsAt - now)} · ${formatClock(window.resetsAt)}`
          : 'Renewed; refresh for current numbers'}
      </div>
    </div>
  );
}

const COUNTED =
  'Counts every call Gloss’s own language model makes, translations, summaries, instruction prep and Language Assistant chat, including the instructions and context sent with each.';
const price = (value: number) => `$${value.toFixed(2)}`;
function spendNote(provider: AgentKind, report: SessionUsageReport): string {
  if (provider === 'claude')
    return `${COUNTED} Refresh checks count toward today and all time. On a Claude subscription this is drawn from your plan, not billed; the figure is what it would cost at API prices.`;
  const p = report.prices;
  if (!p)
    return `${COUNTED} Codex reports tokens, not dollars, and this model has no price on file. Included in your ChatGPT plan.`;
  const asOf = new Date(`${p.asOf}T12:00:00`).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return `${COUNTED} Codex reports tokens only, so dollars are estimated at OpenAI API prices as of ${asOf}: ${price(p.input)} input, ${price(p.cachedInput)} cached input, ${price(p.output)} output per million tokens. Included in your ChatGPT plan, not billed.`;
}

function SpendBlock({
  provider,
  report,
}: {
  provider: AgentKind;
  report: SessionUsageReport | null;
}) {
  const estimated = provider === 'codex' && Boolean(report?.prices);
  const amount = (spend: Spend | null) =>
    spend?.usd !== undefined
      ? `${estimated ? '≈ ' : ''}${formatUsd(spend.usd)}`
      : !spend
        ? provider === 'claude' || estimated
          ? '$0'
          : '0 tokens'
        : `${formatTokens(spend.inputTokens + spend.outputTokens)} tokens`;
  const session = report?.spend.session ?? null;
  return (
    <div className="usage-spent">
      <h4>What Gloss has spent</h4>
      {report ? (
        <>
          <p className="usage-big">{amount(session)} this session</p>
          <table>
            <tbody>
              {provider === 'codex' && (
                <tr>
                  <td>In / out, this session</td>
                  <td>
                    {formatTokens(session?.inputTokens ?? 0)} /{' '}
                    {formatTokens(session?.outputTokens ?? 0)} tokens
                  </td>
                </tr>
              )}
              <tr>
                <td>Today</td>
                <td>{amount(report.spend.today)}</td>
              </tr>
              <tr>
                <td>All time, since install</td>
                <td>{amount(report.spend.allTime)}</td>
              </tr>
              <tr>
                <td>Model</td>
                <td>{report.model}</td>
              </tr>
            </tbody>
          </table>
          <p className="usage-fine">{spendNote(provider, report)}</p>
        </>
      ) : (
        <p className="usage-fine">Loading…</p>
      )}
    </div>
  );
}

/** Header pill for the selected session's agent; click for windows, refresh and Gloss's own spend. */
export function UsageReadout({
  sessionId,
  provider,
  usage,
}: {
  sessionId: string;
  provider: AgentKind;
  usage: ProviderUsage | undefined;
}) {
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<SessionUsageReport | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const root = useRef<HTMLSpanElement>(null);
  const load = () =>
    sessionRequest<SessionUsageReport>(`/api/sessions/${encodeURIComponent(sessionId)}/usage`).then(
      setReport,
      () => setReport(null),
    );
  useEffect(() => {
    if (open) void load();
  }, [open, sessionId, usage?.observedAt]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  const refresh = async () => {
    setRefreshing(true);
    setError('');
    try {
      await sessionRequest('/api/usage/refresh', {
        method: 'POST',
        body: JSON.stringify({ provider }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  };
  const view = readout(usage, now);
  return (
    <span className="usage-wrap" ref={root}>
      <button
        type="button"
        className={`usage-pill ${view.state}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${AGENT_NAME[provider]} usage: ${view.text}`}
        onClick={() => setOpen((value) => !value)}
      >
        <i aria-hidden="true" />
        {view.text}
      </button>
      {open && (
        <div className="usage-popover" role="dialog" aria-label={`${AGENT_NAME[provider]} usage`}>
          <h3>
            {AGENT_NAME[provider]} usage{' '}
            {usage && <small>as of {formatClock(usage.observedAt)}</small>}
          </h3>
          {usage?.fiveHour && <WindowBar label="5-hour window" window={usage.fiveHour} now={now} />}
          {usage?.sevenDay && <WindowBar label="This week" window={usage.sevenDay} now={now} />}
          {!usage?.fiveHour && !usage?.sevenDay && (
            <p className="usage-fine">
              No usage reported yet.{' '}
              {provider === 'claude'
                ? 'It arrives with the next translation, or press Refresh.'
                : 'It arrives after the agent’s next turn, or press Refresh.'}
            </p>
          )}
          <div className="usage-row">
            <button type="button" disabled={refreshing} onClick={() => void refresh()}>
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
            <span>
              {provider === 'claude'
                ? 'Updates on every translation'
                : 'Updates after every turn of the agent'}
            </span>
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <SpendBlock provider={provider} report={report} />
        </div>
      )}
    </span>
  );
}

function readDismissed(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
function writeDismissed(keys: string[]) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(keys.slice(-50)));
  } catch {
    /* in-memory only */
  }
}

/** Opens once per exhaustion episode of the selected agent's quota; weekly wins over the 5-hour window. */
export function QuotaBreakDialog({
  provider,
  usage,
}: {
  provider: AgentKind;
  usage: ProviderUsage | undefined;
}) {
  const now = useNow(1000);
  const episode = quotaBreak(usage, now);
  const key = episode ? breakEpisodeKey(provider, episode) : '';
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  const weekly = episode?.window === 'seven_day';
  const list = weekly ? WEEKLY_IDEAS : FIVE_HOUR_IDEAS;
  const [idea, setIdea] = useState<Suggestion>(() => nextSuggestion(list, undefined));
  useEffect(() => {
    if (key) setIdea(nextSuggestion(list, undefined));
  }, [key]);
  const open = Boolean(episode && !dismissed.includes(key));
  const dismiss = () => {
    const next = [...dismissed, key];
    setDismissed(next);
    writeDismissed(next);
  };
  if (!episode) return null;
  const remaining = formatCountdown(episode.resetsAt - now);
  const when = weekly
    ? new Date(episode.resetsAt).toLocaleString([], {
        weekday: 'long',
        hour: '2-digit',
        minute: '2-digit',
      })
    : formatClock(episode.resetsAt);
  return (
    <PanelDialog
      title={weekly ? 'Weekly quota used up' : '5-hour window used up'}
      open={open}
      close={dismiss}
      className={`quota-break ${weekly ? 'weekly' : 'five-hour'}`}
      dir="ltr"
    >
      <div className="review-body">
        <p className="quota-eyebrow">{weekly ? 'Weekly quota used up' : '5-hour window used up'}</p>
        <h3>{weekly ? 'This is a real break' : 'Time for a break'}</h3>
        <p className="quota-renew">
          Your {AGENT_NAME[provider]} {weekly ? 'weekly ' : ''}quota renews in <b>{remaining}</b>,{' '}
          {weekly ? '' : 'at '}
          {when}.
        </p>
        <div className="quota-idea">
          <small>Meanwhile</small>
          <p>
            <span className="quota-emoji" aria-hidden="true">
              {idea.emoji}
            </span>
            {idea.text}
          </p>
        </div>
      </div>
      <div className="review-actions">
        <a
          className="quota-upgrade"
          href={PLAN_URL[provider]}
          target="_blank"
          rel="noopener noreferrer"
        >
          Upgrade plan
        </a>
        <button type="button" onClick={() => setIdea((current) => nextSuggestion(list, current))}>
          Another idea
        </button>
        <button type="button" className="primary" onClick={dismiss}>
          Dismiss
        </button>
      </div>
    </PanelDialog>
  );
}
