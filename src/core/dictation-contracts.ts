import { isSupportedLanguage, type LanguageCode } from './language-settings.js';

export type DictationLanguage = LanguageCode;
export const isDictationLanguage = isSupportedLanguage;
export const SAMPLE_RATE = 16_000;
export const FRAME_MS = 100;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 1600
export const MAX_RECORDING_MS = 600_000;
export const ENGINE_IDLE_MS = 180_000;
export const FINISH_TIMEOUT_MS = 5_000;
/** Largest WebSocket message the dictation bridge accepts; a capture frame is FRAME_SAMPLES 16-bit samples, far below it. */
export const MAX_AUDIO_MESSAGE_BYTES = 64 * 1024;
/** How much of the recording's transcribed text (from the end) is sent as the prompt for the next segment. */
export const PROMPT_CONTEXT_CHARS = 200;
/** Transcription errors in a row after which the recording ends with engine-failed; fewer are reported as a lost segment. */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** A transcription counts as silence when whisper rates every one of its segments above this no-speech probability. */
export const NO_SPEECH_PROBABILITY = 0.6;
export const MODEL_FILE = 'ggml-large-v3-turbo-q5_0.bin';
export type DictationErrorCode =
  | 'engine-missing'
  | 'microphone-denied'
  | 'download-failed'
  | 'engine-failed'
  | 'connection-lost'
  | 'busy';
export type DictationNoticeCode = 'segment-lost' | 'max-duration';
export type DictationServerMessage =
  | { type: 'state'; state: 'downloading'; received: number; total: number | null }
  | { type: 'state'; state: 'starting' | 'recording' | 'finished' }
  | { type: 'segment'; sequence: number; text: string }
  | { type: 'notice'; code: DictationNoticeCode }
  | { type: 'error'; code: DictationErrorCode; message: string };
export type DictationClientMessage = { type: 'stop' };
/** Why dictation is unavailable, as shown to the user; the engine's engine-missing failure carries the same text. */
export const DICTATION_REASON_TEXT: Record<'engine-missing' | 'microphone-denied', string> = {
  'engine-missing': 'Speech engine not built',
  'microphone-denied':
    'Microphone access denied. Enable Gloss under System Settings → Privacy & Security → Microphone',
};
export interface DictationStatus {
  available: boolean;
  reason?: 'engine-missing';
  model: { present: boolean; bytes?: number };
  engine: 'stopped' | 'starting' | 'running';
}
export class DictationFailure extends Error {
  constructor(
    readonly code: DictationErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'DictationFailure';
  }
}
/** Outputs whisper produces on near-silence; compared after trimming and stripping trailing punctuation. */
export const FILLER_OUTPUTS: Partial<Record<DictationLanguage, readonly string[]>> = {
  he: ['תודה רבה', 'תודה', 'כתוביות', 'תרגום', 'כתוביות על ידי'],
  en: ['thank you', 'thanks for watching', 'subtitles by', 'you', 'thank you for watching', 'bye'],
  ar: ['شكرا', 'شكرا لك', 'شكرا للمشاهدة', 'ترجمة نانسي قنقر'],
  fr: [
    'merci',
    'merci à tous',
    'merci d’avoir regardé cette vidéo',
    'sous-titres réalisés par la communauté d’amara.org',
    "sous-titres réalisés par la communauté d'amara.org",
  ],
  hi: ['धन्यवाद', 'शुक्रिया', 'देखने के लिए धन्यवाद'],
  zh: ['字幕由amara.org社区提供', '谢谢观看', '谢谢', '感谢观看', '请订阅我的频道'],
};
/** Prompt for the first request of a recording, which has no transcribed context yet; plain sentences that set the language and register. */
export const SEED_PROMPT: Partial<Record<DictationLanguage, string>> = {
  he: 'שיחה בעברית על עבודה עם קוד: הסבר קצר, שאלה, ובקשה.',
  en: 'A conversation in English about working with code: a short explanation, a question, and a request.',
  ar: 'محادثة بالعربية حول العمل مع الكود: شرح قصير، وسؤال، وطلب.',
  fr: 'Une conversation en français sur le travail avec du code : une courte explication, une question et une demande.',
  hi: 'कोड पर काम करने के बारे में हिंदी में बातचीत: एक छोटी व्याख्या, एक सवाल और एक अनुरोध।',
  zh: '关于代码开发的中文对话：简短的说明、一个问题和一个请求。',
};
/** Prompt for the next transcription request: the seed when nothing has been transcribed yet, otherwise the last PROMPT_CONTEXT_CHARS of context; none right after a repetitive segment, since feeding a loop back amplifies it. */
export function nextPrompt(
  context: string,
  skipPrompt: boolean,
  language: DictationLanguage,
): string | undefined {
  if (skipPrompt) return undefined;
  return context ? context.slice(-PROMPT_CONTEXT_CHARS) : SEED_PROMPT[language];
}
/** Longest run of the same word kept; whisper loops on repetitive speech. */
export const MAX_WORD_RUN = 3;
const TRAILING_PUNCTUATION = /[.!?,;:…׃。，？！、،؟।]+$/u;
const wordKey = (token: string) => token.replace(TRAILING_PUNCTUATION, '').toLowerCase();
/** Scripts written without spaces between words (Chinese, Japanese): a whisper loop there stays inside one space-free token, so it is found as a repeating run of characters rather than of words. */
const UNSPACED_SCRIPT = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u;
/** Longest repeating unit looked for, in characters; covers a looped sentence such as "ご視聴ありがとうございました" (14). */
const MAX_LOOP_UNIT_CHARS = 32;
/** Copies of a one-character unit kept: a word may be one doubled character (谢谢, ここ), so six characters are three such words. Longer units keep MAX_WORD_RUN copies, like words. */
const MAX_CHAR_RUN = MAX_WORD_RUN * 2;
const maxCopies = (unitLength: number) => (unitLength === 1 ? MAX_CHAR_RUN : MAX_WORD_RUN);
function copiesAt(chars: readonly string[], start: number, length: number): number {
  let copies = 1;
  for (let next = start + length; next + length <= chars.length; next += length) {
    for (let k = 0; k < length; k++) if (chars[next + k] !== chars[start + k]) return copies;
    copies++;
  }
  return copies;
}
/** The shortest unit starting at `start` that contains an unspaced-script character and repeats at least `minCopies(length)` times back to back. */
function loopAt(
  chars: readonly string[],
  start: number,
  minCopies: (unitLength: number) => number,
): { length: number; copies: number } | undefined {
  for (let length = 1; length <= MAX_LOOP_UNIT_CHARS; length++) {
    if (start + length * minCopies(length) > chars.length) continue;
    const unit = chars.slice(start, start + length);
    if (!unit.some((c) => UNSPACED_SCRIPT.test(c))) continue;
    const copies = copiesAt(chars, start, length);
    if (copies >= minCopies(length)) return { length, copies };
  }
  return undefined;
}
/** Collapses a character-level loop inside one space-free token to its first maxCopies units; tokens without unspaced-script characters are returned unchanged. */
function collapseUnspacedLoops(token: string): string {
  if (!UNSPACED_SCRIPT.test(token)) return token;
  const chars = Array.from(token);
  const out: string[] = [];
  for (let i = 0; i < chars.length;) {
    const loop = loopAt(chars, i, (length) => maxCopies(length) + 1);
    if (!loop) {
      out.push(chars[i] ?? '');
      i++;
      continue;
    }
    out.push(...chars.slice(i, i + loop.length * maxCopies(loop.length)));
    i += loop.length * loop.copies;
  }
  return out.join('');
}
function hasUnspacedLoop(token: string): boolean {
  if (!UNSPACED_SCRIPT.test(token)) return false;
  const chars = Array.from(token);
  return chars.some((_, i) => loopAt(chars, i, maxCopies) !== undefined);
}
/** Collapses any run of the same word (ignoring trailing punctuation and case) longer than MAX_WORD_RUN to its first MAX_WORD_RUN tokens as written, and any character-level loop inside an unspaced-script token the same way. */
function collapseRuns(text: string): string {
  const out: string[] = [];
  let previous = '';
  let run = 0;
  for (const written of text.split(' ')) {
    const token = collapseUnspacedLoops(written);
    const key = wordKey(token);
    run = key && key === previous ? run + 1 : 1;
    previous = key;
    if (run <= MAX_WORD_RUN) out.push(token);
  }
  return out.join(' ');
}
/** True when a transcription looks like a whisper loop: three identical consecutive words, one word making up at least 60 % of three or more words, or, in an unspaced-script token, a unit repeated as often as collapseRuns keeps it. */
export function isRepetitive(text: string): boolean {
  const tokens = text.split(/\s+/);
  if (tokens.some(hasUnspacedLoop)) return true;
  const words = tokens.map(wordKey).filter(Boolean);
  if (words.length < 3) return false;
  for (let i = 2; i < words.length; i++)
    if (words[i] === words[i - 1] && words[i] === words[i - 2]) return true;
  const counts = new Map<string, number>();
  let top = 0;
  for (const w of words) {
    const n = (counts.get(w) ?? 0) + 1;
    counts.set(w, n);
    top = Math.max(top, n);
  }
  return top / words.length >= 0.6;
}
/** Returns the text to append, or null when the result should be dropped. */
export function acceptTranscription(
  text: string,
  noSpeech: boolean,
  language: DictationLanguage,
): string | null {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (noSpeech || !trimmed) return null;
  const collapsed = collapseRuns(trimmed);
  if (!collapsed) return null;
  const bare = collapsed.replace(TRAILING_PUNCTUATION, '').trim().toLowerCase();
  if ((FILLER_OUTPUTS[language] ?? []).some((f) => f.toLowerCase() === bare)) return null;
  return collapsed;
}
