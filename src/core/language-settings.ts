import { isHebrew } from './language-style.js';

export type LanguageCode = string;
export interface LanguageSettings { write: LanguageCode; send: LanguageCode; reply: LanguageCode; assist: LanguageCode }
export type LanguageOverride = Partial<LanguageSettings>;
export const LANGUAGE_FIELDS = ['write', 'send', 'reply', 'assist'] as const satisfies readonly (keyof LanguageSettings)[];
export const SUPPORTED_LANGUAGES = ['he', 'en'] as const;
export const INITIAL_LANGUAGE_DEFAULTS: LanguageSettings = Object.freeze({ write: 'he', send: 'en', reply: 'he', assist: 'he' });

const invalid = () => new Error('Invalid language settings');
const supported = (value: unknown): value is LanguageCode => typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
export function validateLanguageSettings(value: unknown): LanguageSettings {
  const input = record(value);
  const result = {} as LanguageSettings;
  for (const field of LANGUAGE_FIELDS) { if (!supported(input[field])) throw invalid(); result[field] = input[field] as LanguageCode; }
  return result;
}
export function validateLanguageOverride(value: unknown): LanguageOverride {
  const input = record(value);
  const result: LanguageOverride = {};
  for (const field of LANGUAGE_FIELDS) {
    if (input[field] === undefined) continue;
    if (!supported(input[field])) throw invalid();
    result[field] = input[field] as LanguageCode;
  }
  return result;
}
export interface LanguageSettingsStore {
  readLanguageDefaults(): LanguageSettings;
  writeLanguageDefaults(settings: LanguageSettings): void;
  readLanguageOverride(sessionId: string): LanguageOverride;
  writeLanguageOverride(sessionId: string, override: LanguageOverride | null): void;
}
export const effectiveLanguageSettings = (defaults: LanguageSettings, override: LanguageOverride = {}): LanguageSettings => ({ ...defaults, ...override });
export function legacyLanguageSettings(language: string): LanguageSettings {
  const code = isHebrew(language) ? 'he' : 'en';
  return { write: code, send: 'en', reply: code, assist: code };
}
export const needsReplyTranslation = (s: LanguageSettings) => s.reply !== 'en';
export const needsSendTranslation = (s: LanguageSettings) => s.write !== s.send;
export const languageName = (code: LanguageCode) => isHebrew(code) ? 'Hebrew' : 'English';
export const languageDirection = (code: LanguageCode): 'rtl' | 'ltr' => isHebrew(code) ? 'rtl' : 'ltr';
export const languageShortCode = (s: LanguageSettings) => [s.write, s.send, s.reply].map(code => code.toUpperCase()).join('→');
