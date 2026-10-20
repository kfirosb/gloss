export type LanguageCode = string;
export interface LanguageSettings {
  write: LanguageCode;
  send: LanguageCode;
  reply: LanguageCode;
  assist: LanguageCode;
}
export type LanguageOverride = Partial<LanguageSettings>;
export const LANGUAGE_FIELDS = [
  'write',
  'send',
  'reply',
  'assist',
] as const satisfies readonly (keyof LanguageSettings)[];
export interface LanguageEntry {
  code: LanguageCode;
  name: string;
  direction: 'rtl' | 'ltr';
}
// Menu order: English, Hebrew, then alphabetical by name.
export const LANGUAGES: readonly LanguageEntry[] = [
  { code: 'en', name: 'English', direction: 'ltr' },
  { code: 'he', name: 'Hebrew', direction: 'rtl' },
  { code: 'ar', name: 'Arabic', direction: 'rtl' },
  { code: 'zh', name: 'Chinese (Simplified)', direction: 'ltr' },
  { code: 'nl', name: 'Dutch', direction: 'ltr' },
  { code: 'fr', name: 'French', direction: 'ltr' },
  { code: 'de', name: 'German', direction: 'ltr' },
  { code: 'hi', name: 'Hindi', direction: 'ltr' },
  { code: 'it', name: 'Italian', direction: 'ltr' },
  { code: 'ja', name: 'Japanese', direction: 'ltr' },
  { code: 'ko', name: 'Korean', direction: 'ltr' },
  { code: 'fa', name: 'Persian', direction: 'rtl' },
  { code: 'pl', name: 'Polish', direction: 'ltr' },
  { code: 'pt', name: 'Portuguese', direction: 'ltr' },
  { code: 'ru', name: 'Russian', direction: 'ltr' },
  { code: 'es', name: 'Spanish', direction: 'ltr' },
  { code: 'tr', name: 'Turkish', direction: 'ltr' },
  { code: 'uk', name: 'Ukrainian', direction: 'ltr' },
  { code: 'ur', name: 'Urdu', direction: 'rtl' },
];
export const SUPPORTED_LANGUAGES: readonly LanguageCode[] = LANGUAGES.map((l) => l.code);
export const INITIAL_LANGUAGE_DEFAULTS: LanguageSettings = Object.freeze({
  write: 'he',
  send: 'en',
  reply: 'he',
  assist: 'he',
});

const invalid = () => new Error('Invalid language settings');
export const isSupportedLanguage = (value: unknown): value is LanguageCode =>
  typeof value === 'string' && SUPPORTED_LANGUAGES.includes(value);
// Lenient lookup for display and legacy values; strict validation uses isSupportedLanguage.
export function resolveLanguage(value: string): LanguageEntry | undefined {
  const text = value.trim().toLowerCase();
  const base = text.split('-')[0];
  const code = base === 'iw' ? 'he' : base;
  return LANGUAGES.find((l) => l.code === code || l.name.toLowerCase() === text);
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
export function validateLanguageSettings(value: unknown): LanguageSettings {
  const input = record(value);
  const result = {} as LanguageSettings;
  for (const field of LANGUAGE_FIELDS) {
    if (!isSupportedLanguage(input[field])) throw invalid();
    result[field] = input[field] as LanguageCode;
  }
  return result;
}
export function validateLanguageOverride(value: unknown): LanguageOverride {
  const input = record(value);
  const result: LanguageOverride = {};
  for (const field of LANGUAGE_FIELDS) {
    if (input[field] === undefined) continue;
    if (!isSupportedLanguage(input[field])) throw invalid();
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
export const effectiveLanguageSettings = (
  defaults: LanguageSettings,
  override: LanguageOverride = {},
): LanguageSettings => ({ ...defaults, ...override });
export function legacyLanguageSettings(language: string): LanguageSettings {
  const code = resolveLanguage(language)?.code ?? 'en';
  return { write: code, send: 'en', reply: code, assist: code };
}
export const needsReplyTranslation = (s: LanguageSettings) => s.reply !== 'en';
export const needsSendTranslation = (s: LanguageSettings) => s.write !== s.send;
export const languageName = (value: string) => resolveLanguage(value)?.name ?? 'English';
export const languageDirection = (value: string): 'rtl' | 'ltr' =>
  resolveLanguage(value)?.direction ?? 'ltr';
export const languageShortCode = (s: LanguageSettings) =>
  [s.write, s.send, s.reply].map((code) => code.toUpperCase()).join('→');
