import { expect, it } from 'vitest';
import { hostPlatform } from '../../src/ui/host-platform.js';
import { dictationShortcutLabel } from '../../src/ui/dictation-state.js';

it('reads the host platform from the browser', () => {
  expect(hostPlatform({ platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh)' })).toBe(
    'darwin',
  );
  expect(
    hostPlatform({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }),
  ).toBe('linux');
  expect(hostPlatform({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' })).toBe(
    'other',
  );
});

it('labels the dictation shortcut for the platform', () => {
  expect(dictationShortcutLabel('darwin')).toBe('⌘⇧M');
  expect(dictationShortcutLabel('linux')).toBe('Ctrl+Shift+M');
});
