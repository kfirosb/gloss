import type { AgentKind } from '../core/contracts.js';
import { classifyScreen, markersFor, type MarkerTable } from './attention-markers.js';
import type { LaunchRecord } from './session-launcher.js';
import { sessionNameOf, type Tmux } from './tmux.js';

export type Attention = {
  launchId: string;
  state: 'needs-user' | 'clear' | 'unknown-version';
  reason?: string;
};
export interface AttentionMonitor {
  start(): void;
  markers(agent: AgentKind): Promise<MarkerTable | undefined>;
  current(): Map<string, Attention>;
  subscribe(l: (m: Map<string, Attention>) => void): () => void;
  close(): void;
}

export const VERSION_RETRY_MS = 60_000;
/** A pane that cannot be captured (for example a session that just died) is not probed again for this long. */
export const CAPTURE_RETRY_MS = 15_000;
const agentLabel = (agent: AgentKind) => (agent === 'claude' ? 'Claude' : 'Codex');

/** Watches launched sessions' screens for prompts that need the user. It never answers them. */
export function createAttentionMonitor(options: {
  tmux: () => Promise<Tmux>;
  launches: () => LaunchRecord[];
  agentVersion(agent: AgentKind): Promise<string | undefined>;
  intervalMs?: number;
  setTimer?: typeof setTimeout;
  now?: () => number;
}): AttentionMonitor {
  const state = new Map<string, Attention>();
  const listeners = new Set<(m: Map<string, Attention>) => void>();
  const timer = options.setTimer ?? setTimeout;
  let closed = false;
  let started = false;
  let handle: ReturnType<typeof setTimeout> | undefined;
  const now = options.now ?? Date.now;
  // Known versions are cached for the monitor's life; failed or empty probes are retried after a backoff.
  const versions = new Map<AgentKind, { at: number; value: Promise<string | undefined> }>();
  const captureFailedAt = new Map<string, number>();
  const version = async (a: AgentKind) => {
    const cached = versions.get(a);
    if (cached && ((await cached.value) !== undefined || now() - cached.at < VERSION_RETRY_MS))
      return cached.value;
    const value = options.agentVersion(a).catch(() => undefined);
    versions.set(a, { at: now(), value });
    return value;
  };
  async function inspect(launch: LaunchRecord): Promise<Attention> {
    // Shells are filtered out in poll(); only agents reach here.
    const agent = launch.agent as AgentKind;
    const table = markersFor(agent, (await version(agent)) ?? '');
    if (!table)
      return {
        launchId: launch.id,
        state: 'unknown-version',
        reason: `Approval detection unavailable for this ${agentLabel(agent)} version`,
      };
    const failed = captureFailedAt.get(launch.id);
    if (failed !== undefined && now() - failed < CAPTURE_RETRY_MS)
      return state.get(launch.id) ?? { launchId: launch.id, state: 'clear' };
    const screen = await options
      .tmux()
      .then(async (t) => t.capturePane(await sessionNameOf(t, launch.id)))
      .then(
        (text) => {
          captureFailedAt.delete(launch.id);
          return text;
        },
        () => {
          captureFailedAt.set(launch.id, now());
          return '';
        },
      );
    const kind = classifyScreen(table, screen);
    return {
      launchId: launch.id,
      state: kind === 'none' ? 'clear' : 'needs-user',
      ...(kind === 'consent'
        ? { reason: `${agentLabel(agent)} is asking for startup consent` }
        : {}),
    };
  }
  async function poll() {
    if (closed) return;
    try {
      let changed = false;
      const seen = new Set<string>();
      for (const launch of options
        .launches()
        .filter((l) => l.state !== 'ended' && l.agent !== 'shell')) {
        seen.add(launch.id);
        const next = await inspect(launch);
        if (closed) return;
        const prev = state.get(launch.id);
        if (!prev || prev.state !== next.state || prev.reason !== next.reason) {
          state.set(launch.id, next);
          changed = true;
        }
      }
      for (const id of [...state.keys()])
        if (!seen.has(id)) {
          state.delete(id);
          changed = true;
        }
      for (const id of [...captureFailedAt.keys()]) if (!seen.has(id)) captureFailedAt.delete(id);
      if (changed)
        for (const l of listeners) {
          try {
            l(new Map(state));
          } catch {
            /* Listeners do not control polling. */
          }
        }
    } catch {
      /* A failed poll keeps the last known state; the next poll retries. */
    }
    if (!closed) {
      handle = timer(() => void poll(), options.intervalMs ?? 1000);
      (handle as { unref?: () => void } | undefined)?.unref?.();
    }
  }
  return {
    markers: async (agent) => markersFor(agent, (await version(agent)) ?? ''),
    start() {
      if (started || closed) return;
      started = true;
      void poll();
    },
    current: () => new Map(state),
    subscribe(l) {
      if (closed) return () => {};
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    close() {
      closed = true;
      listeners.clear();
      if (handle !== undefined && !options.setTimer) clearTimeout(handle);
    },
  };
}
