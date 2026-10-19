import { expect, it } from 'vitest';
// @ts-expect-error untyped release script
import { parseChecksum, renderCask } from '../../scripts/homebrew-cask.mjs';

const digest = 'a'.repeat(64);

it('renders a cask pinned to the release DMG and its checksum', () => {
  const cask = renderCask({ version: '0.16.2', sha256: digest });
  expect(cask).toContain('cask "gloss" do');
  expect(cask).toContain('version "0.16.2"');
  expect(cask).toContain(`sha256 "${digest}"`);
  expect(cask).toContain(
    'url "https://github.com/kfirosb/gloss/releases/download/v#{version}/Gloss-#{version}-arm64.dmg"',
  );
  expect(cask).toContain('depends_on arch: :arm64');
  expect(cask).toContain('app "Gloss.app"');
  expect(cask.endsWith('end\n')).toBe(true);
});

it('reads the digest from the published shasum line for the expected file only', () => {
  const file = 'Gloss-0.16.2-arm64.dmg';
  expect(parseChecksum(`${digest}  ${file}\n`, file)).toBe(digest);
  expect(parseChecksum(`${digest.toUpperCase()} *${file}`, file)).toBe(digest);
  expect(() => parseChecksum(`${digest}  Gloss-0.16.1-arm64.dmg\n`, file)).toThrow(/0\.16\.1/);
  expect(() => parseChecksum(`abc  ${file}\n`, file)).toThrow(/digest/);
  expect(() => parseChecksum('', file)).toThrow(/digest/);
});

it('refuses versions that are not plain release numbers', () => {
  expect(() => renderCask({ version: 'v0.16.2', sha256: digest })).toThrow(/version/);
  expect(() => renderCask({ version: '0.16.2"; system("x', sha256: digest })).toThrow(/version/);
  expect(() => renderCask({ version: '0.16.2', sha256: 'zz' })).toThrow(/digest/);
});
