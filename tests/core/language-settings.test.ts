import { describe, expect, it } from 'vitest';
import { INITIAL_LANGUAGE_DEFAULTS, effectiveLanguageSettings, languageDirection, languageName, languageShortCode, legacyLanguageSettings, needsReplyTranslation, needsSendTranslation, validateLanguageOverride, validateLanguageSettings } from '../../src/core/language-settings.js';

describe('language settings', () => {
  it('initial defaults reproduce the existing Hebrew workflow', () => {
    expect(INITIAL_LANGUAGE_DEFAULTS).toEqual({ write: 'he', send: 'en', reply: 'he', assist: 'he' });
    expect(needsReplyTranslation(INITIAL_LANGUAGE_DEFAULTS)).toBe(true);
    expect(needsSendTranslation(INITIAL_LANGUAGE_DEFAULTS)).toBe(true);
  });
  it('override wins per field and other fields follow defaults', () => {
    const defaults = { write: 'en', send: 'en', reply: 'en', assist: 'en' };
    expect(effectiveLanguageSettings(defaults, { reply: 'he' })).toEqual({ write: 'en', send: 'en', reply: 'he', assist: 'en' });
    expect(effectiveLanguageSettings(defaults)).toEqual(defaults);
  });
  it('all-English needs no translation', () => {
    const s = { write: 'en', send: 'en', reply: 'en', assist: 'en' };
    expect(needsReplyTranslation(s)).toBe(false);
    expect(needsSendTranslation(s)).toBe(false);
  });
  it('validates complete settings and rejects unsupported codes', () => {
    expect(validateLanguageSettings({ write: 'he', send: 'en', reply: 'en', assist: 'he', extra: 1 })).toEqual({ write: 'he', send: 'en', reply: 'en', assist: 'he' });
    for (const bad of [null, [], {}, { write: 'fr', send: 'en', reply: 'en', assist: 'en' }, { write: '', send: 'en', reply: 'en', assist: 'en' }, { write: 123, send: 'en', reply: 'en', assist: 'en' }])
      expect(() => validateLanguageSettings(bad)).toThrow('Invalid language settings');
  });
  it('validates partial overrides', () => {
    expect(validateLanguageOverride({ reply: 'en' })).toEqual({ reply: 'en' });
    expect(validateLanguageOverride({})).toEqual({});
    expect(() => validateLanguageOverride({ reply: 'xx' })).toThrow('Invalid language settings');
    expect(() => validateLanguageOverride('he')).toThrow('Invalid language settings');
  });
  it('maps a legacy conversation language', () => {
    expect(legacyLanguageSettings('he')).toEqual({ write: 'he', send: 'en', reply: 'he', assist: 'he' });
    expect(legacyLanguageSettings('Hebrew')).toEqual({ write: 'he', send: 'en', reply: 'he', assist: 'he' });
    expect(legacyLanguageSettings('en')).toEqual({ write: 'en', send: 'en', reply: 'en', assist: 'en' });
  });
  it('display helpers', () => {
    expect(languageName('he')).toBe('Hebrew');
    expect(languageName('en')).toBe('English');
    expect(languageShortCode({ write: 'he', send: 'en', reply: 'he', assist: 'he' })).toBe('HE→EN→HE');
    expect(languageDirection('he')).toBe('rtl');
    expect(languageDirection('en')).toBe('ltr');
  });
});
