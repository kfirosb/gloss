import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isWithin } from '../../src/runtime/path-containment.js';
import { ensurePrivateDirectory } from '../../src/runtime/private-directory.js';
import { claudeConfigDir, codexHomeDir } from '../../src/agents/shared.js';

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it('treats a root and its descendants as within, including names that start with two dots', () => {
  expect(isWithin('/a/b', '/a/b')).toBe(true);
  expect(isWithin('/a/b', '/a/b/c/d')).toBe(true);
  expect(isWithin('/a/b', '/a/b/..foo')).toBe(true);
  expect(isWithin('/a/b', '/a')).toBe(false);
  expect(isWithin('/a/b', '/a/bc')).toBe(false);
  expect(isWithin('/a/b', '/a/b/../c')).toBe(false);
});

it('creates a private directory and rejects one that is open to others or is a symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gloss-private-'));
  temporary.push(root);
  const dir = join(root, 'state');
  await ensurePrivateDirectory(dir, 'unsafe');
  await ensurePrivateDirectory(dir, 'unsafe'); // an existing private directory is accepted
  await chmod(dir, 0o755);
  await expect(ensurePrivateDirectory(dir, 'unsafe')).rejects.toThrow('unsafe');
  const link = join(root, 'link');
  await symlink(dir, link);
  await expect(ensurePrivateDirectory(link, 'unsafe')).rejects.toThrow('unsafe');
  await ensurePrivateDirectory(join(root, 'a', 'b'), 'unsafe', { recursive: true });
});

it('resolves agent config directories from options, then nonempty environment, then home', () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  vi.stubEnv('CODEX_HOME', '');
  expect(claudeConfigDir(undefined, '/home/u')).toBe('/home/u/.claude');
  expect(codexHomeDir(undefined, '/home/u')).toBe('/home/u/.codex');
  vi.stubEnv('CLAUDE_CONFIG_DIR', '/custom/claude');
  vi.stubEnv('CODEX_HOME', '/custom/codex');
  expect(claudeConfigDir(undefined, '/home/u')).toBe('/custom/claude');
  expect(codexHomeDir(undefined, '/home/u')).toBe('/custom/codex');
  expect(claudeConfigDir('/explicit', '/home/u')).toBe('/explicit');
  expect(codexHomeDir('/explicit', '/home/u')).toBe('/explicit');
});
