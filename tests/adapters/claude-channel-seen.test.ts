import { expect, it } from 'vitest';
import { parseClaudeRecord } from '../../src/agents/claude/index.js';

const wrap = (id: string) =>
  `<channel source="language-assistant" request_id="${id}">\nQuestion\n</channel>`;
it('reports a channel message delivered while Claude was idle, by its delivery id', () => {
  const record = {
    type: 'user',
    uuid: 'u1',
    sessionId: 's',
    isMeta: true,
    origin: { kind: 'channel', server: 'language-assistant' },
    message: { content: wrap('delivery-aaa') },
  };
  expect(parseClaudeRecord(record, 0, 's')).toEqual({ channelSeen: 'delivery-aaa' });
});
it('reports a channel message queued into a running turn', () => {
  const record = {
    type: 'attachment',
    uuid: 'a1',
    sessionId: 's',
    attachment: {
      type: 'queued_command',
      prompt: wrap('delivery-bbb'),
      origin: { kind: 'channel', server: 'language-assistant' },
    },
  };
  expect(parseClaudeRecord(record, 0, 's')).toEqual({ channelSeen: 'delivery-bbb' });
});
it('ignores other channel servers, other origins and text without a request id', () => {
  const user = (origin: object, content: string) => ({
    type: 'user',
    uuid: 'u',
    sessionId: 's',
    isMeta: true,
    origin,
    message: { content },
  });
  expect(
    parseClaudeRecord(user({ kind: 'channel', server: 'other' }, wrap('delivery-x')), 0, 's'),
  ).toEqual({});
  expect(parseClaudeRecord(user({ kind: 'human' }, wrap('delivery-x')), 0, 's')).toEqual({});
  expect(
    parseClaudeRecord(
      user({ kind: 'channel', server: 'language-assistant' }, '<channel>no id</channel>'),
      0,
      's',
    ),
  ).toEqual({});
  expect(
    parseClaudeRecord(
      {
        type: 'attachment',
        sessionId: 's',
        attachment: {
          type: 'queued_command',
          prompt: wrap('delivery-y'),
          origin: { kind: 'human' },
        },
      },
      0,
      's',
    ),
  ).toEqual({});
});

it('reports channel messages from the renamed gloss server and the legacy name alike', () => {
  const user = (server: string, id: string) => ({
    type: 'user',
    uuid: 'u',
    sessionId: 's',
    isMeta: true,
    origin: { kind: 'channel', server },
    message: { content: `<channel source="${server}" request_id="${id}">\nQuestion\n</channel>` },
  });
  expect(parseClaudeRecord(user('gloss', 'delivery-new'), 0, 's')).toEqual({
    channelSeen: 'delivery-new',
  });
  expect(parseClaudeRecord(user('language-assistant', 'delivery-old'), 0, 's')).toEqual({
    channelSeen: 'delivery-old',
  });
  expect(parseClaudeRecord(user('glossary', 'delivery-x'), 0, 's')).toEqual({});
  // Both names are Gloss's own, so the source attribute need not repeat the origin's name.
  expect(
    parseClaudeRecord(
      { ...user('gloss', 'delivery-y'), origin: { kind: 'channel', server: 'language-assistant' } },
      0,
      's',
    ),
  ).toEqual({ channelSeen: 'delivery-y' });
  // A source attribute naming another server is not a Gloss delivery.
  expect(
    parseClaudeRecord(
      { ...user('glossary', 'delivery-z'), origin: { kind: 'channel', server: 'gloss' } },
      0,
      's',
    ),
  ).toEqual({});
});
