import {
  manualResumeCommand,
  type PastSession,
  type PastSessionsResponse,
} from '../core/past-sessions.js';
import type { LaunchRecord } from '../runtime/session-launcher.js';
import { sessionRequest } from './session-client.js';

type PastSessionId = Pick<PastSession, 'agent' | 'sessionRef'>;

export const listPastSessions = (folder: string) =>
  sessionRequest<PastSessionsResponse>(`/api/past-sessions?folder=${encodeURIComponent(folder)}`);

export const reopenPastSession = (entry: PastSessionId, folder: string) =>
  sessionRequest<LaunchRecord>('/api/launches/resume', {
    method: 'POST',
    body: JSON.stringify({ agent: entry.agent, sessionRef: entry.sessionRef, folder }),
  });

export const hidePastSession = (entry: PastSessionId) =>
  sessionRequest<{ hidden: true }>('/api/past-sessions/hide', {
    method: 'POST',
    body: JSON.stringify({ agent: entry.agent, sessionRef: entry.sessionRef }),
  });

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const RELATIVE_LIMIT_DAYS = 30;

/** Short relative time for a row: "just now", "5 min ago", "3 h ago", "2 d ago", else the date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const elapsed = now - new Date(iso).getTime();
  if (elapsed < MINUTE_MS) return 'just now';
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h ago`;
  if (elapsed < RELATIVE_LIMIT_DAYS * DAY_MS) return `${Math.floor(elapsed / DAY_MS)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export { manualResumeCommand };
