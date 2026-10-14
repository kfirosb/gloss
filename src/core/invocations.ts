import type { AgentKind } from './contracts.js';

export interface InvocationCatalog { skills: ReadonlySet<string>; mcp: ReadonlySet<string> }
export interface Invocations { skills: string[]; mcp: string[] }

const TOKEN = /(^|\s)([/$])([A-Za-z][\w.:-]*)/g;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function catalogFrom(entries: readonly { kind: 'skill' | 'mcp'; name: string }[]): InvocationCatalog {
  return { skills: new Set(entries.filter(e => e.kind === 'skill').map(e => e.name)), mcp: new Set(entries.filter(e => e.kind === 'mcp').map(e => e.name)) };
}

/** Trailing `.`, `:` or `-` is sentence punctuation unless the exact name exists. */
function known(raw: string, names: ReadonlySet<string>): string | undefined {
  for (let name = raw; name; name = name.slice(0, -1)) {
    if (names.has(name)) return name;
    if (!/[.:-]$/.test(name)) return undefined;
  }
  return undefined;
}

/** `/name` is a skill and `$name` an MCP server, at the start of text or after whitespace; unknown names are plain text. */
export function findInvocations(text: string, catalog: InvocationCatalog): Invocations {
  const found: Invocations = { skills: [], mcp: [] };
  for (const match of text.replaceAll('‎', '').matchAll(TOKEN)) {
    const skill = match[2] === '/';
    const name = known(match[3]!, skill ? catalog.skills : catalog.mcp);
    const list = skill ? found.skills : found.mcp;
    if (name && !list.includes(name)) list.push(name);
  }
  return found;
}

function strip(text: string, name: string): string {
  return text.replace(new RegExp(String.raw`(^|\s)[/$]${escape(name)}(?=$|[\s.,;:!?)])`, 'g'), '$1');
}

/** Deterministic English for the agent: skill invocation first, MCP guidance last. */
export function assembleInstruction(agent: AgentKind, invocations: Invocations, englishText: string): string {
  const { skills, mcp } = invocations;
  if (!skills.length && !mcp.length) return englishText;
  let body = englishText;
  for (const name of [...skills, ...mcp]) body = strip(body, name);
  body = body.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([.,;:!?])/g, '$1').replace(/^[ \t]+|[ \t]+$/gm, '').trim();
  let lead: string; let extraSkills: string[];
  if (agent === 'claude') { lead = skills.length ? '/' + skills[0] : ''; extraSkills = skills.slice(1); }
  else { lead = skills.map(name => '$' + name).join(' '); extraSkills = []; }
  const head = [lead, body].filter(Boolean).join(' ');
  const closing = [...extraSkills.map(name => `Also use the \`${name}\` skill.`), ...mcp.map(name => `Use the \`${name}\` MCP server for this.`)];
  return [head, closing.join('\n')].filter(Boolean).join('\n\n');
}
