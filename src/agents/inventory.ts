import { open, opendir, stat, readFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

export type InventoryScope = 'global' | 'project' | 'plugin';
export interface InventoryEntry {
  kind: 'skill' | 'mcp';
  name: string;
  description?: string;
  scope: InventoryScope;
  plugin?: string;
  transport?: 'stdio' | 'http' | 'sse';
  target?: string;
}
export interface Inventory {
  agent: 'claude' | 'codex';
  entries: InventoryEntry[];
  problems: string[];
}
export interface InventoryContext {
  home: string;
  problems: string[];
}

/** Names Gloss can insert and later find again as `/name` or `$name`. */
export const TOKEN_NAME = /^[A-Za-z][\w.:-]*$/;
export const MAX_SKILL_DIRS = 500;
export const MAX_CONFIG_BYTES = 1024 * 1024;
const FRONTMATTER_BYTES = 8192;
const DESCRIPTION_CHARS = 300;

export function displayPath(path: string, home: string): string {
  const rel = relative(home, path);
  return rel && !rel.startsWith('..') ? '~/' + rel : path;
}
const oneLine = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > DESCRIPTION_CHARS ? flat.slice(0, DESCRIPTION_CHARS - 1) + '…' : flat;
};
const missing = (error: unknown) =>
  ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '');

/** Reads `name` and `description` from YAML frontmatter; supports plain, quoted and folded (`>`/`|`) scalars. */
export function parseFrontmatter(text: string): {
  name?: string;
  description?: string;
  userInvocable?: boolean;
} {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!block) return {};
  const lines = block[1]!.split(/\r?\n/);
  const out: { name?: string; description?: string; userInvocable?: boolean } = {};
  for (let i = 0; i < lines.length; i++) {
    const field = /^(name|description|user-invocable):\s*(.*)$/.exec(lines[i]!);
    if (!field) continue;
    let value = field[2]!.trim();
    if (/^[>|][-+]?$/.test(value)) {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      value = parts.join(' ');
    }
    value = value.replace(/^(['"])(.*)\1$/, '$2').trim();
    if (field[1] === 'user-invocable') {
      if (/^(true|false)$/i.test(value)) out.userInvocable = value.toLowerCase() === 'true';
    } else if (value) out[field[1] as 'name' | 'description'] = value;
  }
  return out;
}

async function readHead(path: string, bytes: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Lists `<dir>/<folder>/SKILL.md` skills. Folders without SKILL.md are not skills. Symlinked folders are followed. */
export async function readSkillDir(
  dir: string,
  scope: InventoryScope,
  ctx: InventoryContext,
  plugin?: string,
): Promise<InventoryEntry[]> {
  let handle;
  try {
    handle = await opendir(dir);
  } catch (error) {
    if (!missing(error)) ctx.problems.push(`Could not read ${displayPath(dir, ctx.home)}`);
    return [];
  }
  const entries: InventoryEntry[] = [];
  let seen = 0;
  for await (const item of handle) {
    if (item.name.startsWith('.') || !(item.isDirectory() || item.isSymbolicLink())) continue;
    if (++seen > MAX_SKILL_DIRS) {
      ctx.problems.push(
        `Only the first ${MAX_SKILL_DIRS} skills in ${displayPath(dir, ctx.home)} are listed`,
      );
      break;
    }
    let text: string;
    try {
      text = await readHead(join(dir, item.name, 'SKILL.md'), FRONTMATTER_BYTES);
    } catch {
      continue;
    }
    const meta = parseFrontmatter(text);
    if (meta.userInvocable === false) continue;
    const base = meta.name && TOKEN_NAME.test(meta.name) ? meta.name : item.name;
    const name = plugin ? `${plugin}:${base}` : base;
    if (!TOKEN_NAME.test(name)) continue;
    entries.push({
      kind: 'skill',
      name,
      ...(meta.description ? { description: oneLine(meta.description) } : {}),
      scope,
      ...(plugin ? { plugin } : {}),
    });
  }
  return entries;
}

/** Parses a JSON object file. Missing → undefined silently; too large or malformed → undefined plus a problem line. */
export async function readJsonConfig(
  path: string,
  ctx: InventoryContext,
  limit = MAX_CONFIG_BYTES,
): Promise<Record<string, unknown> | undefined> {
  try {
    if ((await stat(path)).size > limit) {
      ctx.problems.push(`${displayPath(path, ctx.home)} is too large to read`);
      return undefined;
    }
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
    ctx.problems.push(`Could not parse ${displayPath(path, ctx.home)}`);
  } catch (error) {
    if (!missing(error)) ctx.problems.push(`Could not parse ${displayPath(path, ctx.home)}`);
  }
  return undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Turns an `mcpServers`-style map into entries, keeping only transport and a secret-free target. */
export function mcpEntries(map: unknown, scope: InventoryScope, plugin?: string): InventoryEntry[] {
  if (!isObject(map)) return [];
  const entries: InventoryEntry[] = [];
  for (const [name, server] of Object.entries(map)) {
    if (!TOKEN_NAME.test(name) || !isObject(server)) continue;
    const url = typeof server.url === 'string' ? server.url : undefined;
    const transport =
      server.type === 'http' || server.type === 'sse' ? server.type : url ? 'http' : 'stdio';
    let target: string | undefined;
    if (url) {
      try {
        target = new URL(url).origin;
      } catch {
        target = undefined;
      }
    } else if (typeof server.command === 'string' && server.command)
      target = basename(server.command.trim().split(/\s+/)[0]!);
    entries.push({
      kind: 'mcp',
      name,
      scope,
      transport,
      ...(target ? { target } : {}),
      ...(plugin ? { plugin } : {}),
    });
  }
  return entries;
}

const RANK: Record<InventoryScope, number> = { project: 0, plugin: 1, global: 2 };
/** One entry per kind and name, project over plugin over global; MCP first, then skills, each by name. */
export function mergeEntries(entries: InventoryEntry[]): InventoryEntry[] {
  const best = new Map<string, InventoryEntry>();
  for (const entry of entries) {
    const key = entry.kind + '\0' + entry.name;
    const prior = best.get(key);
    if (!prior || RANK[entry.scope] < RANK[prior.scope]) best.set(key, entry);
  }
  return [...best.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
  );
}
