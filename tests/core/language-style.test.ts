import { describe, expect, it } from 'vitest';
import { TRANSLATION_PROMPT_VERSION, languageStyle } from '../../src/core/language-style.js';

const HEBREW_STYLE = [
  'Write natural, fluent Hebrew suitable for a professional software conversation. Translate meaning, not English word order.',
  'Keep professional technical terminology and product UI labels in English, exactly as they appear in the product. Do not translate or transliterate those labels.',
  'In particular retain these English terms: Live Conversation, Language Assistant, Copy code, Send to Terminal, Codex, Claude Code, code blocks, code block, Markdown, Queue, layout, refresh, Codex.',
  'For example, express "size controls for the Queue" with natural Hebrew wording for "size controls for the", while retaining "Queue" in English.',
  'Use Hebrew for the surrounding explanation; do not leave entire sentences in English merely because they contain a technical term.',
  'Preserve Markdown structure, code blocks, inline code, links, identifiers, and literal placeholders exactly. Do not add glossaries or parenthetical translations unless requested.',
  'In prepared instructions this style applies only to localizedText; englishText follows deliveryLanguage (English when absent) and is not styled by this guidance.',
].join('\n');

describe('language style', () => {
  it('Hebrew style text is unchanged for code and name', () => {
    expect(languageStyle('he')).toBe(HEBREW_STYLE);
    expect(languageStyle('Hebrew')).toBe(HEBREW_STYLE);
    expect(TRANSLATION_PROMPT_VERSION).toBe('v2-natural-hebrew-english-terms');
  });

  it('other languages get the same guidance with their name; English and unknown get none', () => {
    const fr = languageStyle('French');
    expect(fr).toContain('Write natural, fluent French');
    expect(fr).toContain('Use French for the surrounding explanation');
    expect(fr).not.toContain('Hebrew');
    expect(languageStyle('Chinese (Simplified)')).toContain('fluent Chinese (Simplified)');
    expect(languageStyle('en')).toBe('');
    expect(languageStyle('xx')).toBe('');
  });
});
