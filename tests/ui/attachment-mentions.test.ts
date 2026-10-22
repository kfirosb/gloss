import { expect, it } from 'vitest';
import {
  insertAttachmentMentions,
  removeAttachmentMention,
} from '../../src/ui/attachment-mentions.js';
import { REFERENCE_MARK } from '../../src/ui/session-client.js';

const image = (index: number) => ({ kind: 'image' as const, index });
const file = (index: number) => ({ kind: 'file' as const, index });
const M = REFERENCE_MARK;

it('inserts the reference at the caret with one space on each side', () => {
  expect(insertAttachmentMentions('see here', { start: 3, end: 3 }, [image(3)])).toEqual({
    text: `see ${M}@Image 3 here`,
    caret: `see ${M}@Image 3`.length,
  });
  expect(insertAttachmentMentions('see', { start: 3, end: 3 }, [file(2)])).toEqual({
    text: `see ${M}@File 2 `,
    caret: `see ${M}@File 2 `.length,
  });
  expect(insertAttachmentMentions('', { start: 0, end: 0 }, [image(1), file(4)]).text).toBe(
    `${M}@Image 1 ${M}@File 4 `,
  );
});

it('replaces a selection and keeps a Hebrew sentence readable around the reference', () => {
  const sentence = 'תסתכל על XX ותקן';
  const start = sentence.indexOf('XX');
  const { text } = insertAttachmentMentions(sentence, { start, end: start + 2 }, [image(3)]);
  expect(text).toBe(`תסתכל על ${M}@Image 3 ותקן`);
  // The mark is a display aid only; the delivered text reads naturally.
  expect(text.replaceAll(M, '')).toBe('תסתכל על @Image 3 ותקן');
});

it('does not repeat a reference the text already has', () => {
  const text = `see ${M}@Image 3 now`;
  expect(insertAttachmentMentions(text, { start: 0, end: 0 }, [image(3)]).text).toBe(text);
  expect(insertAttachmentMentions('see @Image 31', { start: 0, end: 0 }, [image(3)]).text).toBe(
    `${M}@Image 3 see @Image 31`,
  );
});

it('removes only the removed attachment reference with its trailing space', () => {
  const text = `see ${M}@Image 3 and @Image 31 and ${M}@File 3 `;
  expect(removeAttachmentMention(text, image(3))).toBe(`see and @Image 31 and ${M}@File 3 `);
  expect(removeAttachmentMention(text, file(3))).toBe(`see ${M}@Image 3 and @Image 31 and `);
});
