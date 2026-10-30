import { expect, it } from 'vitest';
import {
  mergePastSessions,
  pastSessionTitle,
  manualResumeCommand,
  pastSessionKey,
} from '../../src/core/past-sessions.js';
import { PAST_SESSIONS_LIMIT } from '../../src/core/launch-settings.js';

const closed = () => 'closed' as const;
it('caps at PAST_SESSIONS_LIMIT most recent, newest first', () => {
  const sources = Array.from({ length: 13 }, (_, i) => ({
    agent: 'claude' as const,
    sessionRef: `s${i}`,
    lastActiveAt: 1000 + i,
  }));
  const out = mergePastSessions(sources, new Set(), closed);
  expect(PAST_SESSIONS_LIMIT).toBe(10);
  expect(out).toHaveLength(10);
  expect(out.map((e) => e.sessionRef)).toEqual([
    's12',
    's11',
    's10',
    's9',
    's8',
    's7',
    's6',
    's5',
    's4',
    's3',
  ]);
});
it('dedupes by agent and id, keeping the panel id, the Gloss title and the latest time', () => {
  const out = mergePastSessions(
    [
      { agent: 'codex', sessionRef: 't1', lastActiveAt: 5, title: 'Thread title' },
      {
        agent: 'codex',
        sessionRef: 't1',
        lastActiveAt: 3,
        title: 'Gloss title',
        panelSessionId: 'P1',
      },
      { agent: 'claude', sessionRef: 't1', lastActiveAt: 4 },
    ],
    new Set(),
    closed,
  );
  expect(out).toHaveLength(2);
  expect(out[0]).toMatchObject({
    agent: 'codex',
    sessionRef: 't1',
    panelSessionId: 'P1',
    title: 'Gloss title',
    lastActiveAt: new Date(5).toISOString(),
  });
});
it('skips hidden conversations and asks for each state', () => {
  const out = mergePastSessions(
    [
      { agent: 'claude', sessionRef: 'a', lastActiveAt: 1 },
      { agent: 'claude', sessionRef: 'b', lastActiveAt: 2 },
    ],
    new Set([pastSessionKey('claude', 'a')]),
    (_agent, ref) => (ref === 'b' ? 'open-outside' : 'closed'),
  );
  expect(out).toEqual([expect.objectContaining({ sessionRef: 'b', state: 'open-outside' })]);
});
it('titles fall back to the agent and the date, and are normalized', () => {
  expect(pastSessionTitle({ agent: 'codex', lastActiveAt: Date.UTC(2026, 9, 30) })).toMatch(
    /^Codex · /,
  );
  expect(pastSessionTitle({ agent: 'claude', title: ' hi\x00 there ', lastActiveAt: 0 })).toBe(
    'hi there',
  );
});
it('builds the manual resume command per agent with a quoted folder', () => {
  expect(manualResumeCommand('claude', 'ID', "/p/it's")).toEqual({
    command: 'claude --resume ID',
    cdCommand: expect.stringMatching(/^cd '.*' && claude --resume ID$/),
  });
  expect(manualResumeCommand('codex', 'ID', '/p').command).toBe('codex resume ID');
});
