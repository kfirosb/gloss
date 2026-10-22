import { expect, it } from 'vitest';
import {
  dominantLineEnding,
  fileEditedNote,
  isSecretFileName,
  normalizeLineBreaks,
  withLineEnding,
} from '../../src/core/file-edits.js';

it('keeps a file’s line ending and the trailing newline the user left', () => {
  expect(dominantLineEnding('a\r\nb\r\n')).toBe('\r\n');
  expect(dominantLineEnding('a\nb\n')).toBe('\n');
  expect(dominantLineEnding('a\r\nb\nc\r\n')).toBe('\r\n');
  expect(dominantLineEnding('single line')).toBe('\n');
  const shown = normalizeLineBreaks('a\r\nb\r\n');
  expect(shown).toBe('a\nb\n');
  expect(withLineEnding(shown + 'c', '\r\n')).toBe('a\r\nb\r\nc');
  expect(withLineEnding('a\nb\n', '\r\n')).toBe('a\r\nb\r\n');
  expect(withLineEnding('a\r\nb', '\n')).toBe('a\nb');
});

it('recognizes environment and key files by name', () => {
  for (const name of [
    '.env',
    'app/.env.local',
    '.env.production',
    'prod.env',
    '.envrc',
    'id_rsa',
    'server.pem',
    'tls.key',
  ])
    expect(isSecretFileName(name), name).toBe(true);
  for (const name of ['env.ts', 'README.md', 'src/environment.ts', '.envelope', 'keys.json'])
    expect(isSecretFileName(name), name).toBe(false);
});

it('writes the agent note in English with the path', () => {
  expect(fileEditedNote('config/.env')).toBe('I edited config/.env.');
});
