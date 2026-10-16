import type { AgentKind } from './contracts.js';
import type { TerminalView } from './session-contracts.js';

export const POPUP_MODES = ['auto', 'current-tab', 'dot-only'] as const;
export type PopupMode = (typeof POPUP_MODES)[number];
const TERMINAL_VIEWS: readonly TerminalView[] = ['popup', 'workspace'];
const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex'];
/** Bounds on saved extra launch arguments per agent. */
export const MAX_EXTRA_ARGS = 32;
export const MAX_EXTRA_ARG_CHARS = 512;
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
  const {
    popup,
    extraArgs,
    terminalView = defaultLaunchSettings().terminalView,
  } = value as LaunchSettings;
  if (
    !POPUP_MODES.includes(popup) ||
    !TERMINAL_VIEWS.includes(terminalView) ||
    !extraArgs ||
    typeof extraArgs !== 'object' ||
    Array.isArray(extraArgs)
  )
    throw new Error('Invalid launch settings');
  for (const agent of AGENT_KINDS) {
    const args = extraArgs[agent];
    if (
      !Array.isArray(args) ||
      args.length > MAX_EXTRA_ARGS ||
      args.some((arg) => typeof arg !== 'string' || arg.length > MAX_EXTRA_ARG_CHARS)
    )
      throw new Error('Invalid launch settings');
  }
  return {
    popup,
    terminalView,
    extraArgs: { claude: [...extraArgs.claude], codex: [...extraArgs.codex] },
  };
}
