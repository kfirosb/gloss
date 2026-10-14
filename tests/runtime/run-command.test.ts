import { expect, it } from 'vitest';
import { runnableCommand, MAX_RUN_COMMAND } from '../../src/ui/run-command.js';

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
