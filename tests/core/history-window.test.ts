import { describe, expect, it } from 'vitest';
import { recentMessages } from '../../src/ui/history.js';
describe('recent coding history window', () => {
  const mixed = [
    { sourceId: 'native', revision: 21000, role: 'assistant' as const, text: 'READY', complete: true, timestamp: '2026-10-07T20:33:00Z' },
    { sourceId: 'channel:g:reply', revision: 2, role: 'assistant' as const, text: 'reply', complete: true, timestamp: '2026-10-07T20:34:00Z' },
    { sourceId: 'channel:g:reply', revision: 1, role: 'assistant' as const, text: 'stale', complete: true, timestamp: '2026-10-07T20:34:00Z' },
  ];
  it('keeps mixed Claude history chronological after source deduplication', () => {
    expect(recentMessages(mixed, 10, 'claude').map(message => message.text)).toEqual(['READY', 'reply']);
    expect(recentMessages(mixed, 1, 'claude').map(message => message.text)).toEqual(['reply']);
    expect(mixed.map(message => message.text)).toEqual(['READY', 'reply', 'stale']);
  });
  it('retains Codex revision ordering even when timestamps disagree', () => {
    expect(recentMessages(mixed, 10, 'codex').map(message => message.text)).toEqual(['reply', 'READY']);
    expect(recentMessages(mixed, 1, 'codex').map(message => message.text)).toEqual(['READY']);
  });
  it('sorts oldest-to-newest and retains exactly ten newest messages', () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({ sourceId: String(index), revision: 12 - index, role: 'assistant' as const, text: String(index), complete: true }));
    expect(recentMessages(messages).map(message => message.sourceId)).toEqual(['9', '8', '7', '6', '5', '4', '3', '2', '1', '0']);
  });
});
