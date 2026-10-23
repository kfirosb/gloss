import { describe, expect, it } from 'vitest';
import type { AgentMessage, Delivery, Target } from '../../src/core/contracts.js';
import { writtenOriginals } from '../../src/core/user-originals.js';

const target: Target = { agent: 'claude', sessionRef: 'session-1', projectId: '/project' };
const written = { language: 'he', text: 'תקן את הבדיקה' };
const user = (sourceId: string, extra: Partial<AgentMessage> = {}): AgentMessage => ({
  sourceId,
  revision: 1,
  role: 'user',
  text: 'Fix the test',
  complete: true,
  ...extra,
});
const typed = (extra: Partial<Delivery> = {}): Delivery => ({
  id: 'delivery-1',
  draftId: 'composer-request-1',
  revision: 1,
  target,
  englishText: 'Fix the test',
  state: 'sent',
  transport: 'tmux',
  nativeMessageId: 'transcript:record-1',
  written,
  ...extra,
});
const without = (key: 'nativeMessageId' | 'written' | 'transport', delivery = typed()) => {
  const copy = { ...delivery };
  delete copy[key];
  return copy;
};
const peer = (extra: Partial<Delivery> = {}): Delivery =>
  typed({ transport: 'peer', nativeMessageId: 'a1b2c3d4', ...extra });

describe('writtenOriginals', () => {
  it('matches a terminal send to the transcript record its evidence names', () => {
    const originals = writtenOriginals([user('record-0'), user('record-1')], [typed()], target);
    expect([...originals]).toEqual([['record-1', written]]);
  });

  it('matches a peer send by its tag or by the full request id older Claude records', () => {
    expect(
      writtenOriginals([user('record-1', { clientId: 'a1b2c3d4' })], [peer()], target).get(
        'record-1',
      ),
    ).toEqual(written);
    expect(
      writtenOriginals([user('record-1', { clientId: 'delivery-1' })], [peer()], target).get(
        'record-1',
      ),
    ).toEqual(written);
  });

  it('matches nothing without exact settled evidence for this session', () => {
    const messages = [user('record-1', { clientId: 'a1b2c3d4' })];
    const unmatched: Delivery[][] = [
      [typed({ state: 'unconfirmed' })],
      [typed({ state: 'queued' })],
      [without('nativeMessageId')],
      [typed({ nativeMessageId: 'record-1' })],
      [without('written')],
      [typed({ written: { language: 'he', text: '  ' } })],
      // Written in the send language: nothing to add beside the message.
      [typed({ written: { language: 'en', text: 'Fix the test' } })],
      [typed({ target: { ...target, sessionRef: 'session-2' } })],
      // Channel messages are not transcript user messages; Codex receipts differ from its accepted ids.
      [typed({ transport: 'channel', nativeMessageId: 'a1b2c3d4' })],
      [without('transport', typed({ nativeMessageId: 'a1b2c3d4' }))],
    ];
    for (const deliveries of unmatched)
      expect(writtenOriginals(messages, deliveries, target).size).toBe(0);
    expect(writtenOriginals(messages, [typed()], undefined).size).toBe(0);
  });

  it('never names an assistant message', () => {
    const reply: AgentMessage = { ...user('record-1'), role: 'assistant' };
    expect(writtenOriginals([reply], [typed()], target).size).toBe(0);
  });

  it('leaves ambiguous evidence unmatched', () => {
    // One peer tag carried by two user records.
    expect(
      writtenOriginals(
        [user('record-1', { clientId: 'a1b2c3d4' }), user('record-2', { clientId: 'a1b2c3d4' })],
        [peer()],
        target,
      ).size,
    ).toBe(0);
    // A peer send whose full id and tag name different records.
    expect(
      writtenOriginals(
        [user('record-1', { clientId: 'a1b2c3d4' }), user('record-2', { clientId: 'delivery-1' })],
        [peer()],
        target,
      ).size,
    ).toBe(0);
    // Two sends naming the same record.
    const other = typed({ id: 'delivery-2', draftId: 'composer-request-2' });
    expect(writtenOriginals([user('record-1')], [typed(), other], target).size).toBe(0);
  });
});
