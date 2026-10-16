import { expect, it } from 'vitest';
import {
  DESKTOP_REASON,
  NO_ROUTE_REASON,
  selectClaudeRoute,
} from '../../src/agents/claude/route.js';

it('picks exactly one route in order: Gloss terminal, channel, peer', () => {
  const all = { glossTerminal: true, channel: true, peer: true };
  expect(selectClaudeRoute({ entrypoint: 'cli', ...all })).toEqual({ transport: 'tmux' });
  expect(selectClaudeRoute({ ...all, glossTerminal: false })).toEqual({ transport: 'channel' });
  expect(selectClaudeRoute({ glossTerminal: false, channel: false, peer: true })).toEqual({
    transport: 'peer',
  });
  expect(selectClaudeRoute({ glossTerminal: false, channel: false, peer: false })).toEqual({
    transport: null,
    reason: NO_ROUTE_REASON,
  });
});
it('never offers a Claude Desktop session as a destination', () => {
  expect(
    selectClaudeRoute({
      entrypoint: 'claude-desktop',
      glossTerminal: true,
      channel: true,
      peer: true,
    }),
  ).toEqual({ transport: null, reason: DESKTOP_REASON });
});
it('keeps a session Gloss launched with the old channel flags on its terminal', () => {
  expect(selectClaudeRoute({ glossTerminal: true, channel: true, peer: false })).toEqual({
    transport: 'tmux',
  });
});
