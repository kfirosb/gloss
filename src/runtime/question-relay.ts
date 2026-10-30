import { createHash } from 'node:crypto';
import type { AgentKind, SourceMessage } from '../core/contracts.js';
import type { CatalogEntry } from '../core/session-catalog.js';

/** What the relay needs from a catalog row to find the session a launch belongs to. */
export type QuestionRelayEntry = Pick<CatalogEntry, 'launchId' | 'sessionId' | 'target'>;
import type { Attention, AttentionMonitor } from './attention-monitor.js';
import { questionMessageText, type TerminalQuestion } from './question-screen.js';

/** Conversation messages made from terminal questions carry this sourceId prefix; their revisions are clock times. */
export const QUESTION_SOURCE_PREFIX = 'question:';
export const QUESTION_RELAY_RETRY_MS = 1000;
/** Remembered questions, enough that a dialog shown again after Esc is not posted twice. */
const RELAYED_LIMIT = 200;

/**
 * Posts each question a launched Claude session shows in its terminal into that session's conversation, once,
 * so it is read and translated there while the user answers in the terminal. Claude writes the question to its
 * transcript only after the answer, so the screen is the only live source. A launch whose session is not
 * identified yet is retried while the question stays on screen.
 */
export function createQuestionRelay(options: {
  attention: Pick<AttentionMonitor, 'subscribe'>;
  entries: () => readonly QuestionRelayEntry[];
  ingest: (agent: AgentKind, message: SourceMessage) => Promise<unknown>;
  now?: () => number;
  setTimer?: typeof setTimeout;
  retryMs?: number;
}): { close(): void } {
  const now = options.now ?? Date.now;
  const timer = options.setTimer ?? setTimeout;
  const pending = new Map<string, TerminalQuestion>();
  const relayed = new Set<string>();
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const remember = (key: string) => {
    relayed.add(key);
    if (relayed.size > RELAYED_LIMIT) relayed.delete(relayed.values().next().value!);
  };
  const unposted = () =>
    [...pending].some(
      ([launchId, question]) => !relayed.has(`${launchId}\n${questionMessageText(question)}`),
    );
  /** One retry timer at a time, armed only while a shown question is still unposted. */
  const arm = () => {
    if (closed || retry !== undefined || !unposted()) return;
    retry = timer(() => {
      retry = undefined;
      flush();
    }, options.retryMs ?? QUESTION_RELAY_RETRY_MS);
    (retry as { unref?: () => void } | undefined)?.unref?.();
  };
  const flush = () => {
    if (closed) return;
    const entries = options.entries();
    for (const [launchId, question] of pending) {
      const text = questionMessageText(question);
      const key = `${launchId}\n${text}`;
      if (relayed.has(key)) continue;
      const entry = entries.find(
        (e) => e.launchId === launchId && e.sessionId && e.target.agent === 'claude',
      );
      if (!entry) continue;
      remember(key);
      const at = now();
      const hash = createHash('sha256').update(text).digest('hex').slice(0, 12);
      void options
        .ingest(entry.target.agent, {
          sourceSessionId: entry.target.sessionRef,
          sourceId: `${QUESTION_SOURCE_PREFIX}${launchId}:${hash}`,
          sequence: at,
          role: 'assistant',
          text,
          complete: true,
          timestamp: new Date(at).toISOString(),
        })
        .catch(() => {
          // The session may not be registered yet; the next retry posts it while the question stays on screen.
          relayed.delete(key);
          arm();
        });
    }
    arm();
  };
  const unsubscribe = options.attention.subscribe((current: Map<string, Attention>) => {
    pending.clear();
    for (const [launchId, attention] of current)
      if (attention.state === 'question' && attention.question)
        pending.set(launchId, attention.question);
    flush();
  });
  return {
    close() {
      closed = true;
      unsubscribe();
      if (retry !== undefined && !options.setTimer) clearTimeout(retry);
    },
  };
}
