import { describe, expect, it } from 'vitest';
import {
  acceptTranscription,
  DictationFailure,
  FILLER_OUTPUTS,
  FRAME_SAMPLES,
  isDictationLanguage,
  isRepetitive,
  nextPrompt,
  PROMPT_CONTEXT_CHARS,
  SEED_PROMPT,
} from '../../src/core/dictation-contracts.js';

describe('acceptTranscription', () => {
  it('trims and collapses whitespace', () => {
    expect(acceptTranscription('  שלום  עולם \n', false, 'he')).toBe('שלום עולם');
  });
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
    expect(acceptTranscription('בדיקה, בדיקה, בדיקה, בדיקה, בדיקה', false, 'he')).toBe(
      'בדיקה, בדיקה, בדיקה,',
    );
    expect(acceptTranscription('בדיקam, בדיקam, בדיקam, בדיקam', false, 'he')).toBe(
      'בדיקam, בדיקam, בדיקam,',
    );
    expect(acceptTranscription('Test test TEST. test! next', false, 'en')).toBe(
      'Test test TEST. next',
    );
    expect(acceptTranscription('אני אני אני אני אני רוצה רוצה רוצה רוצה', false, 'he')).toBe(
      'אני אני אני רוצה רוצה רוצה',
    );
  });
  it('leaves a run of three and different words untouched', () => {
    expect(acceptTranscription('בדיקה, בדיקה, בדיקה.', false, 'he')).toBe('בדיקה, בדיקה, בדיקה.');
    expect(acceptTranscription('אחת שתיים שלוש ארבע חמש', false, 'he')).toBe(
      'אחת שתיים שלוש ארבע חמש',
    );
    expect(acceptTranscription('a b a b a b a b', false, 'en')).toBe('a b a b a b a b');
  });
});
describe('isRepetitive', () => {
  it('needs at least three words', () => {
    expect(isRepetitive('')).toBe(false);
    expect(isRepetitive('בדיקה בדיקה')).toBe(false);
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
  expect(SEED_PROMPT.en).toBe(
    'A conversation in English about working with code: a short explanation, a question, and a request.',
  );
});
it('exposes 100 ms frames at 16 kHz and a coded failure', () => {
  expect(FRAME_SAMPLES).toBe(1600);
  expect(isDictationLanguage('he')).toBe(true);
  expect(isDictationLanguage('fr')).toBe(true);
  expect(isDictationLanguage('xx')).toBe(false);
  const f = new DictationFailure('engine-failed');
  expect(f.code).toBe('engine-failed');
  expect(f.message).toBe('engine-failed');
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
describe('languages beyond Hebrew and English', () => {
  it('seeds only the languages that have a seed prompt', () => {
    expect(nextPrompt('', false, 'ja')).toBeUndefined();
    expect(nextPrompt('', false, 'fr')).toBe(SEED_PROMPT.fr);
  });
  it.each(['ar', 'fr', 'hi', 'zh'] as const)('defines a seed prompt and fillers for %s', (code) => {
    expect(SEED_PROMPT[code]).toEqual(expect.any(String));
    expect(SEED_PROMPT[code]).not.toBe('');
    expect(Array.isArray(FILLER_OUTPUTS[code])).toBe(true);
    expect(FILLER_OUTPUTS[code]?.length).toBeGreaterThan(0);
  });
  it('passes text through for a language with no filler list', () => {
    expect(acceptTranscription('こんにちは', false, 'ja')).toBe('こんにちは');
  });
  it("drops fillers after stripping that language's trailing punctuation", () => {
    expect(acceptTranscription('谢谢观看。', false, 'zh')).toBeNull();
    expect(acceptTranscription('شكرا؟', false, 'ar')).toBeNull();
    expect(acceptTranscription('धन्यवाद।', false, 'hi')).toBeNull();
    expect(acceptTranscription('Merci !', false, 'fr')).toBeNull();
  });
  it('collapses a word run in Hindi text', () => {
    expect(acceptTranscription('मैं मैं मैं मैं हूँ।', false, 'hi')).toBe('मैं मैं मैं हूँ।');
  });
});
describe('scripts written without word spaces', () => {
  const thanksJa = 'ご視聴ありがとうございました';
  const ordinary = [
    '谢谢',
    '谢谢谢谢',
    '我们常常看看这个代码。',
    '研究研究这个问题',
    'ここはどこですか',
    'いろいろありがとうございました。',
    '我想检查一下这段代码是否正确。',
    '𠀀𠀀𠀀𠀀',
  ];
  it('collapses a doubled-character word looping, keeping three copies of the word', () => {
    expect(acceptTranscription('谢谢谢谢谢谢谢谢', false, 'zh')).toBe('谢谢谢谢谢谢');
    expect(acceptTranscription('我说谢谢谢谢谢谢谢谢谢谢谢谢。', false, 'zh')).toBe(
      '我说谢谢谢谢谢谢。',
    );
  });
  it('collapses a looping phrase to three copies, with or without punctuation', () => {
    expect(acceptTranscription(thanksJa.repeat(5), false, 'ja')).toBe(thanksJa.repeat(3));
    expect(acceptTranscription('谢谢，'.repeat(5) + '再见', false, 'zh')).toBe(
      '谢谢，谢谢，谢谢，再见',
    );
  });
  it('keeps ordinary sentences and short legitimate repeats', () => {
    for (const text of [...ordinary, thanksJa.repeat(3)])
      expect(acceptTranscription(text, false, 'ja')).toBe(text);
  });
  it('flags a collapsed loop as repetitive', () => {
    expect(isRepetitive('谢谢谢谢谢谢')).toBe(true);
    expect(isRepetitive(thanksJa.repeat(3))).toBe(true);
    expect(isRepetitive('谢谢，谢谢，谢谢，再见')).toBe(true);
  });
  it('does not flag ordinary text or short repeats', () => {
    for (const text of [...ordinary, thanksJa.repeat(2)]) expect(isRepetitive(text)).toBe(false);
  });
  it('leaves letter runs in space-separated scripts alone', () => {
    expect(acceptTranscription('aaaaaaaa hmmmmmmm', false, 'en')).toBe('aaaaaaaa hmmmmmmm');
    expect(isRepetitive('aaaaaaaa hmmmmmmm')).toBe(false);
  });
});
