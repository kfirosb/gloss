import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  displayPath,
  MAX_CONFIG_BYTES,
  mcpEntries,
  mergeEntries,
  readSkillDir,
  type Inventory,
  type InventoryContext,
  type InventoryEntry,
  type InventoryScope,
} from '../inventory.js';

type Server = { command?: string; url?: string };
type Triple = '"""' | "'''";
const STRING = String.raw`"((?:[^"\\]|\\.)*)"|'([^']*)'`;
const unescape = (value: string) => value.replace(/\\(["\\])/g, '$1');

/** Splits a TOML table header such as `mcp_servers."docs.site"` into keys; null when it is not a simple dotted key. */
function headerKeys(raw: string): string[] | null {
  const keys: string[] = [];
  const part = new RegExp(String.raw`\s*(?:${STRING}|([A-Za-z0-9_-]+))\s*(\.|$)`, 'y');
  let index = 0;
  while (index < raw.length) {
    part.lastIndex = index;
    const match = part.exec(raw);
    if (!match) return null;
    keys.push(match[1] !== undefined ? unescape(match[1]) : (match[2] ?? match[3]!));
    if (match[4] === '') break;
    index = part.lastIndex;
  }
  return keys;
}
function stringValue(source: string, key: 'command' | 'url'): string | undefined {
  const match = new RegExp(String.raw`(?:^|[\s{,])${key}\s*=\s*(?:${STRING})`).exec(source);
  return match ? (match[1] !== undefined ? unescape(match[1]) : match[2]) : undefined;
}

/**
 * Brackets opened minus closed on one line, outside quoted strings and comments.
 * `open` is set when a multi-line string starts on this line and does not close on it.
 */
function scanValue(line: string): { depth: number; open: Triple | null } {
  let depth = 0;
  let i = 0;
  while (i < line.length) {
    const triple = (['"""', "'''"] as const).find((t) => line.startsWith(t, i));
    if (triple) {
      const end = line.indexOf(triple, i + 3);
      if (end < 0) return { depth, open: triple };
      i = end + 3;
      continue;
    }
    const c = line[i]!;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += c === '"' && line[j] === '\\' ? 2 : 1;
      if (j >= line.length) break;
      i = j + 1;
      continue;
    }
    if (c === '#') break;
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    i++;
  }
  return { depth, open: null };
}

/**
 * Minimal reader for Codex `[mcp_servers.<name>]` tables and `[mcp_servers]` inline tables.
 * It keeps only `command` and `url`; anything it cannot read confidently sets `ok: false` instead of guessing.
 */
export function parseCodexMcpServers(text: string): {
  servers: Record<string, Server>;
  ok: boolean;
} {
  const servers: Record<string, Server> = {};
  let ok = true;
  let table: string[] | null = null;
  let depth = 0; // brackets left open by a multi-line value
  let multi: Triple | null = null; // multi-line string still open
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (multi) {
      if (line.includes(multi)) multi = null;
      continue;
    }
    if (depth > 0) {
      const s = scanValue(line);
      depth = Math.max(0, depth + s.depth);
      if (s.open) {
        if (table?.[0] === 'mcp_servers') ok = false;
        multi = s.open;
      }
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    if (/^("""|''')/.test(line)) {
      if (table?.[0] === 'mcp_servers') ok = false;
      multi = scanValue(line).open;
      continue;
    }
    if (line.startsWith('[[')) {
      if (!/^\[\[([^\]]+)\]\]\s*(?:#.*)?$/.test(line)) ok = false;
      table = null;
      continue;
    }
    if (line.startsWith('[')) {
      const header = /^\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
      table = header ? headerKeys(header[1]!) : null;
      if (!table) {
        ok = false;
        continue;
      }
      if (table[0] === 'mcp_servers' && table.length === 2) servers[table[1]!] ??= {};
      continue;
    }
    const s = scanValue(line);
    depth = Math.max(0, s.depth);
    if (s.open) {
      if (table?.[0] === 'mcp_servers') ok = false;
      multi = s.open;
      continue;
    }
    if (!table || table[0] !== 'mcp_servers') continue;
    if (table.length === 2) {
      if (/^(command|url)\s*=\s*("""|''')/.test(line)) {
        ok = false;
        continue;
      }
      const server = servers[table[1]!]!;
      const command = /^command\s*=/.test(line) ? stringValue(line, 'command') : undefined;
      const url = /^url\s*=/.test(line) ? stringValue(line, 'url') : undefined;
      if (command !== undefined) server.command = command;
      if (url !== undefined) server.url = url;
    } else if (table.length === 1) {
      const inline = /^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*\{(.*)\}\s*(?:#.*)?$/.exec(
        line,
      );
      if (!inline) {
        ok = false;
        continue;
      }
      const name = headerKeys(inline[1]!)?.[0];
      if (!name) {
        ok = false;
        continue;
      }
      const command = stringValue(inline[2]!, 'command');
      const url = stringValue(inline[2]!, 'url');
      servers[name] = {
        ...(command !== undefined ? { command } : {}),
        ...(url !== undefined ? { url } : {}),
      };
    }
  }
  if (depth > 0 || multi) ok = false;
  return { servers, ok };
}

async function readConfigServers(
  path: string,
  scope: InventoryScope,
  ctx: InventoryContext,
): Promise<InventoryEntry[]> {
  let text: string;
  try {
    if ((await stat(path)).size > MAX_CONFIG_BYTES) {
      ctx.problems.push(`${displayPath(path, ctx.home)} is too large to read`);
      return [];
    }
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const { servers, ok } = parseCodexMcpServers(text);
  if (!ok) ctx.problems.push(`Could not fully read MCP servers in ${displayPath(path, ctx.home)}`);
  return mcpEntries(servers, scope);
}

/** Skills and MCP servers a Codex session in `project` can use. Read-only; starts nothing. */
export async function readCodexInventory(options: {
  project: string;
  home?: string;
  codexHome?: string;
}): Promise<Inventory> {
  const home = options.home ?? homedir();
  const codexHome = options.codexHome ?? (process.env.CODEX_HOME || join(home, '.codex'));
  const ctx: InventoryContext = { home, problems: [] };
  const entries: InventoryEntry[] = [
    ...(await readSkillDir(join(codexHome, 'skills'), 'global', ctx)),
    ...(await readSkillDir(join(home, '.agents', 'skills'), 'global', ctx)),
    ...(await readSkillDir(join(options.project, '.codex', 'skills'), 'project', ctx)),
    ...(await readSkillDir(join(options.project, '.agents', 'skills'), 'project', ctx)),
    ...(await readConfigServers(join(codexHome, 'config.toml'), 'global', ctx)),
    ...(await readConfigServers(join(options.project, '.codex', 'config.toml'), 'project', ctx)),
  ];
  return { agent: 'codex', entries: mergeEntries(entries), problems: ctx.problems };
}
