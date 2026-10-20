import { describe, expect, it } from 'vitest';
import { preparationPrompt, summaryPrompt, translationPrompt } from '../../src/language/prompts.js';
import { SUMMARY_PROMPT_VERSION } from '../../src/core/response-summaries.js';
import type { LanguageInput } from '../../src/core/contracts.js';

const input = (extra: Partial<LanguageInput> = {}): LanguageInput => ({
  language: 'he',
  projectContext: '',
  codingMessages: [],
  discussion: [{ role: 'user', text: 'hello' }] as LanguageInput['discussion'],
  ...extra,
});

describe('language prompts', () => {
  it('summary prompt follows the assist language', () => {
    const he = summaryPrompt('text', 'he');
    const en = summaryPrompt('text', 'en');
    expect(he).toContain('in clear Hebrew');
    expect(he).toContain('natural, fluent Hebrew');
    expect(en).toContain('in clear English');
    expect(en).not.toContain('Hebrew');
    expect(summaryPrompt('text', 'fr')).toContain('in clear French');
    expect(translationPrompt('x', 'Arabic')).toContain('fluent Arabic');
    expect(SUMMARY_PROMPT_VERSION).not.toBe('he-summary-v1');
  });
  it('preparation prompt does not force englishText to English when delivering in Hebrew', () => {
    const he = preparationPrompt(input({ deliveryLanguage: 'Hebrew' }));
    expect(he).not.toContain('englishText must remain entirely in English');
    expect(he).toContain('englishText follows deliveryLanguage');
    expect(he).toContain('"deliveryLanguage":"Hebrew"');
    const def = preparationPrompt(input());
    expect(def).toContain('deliveryLanguage (English when absent)');
    expect(def).not.toContain('"deliveryLanguage"');
  });
});

it('tells the translator to keep every placeholder exactly once', () => {
  const prompt = translationPrompt('Run ⟪LITERAL_0⟫ now.', 'he');
  expect(prompt).toMatch(/placeholder/i);
  expect(prompt).toContain('exactly once');
});
