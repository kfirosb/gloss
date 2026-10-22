import { describe, expect, it } from 'vitest';
import {
  INITIAL_LANGUAGE_DEFAULTS,
  LANGUAGES,
  SUPPORTED_LANGUAGES,
  isSupportedLanguage,
  resolveLanguage,
  effectiveLanguageSettings,
  languageDirection,
  languageName,
  languageShortCode,
  legacyLanguageSettings,
  needsReplyTranslation,
  needsSendTranslation,
  validateLanguageOverride,
  validateLanguageSettings,
  autoTranslatesReplies,
  showsTranslatedReplies,
} from '../../src/core/language-settings.js';

describe('language settings', () => {
  it('initial defaults reproduce the existing Hebrew workflow', () => {
    expect(INITIAL_LANGUAGE_DEFAULTS).toEqual({
      write: 'he',
      send: 'en',
      reply: 'he',
      assist: 'he',
    });
    expect(needsReplyTranslation(INITIAL_LANGUAGE_DEFAULTS)).toBe(true);
    expect(needsSendTranslation(INITIAL_LANGUAGE_DEFAULTS)).toBe(true);
  });
  it('override wins per field and other fields follow defaults', () => {
    const defaults = { write: 'en', send: 'en', reply: 'en', assist: 'en' };
    expect(effectiveLanguageSettings(defaults, { reply: 'he' })).toEqual({
      write: 'en',
      send: 'en',
      reply: 'he',
      assist: 'en',
    });
    expect(effectiveLanguageSettings(defaults)).toEqual(defaults);
  });
  it('all-English needs no translation', () => {
    const s = { write: 'en', send: 'en', reply: 'en', assist: 'en' };
    expect(needsReplyTranslation(s)).toBe(false);
    expect(needsSendTranslation(s)).toBe(false);
  });
  it('validates complete settings and rejects unsupported codes', () => {
    expect(
      validateLanguageSettings({ write: 'he', send: 'en', reply: 'en', assist: 'he', extra: 1 }),
    ).toEqual({ write: 'he', send: 'en', reply: 'en', assist: 'he' });
    for (const bad of [
      null,
      [],
      {},
      { write: 'xx', send: 'en', reply: 'en', assist: 'en' },
      { write: '', send: 'en', reply: 'en', assist: 'en' },
      { write: 123, send: 'en', reply: 'en', assist: 'en' },
    ])
      expect(() => validateLanguageSettings(bad)).toThrow('Invalid language settings');
  });
  it('validates partial overrides', () => {
    expect(validateLanguageOverride({ reply: 'en' })).toEqual({ reply: 'en' });
    expect(validateLanguageOverride({})).toEqual({});
    expect(() => validateLanguageOverride({ reply: 'xx' })).toThrow('Invalid language settings');
    expect(() => validateLanguageOverride('he')).toThrow('Invalid language settings');
  });
  it('keeps the translate-only-while-reading flag only as a boolean', () => {
    const he = { write: 'he', send: 'en', reply: 'he', assist: 'he' };
    expect(validateLanguageSettings({ ...he, translateOnlyWhileReading: true })).toEqual({
      ...he,
      translateOnlyWhileReading: true,
    });
    expect(validateLanguageOverride({ translateOnlyWhileReading: false })).toEqual({
      translateOnlyWhileReading: false,
    });
    for (const bad of ['true', 1, null])
      expect(() => validateLanguageOverride({ translateOnlyWhileReading: bad })).toThrow(
        'Invalid language settings',
      );
    expect(() => validateLanguageSettings({ ...he, translateOnlyWhileReading: 'yes' })).toThrow(
      'Invalid language settings',
    );
  });
  it('a session override of the reading flag wins over the default', () => {
    const he = { write: 'he', send: 'en', reply: 'he', assist: 'he' };
    const on = { ...he, translateOnlyWhileReading: true };
    expect(
      effectiveLanguageSettings(on, { translateOnlyWhileReading: false }).translateOnlyWhileReading,
    ).toBe(false);
    expect(effectiveLanguageSettings(he, { translateOnlyWhileReading: true })).toEqual(on);
  });
  it('replies follow the view only when the flag is on; Translated and Split are reading', () => {
    const he = { write: 'he', send: 'en', reply: 'he', assist: 'he' };
    const on = { ...he, translateOnlyWhileReading: true };
    expect(showsTranslatedReplies('translated') && showsTranslatedReplies('split')).toBe(true);
    for (const view of ['original', 'terminal', 'activity', undefined] as const) {
      expect(showsTranslatedReplies(view)).toBe(false);
      expect(autoTranslatesReplies(he, view)).toBe(true);
      expect(autoTranslatesReplies(on, view)).toBe(false);
    }
    expect(autoTranslatesReplies(on, 'split')).toBe(true);
    expect(autoTranslatesReplies({ ...on, reply: 'en' }, 'translated')).toBe(false);
  });
  it('maps a legacy conversation language', () => {
    expect(legacyLanguageSettings('he')).toEqual({
      write: 'he',
      send: 'en',
      reply: 'he',
      assist: 'he',
    });
    expect(legacyLanguageSettings('Hebrew')).toEqual({
      write: 'he',
      send: 'en',
      reply: 'he',
      assist: 'he',
    });
    expect(legacyLanguageSettings('en')).toEqual({
      write: 'en',
      send: 'en',
      reply: 'en',
      assist: 'en',
    });
  });
  it('display helpers', () => {
    expect(languageName('he')).toBe('Hebrew');
    expect(languageName('en')).toBe('English');
    expect(languageShortCode({ write: 'he', send: 'en', reply: 'he', assist: 'he' })).toBe(
      'HE→EN→HE',
    );
    expect(languageDirection('he')).toBe('rtl');
    expect(languageDirection('en')).toBe('ltr');
  });
  it('the table lists 19 languages, English and Hebrew first, then alphabetical', () => {
    expect(LANGUAGES.map((l) => l.code)).toEqual([
      'en',
      'he',
      'ar',
      'zh',
      'nl',
      'fr',
      'de',
      'hi',
      'it',
      'ja',
      'ko',
      'fa',
      'pl',
      'pt',
      'ru',
      'es',
      'tr',
      'uk',
      'ur',
    ]);
    expect(LANGUAGES.filter((l) => l.direction === 'rtl').map((l) => l.code)).toEqual([
      'he',
      'ar',
      'fa',
      'ur',
    ]);
    expect(SUPPORTED_LANGUAGES).toEqual(LANGUAGES.map((l) => l.code));
  });
  it('resolves codes, names, regions and the iw alias; rejects the rest', () => {
    for (const l of LANGUAGES) {
      expect(resolveLanguage(l.code)?.code).toBe(l.code);
      expect(resolveLanguage(l.name)?.code).toBe(l.code);
      expect(resolveLanguage(l.name.toUpperCase())?.code).toBe(l.code);
    }
    expect(resolveLanguage('he-IL')?.code).toBe('he');
    expect(resolveLanguage('zh-CN')?.code).toBe('zh');
    expect(resolveLanguage(' Hebrew ')?.code).toBe('he');
    expect(resolveLanguage('iw')?.code).toBe('he');
    expect(resolveLanguage('iw-IL')?.code).toBe('he');
    expect(resolveLanguage('xx')).toBeUndefined();
    expect(resolveLanguage('')).toBeUndefined();
  });
  it('name, direction and legacy mapping follow the table', () => {
    expect(languageName('ar')).toBe('Arabic');
    expect(languageName('Chinese (Simplified)')).toBe('Chinese (Simplified)');
    expect(languageName('xx')).toBe('English');
    expect(languageDirection('ar')).toBe('rtl');
    expect(languageDirection('fa-IR')).toBe('rtl');
    expect(languageDirection('fr')).toBe('ltr');
    expect(languageDirection('xx')).toBe('ltr');
    expect(legacyLanguageSettings('fr')).toEqual({
      write: 'fr',
      send: 'en',
      reply: 'fr',
      assist: 'fr',
    });
    expect(legacyLanguageSettings('he-IL')).toEqual({
      write: 'he',
      send: 'en',
      reply: 'he',
      assist: 'he',
    });
    expect(legacyLanguageSettings('xx')).toEqual({
      write: 'en',
      send: 'en',
      reply: 'en',
      assist: 'en',
    });
  });
  it('validation stays strict: bare codes only', () => {
    expect(
      validateLanguageSettings({ write: 'fr', send: 'en', reply: 'ar', assist: 'zh' }).assist,
    ).toBe('zh');
    for (const bad of ['xx', 'HE', 'he-IL', 'Hebrew'])
      expect(() => validateLanguageOverride({ reply: bad })).toThrow('Invalid language settings');
    expect(isSupportedLanguage('fr')).toBe(true);
    expect(isSupportedLanguage('Hebrew')).toBe(false);
  });
});
