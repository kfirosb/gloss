import { expect, it } from 'vitest';
// @ts-expect-error untyped release script
import { checksumUrl, dmgName, parseChecksum, renderCask } from '../../scripts/homebrew-cask.mjs';

const arm = 'a'.repeat(64);
const intel = 'b'.repeat(64);
const digest = arm;

it('renders a cask that picks the DMG and checksum for the running architecture', () => {
  const cask = renderCask({ version: '0.17.0', sha256: { arm, intel } });
  expect(cask).toContain('cask "gloss" do');
  expect(cask).toContain('version "0.17.0"');
  expect(cask).toContain(`sha256 arm:   "${arm}",\n         intel: "${intel}"`);
  expect(cask).toContain('arch arm: "arm64", intel: "x64"');
  expect(cask).toContain(
    'url "https://github.com/kfirosb/gloss/releases/download/v#{version}/Gloss-#{version}-#{arch}.dmg"',
  );
  expect(cask).not.toContain('depends_on arch');
  expect(cask).toContain('depends_on macos: :ventura');
  expect(cask).toContain('app "Gloss.app"');
  expect(cask).toContain('auto_updates true');
  expect(cask).toContain('"~/.gloss",');
  expect(cask).toContain('"~/.language-assistant",');
  expect(cask).toContain(
    'desc "Translate Claude Code and Codex conversations into your language"\n',
  );
  expect(cask).not.toMatch(/Hebrew/);
  expect(cask.endsWith('end\n')).toBe(true);
});

it('names each release asset by architecture', () => {
  expect(dmgName('0.17.0', 'arm')).toBe('Gloss-0.17.0-arm64.dmg');
  expect(dmgName('0.17.0', 'intel')).toBe('Gloss-0.17.0-x64.dmg');
  expect(checksumUrl('0.17.0', 'intel')).toBe(
    'https://github.com/kfirosb/gloss/releases/download/v0.17.0/Gloss-0.17.0-x64.dmg.sha256',
  );
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
  const sha256 = { arm, intel };
  expect(() => renderCask({ version: 'v0.16.2', sha256 })).toThrow(/version/);
  expect(() => renderCask({ version: '0.16.2"; system("x', sha256 })).toThrow(/version/);
  expect(() => renderCask({ version: '0.16.2', sha256: { arm, intel: 'zz' } })).toThrow(/digest/);
  expect(() => renderCask({ version: '0.16.2', sha256: { arm } })).toThrow(/digest/);
});
