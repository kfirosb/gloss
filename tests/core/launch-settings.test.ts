import { expect, it } from 'vitest';
import { splitArgs } from '../../src/runtime/session-launcher.js';
import { toInput } from '../../src/ui/launch-controls.js';

it('round-trips every launch argument through the editable settings form', () => {
  const args = [
    '',
    '--model',
    'two words',
    `both 'single' and "double" quotes`,
    "'",
    '"',
    'a\\b',
    '$HOME',
    'עברית',
  ];
  const input = toInput({
    extraArgs: { claude: args, codex: args },
    popup: 'auto',
    terminalView: 'popup',
  });
  expect(splitArgs(input.extraArgs.claude)).toEqual(args);
  expect(splitArgs(input.extraArgs.codex)).toEqual(args);
});
