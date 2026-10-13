import { test, expect } from 'vitest';
import { isLocalFileLink, localFilePath } from '../../src/ui/file-links.js';
test('local paths support encoded names, line references, and nested preview links', () => {
  expect(isLocalFileLink('plan.md:12')).toBe(true);
  expect(isLocalFileLink('javascript:12')).toBe(false);
  expect(isLocalFileLink('https://example.com/demo.html')).toBe(false);
  expect(isLocalFileLink('#section')).toBe(false);
  expect(localFilePath('/project/docs/my%20plan.md:12:3', '/project')).toBe('docs/my plan.md');
  expect(localFilePath('../clip.webm', '/project', 'docs/examples/demo.html')).toBe('docs/clip.webm');
  expect(() => localFilePath('/project-other/secret.txt', '/project')).toThrow('outside');
  expect(() => localFilePath('../../secret.txt', '/project', 'docs/demo.html')).toThrow('outside');
  expect(() => localFilePath('file://remote/project/clip.webm', '/project')).toThrow('outside');
});
