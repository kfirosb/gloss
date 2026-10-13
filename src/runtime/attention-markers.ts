import type { AgentKind } from '../core/contracts.js';

export interface MarkerTable { agent: AgentKind; versions: string[]; approval: RegExp[]; consent?: RegExp[] }
// Each pattern is copied from a captured fixture in tests/fixtures/screens. Add a version only with a new fixture.
// Patterns anchor a prompt's question line and one of its option labels, so prose that merely quotes
// a question does not match.
export const MARKER_TABLES: MarkerTable[] = [
  {
    agent: 'claude', versions: ['2.1.296'],
    consent: [
      // claude-2.1.296-consent.txt: development channel warning shown at startup.
      /^ {0,4}WARNING: Loading development channels$[\s\S]*^ {0,4}(?:❯ )? *\d\. I am using this for local development$/m,
      // claude-2.1.296-consent-trust.txt: workspace trust check for a folder Claude has not seen.
      /^ {0,4}Quick safety check: Is this a project you created or one you trust\?[\s\S]*^ {0,4}(?:❯ )? *(?:\d\. )?Yes, I trust this folder$/m,
    ],
    // claude-2.1.296-permission.txt: tool permission prompt.
    approval: [/^ {0,4}Do you want to proceed\?\n {0,4}(?:❯ )? *1\. Yes$/m],
  },
  {
    agent: 'codex', versions: ['0.162.1'],
    consent: [
      // codex-0.162.1-consent-hooks.txt: startup screen asking whether to trust new or changed hooks.
      /^ {0,4}Hooks need review$[\s\S]*^ {0,4}(?:› )? *\d\. Continue without trusting/m,
    ],
    // codex-0.162.1-approval.txt: command approval prompt.
    approval: [/^ {0,4}Would you like to run the following command\?$[\s\S]*^ {0,4}(?:› )? *1\. Yes, proceed \(y\)$/m],
  },
];
export const markersFor = (agent: AgentKind, version: string): MarkerTable | undefined => MARKER_TABLES.find(t => t.agent === agent && t.versions.includes(version));
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
