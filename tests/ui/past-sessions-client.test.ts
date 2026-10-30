import { afterEach, expect, it, vi } from 'vitest';
import { listPastSessions, reopenPastSession, relativeTime } from '../../src/ui/past-sessions.js';

afterEach(() => vi.unstubAllGlobals());

it('requests the folder listing and posts only agent, id and folder', async () => {
  const calls: [string, RequestInit | undefined][] = [];
  vi.stubGlobal('location', { hash: '#capability=cap' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response('{"folder":"/p","entries":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  await listPastSessions('/p q');
  await reopenPastSession({ agent: 'codex', sessionRef: 'T' }, '/p');
  expect(calls[0]![0]).toContain('/api/past-sessions?folder=%2Fp%20q');
  expect(calls[1]![0]).toContain('/api/launches/resume');
  expect(JSON.parse(String(calls[1]![1]?.body))).toEqual({
    agent: 'codex',
    sessionRef: 'T',
    folder: '/p',
  });
});

it('formats relative time', () => {
  const now = Date.UTC(2026, 9, 30, 12);
  expect(relativeTime(new Date(now - 30_000).toISOString(), now)).toBe('just now');
  expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5 min ago');
  expect(relativeTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe('3 h ago');
  expect(relativeTime(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe('2 d ago');
  expect(relativeTime(new Date(now - 40 * 86_400_000).toISOString(), now)).toMatch(/2026/);
});
