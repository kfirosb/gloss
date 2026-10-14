import { expect, it } from 'vitest';
import { runnableCommand, MAX_RUN_COMMAND } from '../../src/ui/run-command.js';
import { fencedOutput } from '../../src/ui/output-fence.js';

it('runs untagged and shell-tagged blocks, not other languages', () => {
  expect(runnableCommand(undefined, 'npm test\n')).toBe('npm test');
  for (const tag of ['sh', 'bash', 'zsh', 'shell', 'shell-session', 'console', 'terminal', 'Bash']) expect(runnableCommand(tag, 'ls')).toBe('ls');
  for (const tag of ['ts', 'typescript', 'json', 'python', 'text']) expect(runnableCommand(tag, 'ls')).toBeUndefined();
});
it('strips leading prompts per line and keeps the rest literal', () => {
  expect(runnableCommand('console', '$ npm run typecheck\n$ npm test\n')).toBe('npm run typecheck\nnpm test');
  expect(runnableCommand('sh', '❯ git status')).toBe('git status');
  expect(runnableCommand('sh', 'echo "$ not a prompt"')).toBe('echo "$ not a prompt"');
  expect(runnableCommand('sh', '  indented && kept  ')).toBe('  indented && kept  ');
});
it('is undefined for empty, prompt-only or oversized blocks', () => {
  expect(runnableCommand('sh', '')).toBeUndefined();
  expect(runnableCommand('sh', '$ \n\n$ ')).toBeUndefined();
  expect(runnableCommand('sh', 'x'.repeat(MAX_RUN_COMMAND + 1))).toBeUndefined();
  expect(runnableCommand('sh', 'x'.repeat(MAX_RUN_COMMAND))).toHaveLength(MAX_RUN_COMMAND);
});
it('has no Run for blocks with control or invisible characters', () => {
  for (const text of ['ls\t-la', 'echo \u001b[2J', 'ls\u009B', 'a\rb', 'rm \u202Eexe.txt', 'ls\u2067', 'ls\u200F', 'ls\u061C', 'ls\u200D', 'ls\u2060', '\uFEFFls', 'ls\u007F']) expect(runnableCommand('sh', text)).toBeUndefined();
  expect(runnableCommand('sh', 'echo "שלום"\nls\r\n')).toBe('echo "שלום"\nls');
});
it('fences terminal output with more backticks than any run inside it', () => {
  expect(fencedOutput('plain')).toBe('```text\nplain\n```\n');
  expect(fencedOutput('a ` b `` c')).toBe('```text\na ` b `` c\n```\n');
  expect(fencedOutput('```js\nx\n```')).toBe('````text\n```js\nx\n```\n````\n');
  expect(fencedOutput('`````')).toBe('``````text\n`````\n``````\n');
});
