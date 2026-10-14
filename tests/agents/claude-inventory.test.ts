import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeInventory } from '../../src/agents/claude/inventory.js';

const cleanups: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), 'claude-inventory-')); cleanups.push(dir); return dir; };
const write = async (path: string, body: unknown) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, typeof body === 'string' ? body : JSON.stringify(body)); };
const skill = (root: string, name: string, description = 'About ' + name) => write(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`);

async function fixture() {
  const home = await temp(); const project = join(home, 'work', 'app');
  const configDir = join(home, '.claude');
  await skill(join(configDir, 'skills'), 'cloudflare');
  await skill(join(configDir, 'skills'), 'shared', 'global copy');
  await skill(join(project, '.claude', 'skills'), 'shared', 'project copy');
  await write(join(home, '.claude.json'), {
    mcpServers: { github: { command: 'gh-mcp', env: { TOKEN: 'secret' } }, 'language-assistant': { command: 'node' } },
    projects: { [project]: { mcpServers: { db: { command: 'pg-mcp' } } }, '/other': { mcpServers: { nope: { command: 'x' } } } },
  });
  await write(join(project, '.mcp.json'), { mcpServers: { github: { type: 'http', url: 'https://api.example.com/mcp' } } });
  const enabled = join(configDir, 'plugins', 'cache', 'm', 'superpowers', '1.0.0');
  const disabled = join(configDir, 'plugins', 'cache', 'm', 'impeccable', '1.0.0');
  await skill(join(enabled, 'skills'), 'brainstorming');
  await write(join(enabled, '.mcp.json'), { mcpServers: { docs: { command: 'docs-mcp' } } });
  await write(join(enabled, '.claude-plugin', 'plugin.json'), { name: 'superpowers', mcpServers: { inline: { url: 'https://inline.example.com/x' } } });
  await skill(join(disabled, 'skills'), 'polish');
  await write(join(configDir, 'settings.json'), { enabledPlugins: { 'superpowers@m': true, 'impeccable@m': false } });
  await write(join(configDir, 'plugins', 'installed_plugins.json'), { version: 2, plugins: {
    'superpowers@m': [{ scope: 'user', installPath: enabled }],
    'impeccable@m': [{ scope: 'user', installPath: disabled }],
  } });
  return { home, project, configDir };
}

it('merges global, project and enabled-plugin skills and MCP servers', async () => {
  const { home, project } = await fixture();
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  const inventory = await readClaudeInventory({ home, project });
  expect(inventory.agent).toBe('claude');
  expect(inventory.problems).toEqual([]);
  expect(inventory.entries).toEqual([
    { kind: 'mcp', name: 'db', scope: 'project', transport: 'stdio', target: 'pg-mcp' },
    { kind: 'mcp', name: 'docs', scope: 'plugin', plugin: 'superpowers', transport: 'stdio', target: 'docs-mcp' },
    { kind: 'mcp', name: 'github', scope: 'project', transport: 'http', target: 'https://api.example.com' },
    { kind: 'mcp', name: 'inline', scope: 'plugin', plugin: 'superpowers', transport: 'http', target: 'https://inline.example.com' },
    { kind: 'skill', name: 'cloudflare', description: 'About cloudflare', scope: 'global' },
    { kind: 'skill', name: 'shared', description: 'project copy', scope: 'project' },
    { kind: 'skill', name: 'superpowers:brainstorming', description: 'About brainstorming', scope: 'plugin', plugin: 'superpowers' },
  ]);
  expect(JSON.stringify(inventory)).not.toContain('secret');
});

it('reads the user config from CLAUDE_CONFIG_DIR when it is set', async () => {
  const { home, project, configDir } = await fixture();
  await write(join(configDir, '.claude.json'), { mcpServers: { relocated: { command: 'r' } } });
  vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
  const names = (await readClaudeInventory({ home, project })).entries.filter(e => e.kind === 'mcp').map(e => e.name);
  expect(names).toContain('relocated');
  expect(names).not.toContain('db');
});

it('lets project settings enable a plugin and reports a broken .mcp.json', async () => {
  const { home, project, configDir } = await fixture();
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  await write(join(project, '.claude', 'settings.json'), { enabledPlugins: { 'impeccable@m': true } });
  await write(join(project, '.mcp.json'), '{ broken');
  const inventory = await readClaudeInventory({ home, project, configDir });
  expect(inventory.entries.map(e => e.name)).toContain('impeccable:polish');
  expect(inventory.problems).toEqual(['Could not parse ~/work/app/.mcp.json']);
});
