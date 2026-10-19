import { expect, it } from 'vitest';
import {
  lsofPath,
  PS_PATH,
  supportsProcessProbes,
  urlOpenerPath,
} from '../../src/runtime/platform-tools.js';

it('allows process probes on macOS and Linux only', () => {
  expect(supportsProcessProbes('darwin')).toBe(true);
  expect(supportsProcessProbes('linux')).toBe(true);
  expect(supportsProcessProbes('win32')).toBe(false);
});

it('names the lsof binary where each platform installs it', () => {
  expect(lsofPath('darwin')).toBe('/usr/sbin/lsof');
  expect(lsofPath('linux')).toBe('/usr/bin/lsof');
  expect(PS_PATH).toBe('/bin/ps');
});

it('opens URLs with the platform opener', () => {
  expect(urlOpenerPath('darwin')).toBe('/usr/bin/open');
  expect(urlOpenerPath('linux')).toBe('/usr/bin/xdg-open');
});
