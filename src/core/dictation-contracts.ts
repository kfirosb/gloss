export type DictationLanguage = 'he' | 'en';
export const DICTATION_LANGUAGES: readonly DictationLanguage[] = ['he', 'en'];
export const isDictationLanguage = (v: unknown): v is DictationLanguage => typeof v === 'string' && (DICTATION_LANGUAGES as readonly string[]).includes(v);
export const SAMPLE_RATE = 16_000;
export const FRAME_MS = 100;
export const FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS / 1000; // 1600
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
export type DictationErrorCode = 'engine-missing' | 'microphone-denied' | 'download-failed' | 'engine-failed' | 'connection-lost' | 'busy';
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
  'microphone-denied': 'Microphone access denied. Enable Gloss under System Settings → Privacy & Security → Microphone',
};
export interface DictationStatus { available: boolean; reason?: 'engine-missing'; model: { present: boolean; bytes?: number }; engine: 'stopped' | 'starting' | 'running' }
export class DictationFailure extends Error { constructor(readonly code: DictationErrorCode, message?: string) { super(message ?? code); this.name = 'DictationFailure'; } }
/** Outputs whisper produces on near-silence; compared after trimming and stripping trailing punctuation. */
export const FILLER_OUTPUTS: Record<DictationLanguage, readonly string[]> = {
  he: ['תודה רבה', 'תודה', 'כתוביות', 'תרגום', 'כתוביות על ידי'],
  en: ['thank you', 'thanks for watching', 'subtitles by', 'you', 'thank you for watching', 'bye'],
};
/** Prompt for the first request of a recording, which has no transcribed context yet; plain sentences that set the language and register. */
export const SEED_PROMPT: Record<DictationLanguage, string> = {
  he: 'שיחה בעברית על עבודה עם קוד: הסבר קצר, שאלה, ובקשה.',
  en: 'A conversation in English about working with code: a short explanation, a question, and a request.',
};
/** Prompt for the next transcription request: the seed when nothing has been transcribed yet, otherwise the last PROMPT_CONTEXT_CHARS of context; none right after a repetitive segment, since feeding a loop back amplifies it. */
export function nextPrompt(context: string, skipPrompt: boolean, language: DictationLanguage): string | undefined {
  if (skipPrompt) return undefined;
  return context ? context.slice(-PROMPT_CONTEXT_CHARS) : SEED_PROMPT[language];
}
/** Longest run of the same word kept; whisper loops on repetitive speech. */
export const MAX_WORD_RUN = 3;
const TRAILING_PUNCTUATION = /[.!?,;:…׃]+$/u;
const wordKey = (token: string) => token.replace(TRAILING_PUNCTUATION, '').toLowerCase();
/** Collapses any run of the same word (ignoring trailing punctuation and case) longer than MAX_WORD_RUN to its first MAX_WORD_RUN tokens as written. */
function collapseRuns(text: string): string {
  const out: string[] = []; let previous = ''; let run = 0;
  for (const token of text.split(' ')) {
    const key = wordKey(token);
    run = key && key === previous ? run + 1 : 1; previous = key;
    if (run <= MAX_WORD_RUN) out.push(token);
  }
  return out.join(' ');
}
/** True when a transcription looks like a whisper loop: three identical consecutive words, or one word making up at least 60 % of three or more words. */
export function isRepetitive(text: string): boolean {
  const words = text.split(/\s+/).map(wordKey).filter(Boolean);
  if (words.length < 3) return false;
  for (let i = 2; i < words.length; i++) if (words[i] === words[i - 1] && words[i] === words[i - 2]) return true;
  const counts = new Map<string, number>(); let top = 0;
  for (const w of words) { const n = (counts.get(w) ?? 0) + 1; counts.set(w, n); top = Math.max(top, n); }
  return top / words.length >= 0.6;
}
/** Returns the text to append, or null when the result should be dropped. */
export function acceptTranscription(text: string, noSpeech: boolean, language: DictationLanguage): string | null {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (noSpeech || !trimmed) return null;
  const collapsed = collapseRuns(trimmed);
  if (!collapsed) return null;
  const bare = collapsed.replace(TRAILING_PUNCTUATION, '').trim().toLowerCase();
  if (FILLER_OUTPUTS[language].some(f => f.toLowerCase() === bare)) return null;
  return collapsed;
}
