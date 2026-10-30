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
it('sorts entries without a time after dated ones and drops them first at the cap', () => {
  const dated = Array.from({ length: 9 }, (_, i) => ({
    agent: 'codex' as const,
    sessionRef: `d${i}`,
    lastActiveAt: 100 + i,
  }));
  const undated = ['u1', 'u2'].map((sessionRef) => ({ agent: 'claude' as const, sessionRef }));
  const out = mergePastSessions([undated[0]!, ...dated, undated[1]!], new Set(), closed);
  expect(out).toHaveLength(10);
  expect(out.slice(0, 9).map((e) => e.sessionRef)).toEqual(
    dated.map((d) => d.sessionRef).reverse(),
  );
  expect(out[9]?.sessionRef).toBe('u1');
  expect(out[9]).not.toHaveProperty('lastActiveAt');
});
it('dedupes keeping the defined time when only one duplicate has one', () => {
  const out = mergePastSessions(
    [
      { agent: 'claude', sessionRef: 'c', panelSessionId: 'P' },
      { agent: 'claude', sessionRef: 'c', lastActiveAt: 7 },
    ],
    new Set(),
    closed,
  );
  expect(out).toEqual([
    expect.objectContaining({ panelSessionId: 'P', lastActiveAt: new Date(7).toISOString() }),
  ]);
  const unknown = mergePastSessions(
    [
      { agent: 'claude', sessionRef: 'c', panelSessionId: 'P' },
      { agent: 'claude', sessionRef: 'c' },
    ],
    new Set(),
    closed,
  );
  expect(unknown[0]).not.toHaveProperty('lastActiveAt');
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
  expect(pastSessionTitle({ agent: 'claude' })).toBe('Claude Code');
  expect(pastSessionTitle({ agent: 'codex', title: '  ' })).toBe('Codex');
});
it('builds the manual resume command per agent with a quoted folder', () => {
  expect(manualResumeCommand('claude', 'ID', "/p/it's")).toEqual({
    command: 'claude --resume ID',
    cdCommand: expect.stringMatching(/^cd '.*' && claude --resume ID$/),
  });
  expect(manualResumeCommand('codex', 'ID', '/p').command).toBe('codex resume ID');
});
