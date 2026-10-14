import { homedir } from 'node:os';
import { join } from 'node:path';
import { mcpEntries, mergeEntries, readJsonConfig, readSkillDir, type Inventory, type InventoryContext, type InventoryEntry } from '../inventory.js';

const CHANNEL_SERVER = 'language-assistant';
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

async function enabledPlugins(configDir: string, project: string, ctx: InventoryContext): Promise<{ name: string; installPath: string }[]> {
  const flags: Record<string, unknown> = {};
  for (const path of [join(configDir, 'settings.json'), join(project, '.claude', 'settings.json'), join(project, '.claude', 'settings.local.json')]) {
    const settings = await readJsonConfig(path, ctx);
    if (isObject(settings?.enabledPlugins)) Object.assign(flags, settings.enabledPlugins);
  }
  const installed = await readJsonConfig(join(configDir, 'plugins', 'installed_plugins.json'), ctx);
  const plugins = isObject(installed?.plugins) ? installed.plugins : {};
  const result: { name: string; installPath: string }[] = [];
  for (const [id, on] of Object.entries(flags)) {
    if (on !== true) continue;
    const installs = plugins[id];
    if (!Array.isArray(installs)) continue;
    const install = installs.find(i => isObject(i) && typeof i.installPath === 'string' && (typeof i.projectPath !== 'string' || i.projectPath === project));
    if (install) result.push({ name: id.split('@')[0]!, installPath: install.installPath as string });
  }
  return result;
}

async function pluginEntries(plugin: { name: string; installPath: string }, ctx: InventoryContext): Promise<InventoryEntry[]> {
  const entries = await readSkillDir(join(plugin.installPath, 'skills'), 'plugin', ctx, plugin.name);
  const file = await readJsonConfig(join(plugin.installPath, '.mcp.json'), ctx);
  if (file) entries.push(...mcpEntries(isObject(file.mcpServers) ? file.mcpServers : file, 'plugin', plugin.name));
  const manifest = await readJsonConfig(join(plugin.installPath, '.claude-plugin', 'plugin.json'), ctx);
  if (isObject(manifest?.mcpServers)) entries.push(...mcpEntries(manifest.mcpServers, 'plugin', plugin.name));
  return entries;
}

/** Skills and MCP servers a Claude Code session in `project` can use. Read-only; starts nothing. */
export async function readClaudeInventory(options: { project: string; home?: string; configDir?: string }): Promise<Inventory> {
  const home = options.home ?? homedir();
  const explicitDir = options.configDir ?? (process.env.CLAUDE_CONFIG_DIR || undefined);
  const configDir = explicitDir ?? join(home, '.claude');
  const ctx: InventoryContext = { home, problems: [] };
  const entries: InventoryEntry[] = [
    ...await readSkillDir(join(configDir, 'skills'), 'global', ctx),
    ...await readSkillDir(join(options.project, '.claude', 'skills'), 'project', ctx),
  ];
  const user = await readJsonConfig(explicitDir ? join(explicitDir, '.claude.json') : join(home, '.claude.json'), ctx, Infinity);
  entries.push(...mcpEntries(user?.mcpServers, 'global'));
  const projects = isObject(user?.projects) ? user.projects : {};
  const projectEntry = projects[options.project];
  if (isObject(projectEntry)) entries.push(...mcpEntries(projectEntry.mcpServers, 'project'));
  entries.push(...mcpEntries((await readJsonConfig(join(options.project, '.mcp.json'), ctx))?.mcpServers, 'project'));
  for (const plugin of await enabledPlugins(configDir, options.project, ctx)) entries.push(...await pluginEntries(plugin, ctx));
  return { agent: 'claude', entries: mergeEntries(entries).filter(e => !(e.kind === 'mcp' && e.name === CHANNEL_SERVER)), problems: ctx.problems };
}
