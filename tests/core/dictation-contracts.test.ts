import { describe, expect, it } from 'vitest';
import { acceptTranscription, DictationFailure, FRAME_SAMPLES, isDictationLanguage } from '../../src/core/dictation-contracts.js';

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
});
it('exposes 100 ms frames at 16 kHz and a coded failure', () => {
  expect(FRAME_SAMPLES).toBe(1600);
  expect(isDictationLanguage('he')).toBe(true); expect(isDictationLanguage('fr')).toBe(false);
  const f = new DictationFailure('engine-failed'); expect(f.code).toBe('engine-failed'); expect(f.message).toBe('engine-failed');
});
