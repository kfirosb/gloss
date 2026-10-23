import {
  ATTACHMENT_MENTION_SOURCE,
  attachmentMention,
  type FileReference,
} from '../core/file-references.js';
import { REFERENCE_MARK } from './session-client.js';

type Mentionable = Pick<FileReference, 'kind' | 'index'>;
export interface TextRange {
  start: number;
  end: number;
}

const mentionsIn = (text: string) =>
  new Set(Array.from(text.matchAll(new RegExp(ATTACHMENT_MENTION_SOURCE, 'g')), (m) => m[0]));

/**
 * Writes "@Image 3"-style references for `files` in place of `range`. Indexes are the session's stable attachment
 * numbers, so the text and the References block agree however attachments are later removed. Each reference is
 * preceded by REFERENCE_MARK so it reads left to right inside an RTL sentence, and is set apart from neighbouring
 * words by one space. A reference the text already contains is not repeated.
 */
export function insertAttachmentMentions(
  text: string,
  range: TextRange,
  files: readonly Mentionable[],
): { text: string; caret: number } {
  const present = mentionsIn(text);
  const mentions = [...new Set(files.map(attachmentMention))].filter((m) => !present.has(m));
  if (!mentions.length) return { text, caret: range.end };
  const before = text.slice(0, range.start);
  const after = text.slice(range.end);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after.startsWith(' ') ? '' : ' ';
  const insert = lead + mentions.map((m) => REFERENCE_MARK + m).join(' ') + trail;
  return { text: before + insert + after, caret: before.length + insert.length };
}

/** Removes every reference to a removed attachment, with the space that followed it, so no reference dangles. */
export function removeAttachmentMention(text: string, file: Mentionable): string {
  return text.replace(
    new RegExp(REFERENCE_MARK + '?' + attachmentMention(file) + '(?!\\d) ?', 'g'),
    '',
  );
}
