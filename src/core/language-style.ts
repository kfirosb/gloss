export const TRANSLATION_PROMPT_VERSION = 'v2-natural-hebrew-english-terms';
export const englishProductTerms = [
  'Live Conversation',
  'Language Assistant',
  'Copy code',
  'Send to Terminal',
  'Codex',
  'Claude Code',
  'code blocks',
  'code block',
  'Markdown',
  'Queue',
  'layout',
  'refresh',
  'Codex',
];
export const isHebrew = (language: string) => /^(he(?:-[a-z0-9]+)*|hebrew)$/i.test(language.trim());
export function languageStyle(language: string): string {
  if (!isHebrew(language)) return '';
  return [
    'Write natural, fluent Hebrew suitable for a professional software conversation. Translate meaning, not English word order.',
    'Keep professional technical terminology and product UI labels in English, exactly as they appear in the product. Do not translate or transliterate those labels.',
    `In particular retain these English terms: ${englishProductTerms.join(', ')}.`,
    'For example, express "size controls for the Queue" with natural Hebrew wording for "size controls for the", while retaining "Queue" in English.',
    'Use Hebrew for the surrounding explanation; do not leave entire sentences in English merely because they contain a technical term.',
    'Preserve Markdown structure, code blocks, inline code, links, identifiers, and literal placeholders exactly. Do not add glossaries or parenthetical translations unless requested.',
    'In prepared instructions this style applies only to localizedText; englishText follows deliveryLanguage (English when absent) and is not styled by this guidance.',
  ].join('\n');
}
