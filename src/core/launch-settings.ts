import type { AgentKind } from './contracts.js';
import type { TerminalView } from './session-contracts.js';

export type PopupMode = 'auto' | 'current-tab' | 'dot-only';
export interface LaunchSettings {
  extraArgs: Record<AgentKind, string[]>;
  popup: PopupMode;
  terminalView: TerminalView;
}
export const defaultLaunchSettings = (): LaunchSettings => ({
  extraArgs: { claude: [], codex: [] },
  popup: 'auto',
  terminalView: 'popup',
});

/** Splits quoted arguments without shell expansion or backslash interpretation. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) out.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote) throw new Error('Unclosed quote in launch arguments');
  if (started) out.push(current);
  return out;
}

/** Inverse of splitArgs, including empty arguments and arguments containing both quote styles. */
export function formatArgs(args: readonly string[]): string {
  return args
    .map((arg) => {
      if (arg && !/[\s"']/.test(arg)) return arg;
      if (!arg.includes('"')) return `"${arg}"`;
      return "'" + arg.replaceAll("'", "'\"'\"'") + "'";
    })
    .join(' ');
}

export function validateLaunchSettings(value: unknown): LaunchSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid launch settings');
  const { popup, extraArgs, terminalView = 'popup' } = value as LaunchSettings;
  if (
    !['auto', 'current-tab', 'dot-only'].includes(popup) ||
    !['popup', 'workspace'].includes(terminalView) ||
    !extraArgs ||
    typeof extraArgs !== 'object' ||
    Array.isArray(extraArgs)
  )
    throw new Error('Invalid launch settings');
  for (const agent of ['claude', 'codex'] as const) {
    const args = extraArgs[agent];
    if (
      !Array.isArray(args) ||
      args.length > 32 ||
      args.some((arg) => typeof arg !== 'string' || arg.length > 512)
    )
      throw new Error('Invalid launch settings');
  }
  return {
    popup,
    terminalView,
    extraArgs: { claude: [...extraArgs.claude], codex: [...extraArgs.codex] },
  };
}
