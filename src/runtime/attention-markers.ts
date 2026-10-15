import type { AgentKind } from '../core/contracts.js';

/** `since` is the oldest version the patterns were captured from; every later version, major ones included, uses them too.
 * Agents update often and their prompts rarely change wording, and a prompt that stops matching only means the terminal
 * is not opened for it: the monitor never answers prompts. `verified` lists the versions with captured fixtures. */
export interface MarkerTable { agent: AgentKind; since: string; verified: string[]; approval: RegExp[]; consent?: RegExp[] }
// Each pattern is copied from a captured fixture in tests/fixtures/screens.
// Patterns anchor a prompt's question line and one of its option labels, so prose that merely quotes
// a question does not match.
export const MARKER_TABLES: MarkerTable[] = [
  {
    // 2.1.299 was re-captured (claude-2.1.299-*.txt): both consent screens are byte-identical to 2.1.296 and the
    // permission prompt's question and option lines are unchanged, so the same patterns cover both versions.
    agent: 'claude', since: '2.1.296', verified: ['2.1.296', '2.1.299'],
    consent: [
      // claude-2.1.296-consent.txt, claude-2.1.299-consent.txt: development channel warning shown at startup.
      /^ {0,4}WARNING: Loading development channels$[\s\S]*^ {0,4}(?:❯ )? *\d\. I am using this for local development$/m,
      // claude-2.1.296-consent-trust.txt, claude-2.1.299-consent-trust.txt: workspace trust check for a folder Claude has not seen.
      /^ {0,4}Quick safety check: Is this a project you created or one you trust\?[\s\S]*^ {0,4}(?:❯ )? *(?:\d\. )?Yes, I trust this folder$/m,
    ],
    // claude-2.1.296-permission.txt, claude-2.1.299-permission.txt: tool permission prompt.
    approval: [/^ {0,4}Do you want to proceed\?\n {0,4}(?:❯ )? *1\. Yes$/m],
  },
  {
    agent: 'codex', since: '0.162.1', verified: ['0.162.1'],
    consent: [
      // codex-0.162.1-consent-hooks.txt: startup screen asking whether to trust new or changed hooks.
      /^ {0,4}Hooks need review$[\s\S]*^ {0,4}(?:› )? *\d\. Continue without trusting/m,
    ],
    // codex-0.162.1-approval.txt: command approval prompt.
    approval: [/^ {0,4}Would you like to run the following command\?$[\s\S]*^ {0,4}(?:› )? *1\. Yes, proceed \(y\)$/m],
  },
];
const parts = (version: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())?.slice(1).map(Number);
/** Negative, zero or positive as `a` is older than, equal to or newer than `b`; undefined when either is not x.y.z. */
export function compareVersions(a: string, b: string): number | undefined {
  const x = parts(a), y = parts(b); if (!x || !y) return undefined;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}
/** The table for this agent when its version is `since` or newer; undefined for an older or unreadable version. */
export const markersFor = (agent: AgentKind, version: string): MarkerTable | undefined =>
  MARKER_TABLES.find(t => t.agent === agent && (compareVersions(version, t.since) ?? -1) >= 0);
/** Prompts render at the bottom of the pane; only that region is classified, so quoted prompts above do not match. */
export const PROMPT_REGION_LINES = 20;
export function promptRegion(screen: string, lines = PROMPT_REGION_LINES): string {
  const all = screen.split('\n'); let kept = 0; let start = all.length;
  while (start > 0 && kept < lines) { start--; if (all[start]!.trim()) kept++; }
  return all.slice(start).join('\n');
}
export function classifyScreen(table: MarkerTable, screen: string): 'consent' | 'approval' | 'none' {
  const region = promptRegion(screen);
  if (table.consent?.some(p => p.test(region))) return 'consent';
  if (table.approval.some(p => p.test(region))) return 'approval';
  return 'none';
}
