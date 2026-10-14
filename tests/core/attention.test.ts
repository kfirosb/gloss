import { expect, it } from 'vitest';
import { attentionFor, latestResponseSequence } from '../../src/core/attention.js';
import type { AgentMessage } from '../../src/core/contracts.js';

const msg = (revision: number, role: 'user' | 'assistant', complete: boolean): AgentMessage => ({ sourceId: 'm' + revision, revision, role, text: 't', complete });

it('latestResponseSequence takes the newest completed assistant message only', () => {
  expect(latestResponseSequence([])).toBeUndefined();
  expect(latestResponseSequence([msg(1, 'user', true)])).toBeUndefined();
  expect(latestResponseSequence([msg(1, 'assistant', true), msg(5, 'assistant', false), msg(3, 'assistant', true), msg(9, 'user', true)])).toBe(3);
});

it('latestResponseSequence ignores Claude channel replies, whose revisions are not byte offsets', () => {
  const channel: AgentMessage = { sourceId: 'channel:r1', revision: 9_000_000, role: 'assistant', text: 't', complete: true };
  expect(latestResponseSequence([channel])).toBeUndefined();
  expect(latestResponseSequence([msg(3, 'assistant', true), channel, msg(8, 'assistant', true)])).toBe(8);
});

it('attentionFor: approval wins, unseen response counts, seen or closed is none', () => {
  expect(attentionFor({ open: true, activity: 'approval-required', latestResponseSequence: 1 }, 1)).toBe('approval');
  expect(attentionFor({ open: true, activity: 'approval-required' }, undefined)).toBe('approval');
  expect(attentionFor({ open: true, activity: 'idle', latestResponseSequence: 4 }, 3)).toBe('response');
  expect(attentionFor({ open: true, activity: 'working', latestResponseSequence: 4 }, undefined)).toBe('response');
  expect(attentionFor({ open: true, activity: 'idle', latestResponseSequence: 4 }, 4)).toBe('none');
  expect(attentionFor({ open: true, activity: 'idle', latestResponseSequence: 4 }, 9)).toBe('none');
  expect(attentionFor({ open: true, activity: 'idle' }, undefined)).toBe('none');
  expect(attentionFor({ open: false, activity: 'disconnected', latestResponseSequence: 4 }, undefined)).toBe('none');
  expect(attentionFor({ open: true, activity: 'disconnected', latestResponseSequence: 4 }, undefined)).toBe('none');
});
