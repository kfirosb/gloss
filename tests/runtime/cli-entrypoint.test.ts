import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, expect, it } from 'vitest';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'language-entrypoint-')));
const output = join(root, 'Gloss #1.app');
const entry = join(output, 'runtime/cli.js');

beforeAll(() => {
  const require = createRequire(import.meta.url);
  const compiler = resolve(
    dirname(require.resolve('typescript/package.json')),
    require('typescript/package.json').bin.tsc,
  );
  execFileSync(process.execPath, [compiler, '-p', 'tsconfig.server.json', '--outDir', output], {
    timeout: 30000,
  });
}, 35000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

it('executes the CLI from an app path containing spaces and URL-special characters', () => {
  // Invalid input exercises startup without opening the real user database or agents.
  const result = spawnSync(process.execPath, [entry, '--language', 'invalid_language'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Unsupported language');
});

it('does not launch the CLI when imported', () => {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(entry).href)});`],
    { encoding: 'utf8', timeout: 10000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
});
