import { describe, expect, it } from 'vitest';
import { acceptTranscription, DictationFailure, FRAME_SAMPLES, isDictationLanguage, isRepetitive, nextPrompt, PROMPT_CONTEXT_CHARS, SEED_PROMPT } from '../../src/core/dictation-contracts.js';

describe('acceptTranscription', () => {
  it('trims and collapses whitespace', () => { expect(acceptTranscription('  שלום  עולם \n', false, 'he')).toBe('שלום עולם'); });
  it('drops no-speech and empty results', () => {
    expect(acceptTranscription('שלום', true, 'he')).toBeNull();
    expect(acceptTranscription('   ', false, 'he')).toBeNull();
  });
  it('drops known filler outputs regardless of punctuation and case', () => {
    expect(acceptTranscription('תודה רבה.', false, 'he')).toBeNull();
    expect(acceptTranscription('Thank you!', false, 'en')).toBeNull();
    expect(acceptTranscription('תודה רבה על העזרה', false, 'he')).toBe('תודה רבה על העזרה');
  });
  it('keeps a run of the same word at most three times, the first three tokens verbatim', () => {
    expect(acceptTranscription('בדיקה, בדיקה, בדיקה, בדיקה, בדיקה', false, 'he')).toBe('בדיקה, בדיקה, בדיקה,');
    expect(acceptTranscription('בדיקam, בדיקam, בדיקam, בדיקam', false, 'he')).toBe('בדיקam, בדיקam, בדיקam,');
    expect(acceptTranscription('Test test TEST. test! next', false, 'en')).toBe('Test test TEST. next');
    expect(acceptTranscription('אני אני אני אני אני רוצה רוצה רוצה רוצה', false, 'he')).toBe('אני אני אני רוצה רוצה רוצה');
  });
  it('leaves a run of three and different words untouched', () => {
    expect(acceptTranscription('בדיקה, בדיקה, בדיקה.', false, 'he')).toBe('בדיקה, בדיקה, בדיקה.');
    expect(acceptTranscription('אחת שתיים שלוש ארבע חמש', false, 'he')).toBe('אחת שתיים שלוש ארבע חמש');
    expect(acceptTranscription('a b a b a b a b', false, 'en')).toBe('a b a b a b a b');
  });
});
describe('isRepetitive', () => {
  it('needs at least three words', () => {
    expect(isRepetitive('')).toBe(false); expect(isRepetitive('בדיקה בדיקה')).toBe(false);
  });
  it('flags three identical consecutive words, ignoring punctuation and case', () => {
    expect(isRepetitive('בדיקה, בדיקה, בדיקה,')).toBe(true);
    expect(isRepetitive('so Test test TEST. done now please')).toBe(true);
  });
  it('flags a text dominated by one word', () => {
    expect(isRepetitive('go stop go wait go go')).toBe(true); // 4/6
    expect(isRepetitive('go stop go wait go')).toBe(true); // 3/5 = 60 %
  });
  it('does not flag ordinary speech', () => {
    expect(isRepetitive('אני רוצה לבדוק את הקוד הזה עכשיו')).toBe(false);
    expect(isRepetitive('go stop go wait')).toBe(false); // 2/4
    expect(isRepetitive('a b a b a b a b')).toBe(false); // 50 %
  });
});
it('seeds the first request with a plain sentence per language', () => {
  expect(SEED_PROMPT.he).toBe('שיחה בעברית על עבודה עם קוד: הסבר קצר, שאלה, ובקשה.');
  expect(SEED_PROMPT.he).not.toMatch(/[A-Za-z]/);
  expect(SEED_PROMPT.en).toBe('A conversation in English about working with code: a short explanation, a question, and a request.');
});
it('exposes 100 ms frames at 16 kHz and a coded failure', () => {
  expect(FRAME_SAMPLES).toBe(1600);
  expect(isDictationLanguage('he')).toBe(true); expect(isDictationLanguage('fr')).toBe(false);
  const f = new DictationFailure('engine-failed'); expect(f.code).toBe('engine-failed'); expect(f.message).toBe('engine-failed');
});
describe('nextPrompt', () => {
  it('seeds the first request in the recording language', () => {
    expect(nextPrompt('', false, 'he')).toBe(SEED_PROMPT.he);
    expect(nextPrompt('', false, 'en')).toBe(SEED_PROMPT.en);
  });
  it('sends the trailing context once there is some', () => {
    expect(nextPrompt('short context', false, 'en')).toBe('short context');
    const long = 'a'.repeat(PROMPT_CONTEXT_CHARS) + 'tail';
    expect(nextPrompt(long, false, 'en')).toBe(long.slice(-PROMPT_CONTEXT_CHARS));
    expect(nextPrompt(long, false, 'en')!.endsWith('tail')).toBe(true);
  });
  it('sends no prompt right after a repetitive segment, with or without context', () => {
    expect(nextPrompt('some context', true, 'he')).toBeUndefined();
    expect(nextPrompt('', true, 'he')).toBeUndefined();
  });
});
