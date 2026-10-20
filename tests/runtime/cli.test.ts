import { describe, expect, it } from 'vitest';
import { parseArgs, resolveLaunchLanguage } from '../../src/runtime/cli.js';
import { INITIAL_LANGUAGE_DEFAULTS } from '../../src/core/language-settings.js';
describe('launcher arguments', () => {
  it('keeps project paths as one argv value', () => {
    expect(
      parseArgs([
        '--language',
        'he',
        '--project',
        '/tmp/a;touch nope',
        '--agent',
        'codex',
        '--session',
        'id',
      ]),
    ).toEqual({ language: 'he', project: '/tmp/a;touch nope', agent: 'codex', session: 'id' });
  });

  it('passes a supported language flag through', () => {
    expect(resolveLaunchLanguage(parseArgs(['--language', 'fr']))).toBe('fr');
  });

  it('falls back to the shared default session language', () => {
    expect(resolveLaunchLanguage(parseArgs([]))).toBe(INITIAL_LANGUAGE_DEFAULTS.write);
  });

  it('rejects a malformed language flag', () => {
    expect(() => resolveLaunchLanguage(parseArgs(['--language', 'xx1!']))).toThrow(
      'Unsupported language',
    );
  });
});
