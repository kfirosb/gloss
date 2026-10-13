export type DictationLanguage = 'he' | 'en';
export const DICTATION_LANGUAGES: readonly DictationLanguage[] = ['he', 'en'];
export const isDictationLanguage = (v: unknown): v is DictationLanguage => typeof v === 'string' && (DICTATION_LANGUAGES as readonly string[]).includes(v);
export const SAMPLE_RATE = 16_000;
export const FRAME_MS = 100;
export const FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS / 1000; // 1600
export const MAX_RECORDING_MS = 600_000;
export const ENGINE_IDLE_MS = 180_000;
export const FINISH_TIMEOUT_MS = 5_000;
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
export interface DictationStatus { available: boolean; reason?: 'engine-missing'; model: { present: boolean; bytes?: number }; engine: 'stopped' | 'starting' | 'running' }
export class DictationFailure extends Error { constructor(readonly code: DictationErrorCode, message?: string) { super(message ?? code); this.name = 'DictationFailure'; } }
/** Outputs whisper produces on near-silence; compared after trimming and stripping trailing punctuation. */
export const FILLER_OUTPUTS: Record<DictationLanguage, readonly string[]> = {
  he: ['תודה רבה', 'תודה', 'כתוביות', 'תרגום', 'כתוביות על ידי'],
  en: ['thank you', 'thanks for watching', 'subtitles by', 'you', 'thank you for watching', 'bye'],
};
/** Returns the text to append, or null when the result should be dropped. */
export function acceptTranscription(text: string, noSpeech: boolean, language: DictationLanguage): string | null {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (noSpeech || !trimmed) return null;
  const bare = trimmed.replace(/[.!?,;:…׃]+$/u, '').trim().toLowerCase();
  if (FILLER_OUTPUTS[language].some(f => f.toLowerCase() === bare)) return null;
  return trimmed;
}
