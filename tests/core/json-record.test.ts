import { expect, it } from 'vitest';
import { recordOf, textBlocks } from '../../src/core/json-record.js';

it('narrows only JSON objects, not null, arrays or primitive values', () => {
  for (const value of [null, [], 'text', 42, false, undefined]) {
    expect(recordOf(value)).toBeUndefined();
  }
  expect(recordOf({ type: 'message' })).toEqual({ type: 'message' });
});

it('extracts text blocks without trusting unrelated or malformed content', () => {
  expect(
    textBlocks(
      [
        null,
        { type: 'image', text: 'not text' },
        { type: 'text', text: 42 },
        { type: 'text', text: 'first' },
        { type: 'Text', text: 'second' },
      ],
      ['text', 'Text'],
    ),
  ).toEqual(['first', 'second']);
  expect(textBlocks('not blocks')).toEqual([]);
});
