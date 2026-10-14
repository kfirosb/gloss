import { createContext } from 'react';
import { UNSAFE_COMMAND_CHARACTER } from '../core/command-text.js';

export const RUNNABLE_TAGS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'shell', 'shell-session', 'console', 'terminal']);
export const MAX_RUN_COMMAND = 8192;
/** What Run would type for a code block: untagged or shell-tagged, prompts stripped, trailing newlines dropped; none for blocks with control or invisible characters. */
export function runnableCommand(language: string | undefined, text: string): string | undefined {
  if (language !== undefined && !RUNNABLE_TAGS.has(language.toLowerCase())) return undefined;
  const command = text.split('\n').map(line => line.replace(/^(?:\$|❯) /, '')).join('\n').replace(/[\r\n]+$/, '');
  if (!command.trim() || command.length > MAX_RUN_COMMAND || UNSAFE_COMMAND_CHARACTER.test(command)) return undefined;
  return command;
}
/** Provided by a session workspace; absent where code is shown outside a session (previews), so no Run button appears there. */
export const RunCommandContext = createContext<{ run(command: string): Promise<void> } | null>(null);
