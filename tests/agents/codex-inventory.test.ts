import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCodexMcpServers, readCodexInventory } from '../../src/agents/codex/inventory.js';

const cleanups: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), 'codex-inventory-')); cleanups.push(dir); return dir; };
const write = async (path: string, body: string) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, body); };
const skill = (root: string, name: string) => write(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: About ${name}\n---\n`);

it('reads mcp_servers tables, quoted names and inline tables, ignoring nested tool tables', () => {
  const toml = [
    'model = "gpt"',
    '[mcp_servers.playwright]',
    'command = "npx"',
    'args = ["-y", "@playwright/mcp@latest"]',
    '[mcp_servers.playwright.tools.browser_fill_form]',
    'approval_mode = "approve"',
    '[mcp_servers."docs.site"]',
    "url = 'https://docs.example.com/mcp?key=secret'",
    '[mcp_servers]',
    'inline = { command = "inline-mcp", env = { K = "v" } }',
    '[[array_table]]',
    'x = 1',
  ].join('\n');
  expect(parseCodexMcpServers(toml)).toEqual({ ok: true, servers: {
    playwright: { command: 'npx' },
    'docs.site': { url: 'https://docs.example.com/mcp?key=secret' },
    inline: { command: 'inline-mcp' },
  } });
  expect(parseCodexMcpServers('[mcp_servers]\nbroken = { command = \n').ok).toBe(false);
});

it('merges Codex and shared agent skills with config.toml MCP servers', async () => {
  const home = await temp(); const project = join(home, 'app'); const codexHome = join(home, '.codex');
  vi.stubEnv('CODEX_HOME', '');
  await skill(join(codexHome, 'skills'), 'cloudflare');
  await skill(join(codexHome, 'skills', '.system'), 'hidden-system');
  await skill(join(home, '.agents', 'skills'), 'superset-browser');
  await skill(join(project, '.agents', 'skills'), 'repo-skill');
  await skill(join(project, '.codex', 'skills'), 'cloudflare');
  await write(join(codexHome, 'config.toml'), '[mcp_servers.playwright]\ncommand = "/opt/bin/npx"\nenv = { TOKEN = "secret" }\n');
  await write(join(project, '.codex', 'config.toml'), '[mcp_servers.local]\nurl = "https://local.example.com/x"\n');
  const inventory = await readCodexInventory({ home, project });
  expect(inventory.problems).toEqual([]);
  expect(inventory.entries).toEqual([
    { kind: 'mcp', name: 'local', scope: 'project', transport: 'http', target: 'https://local.example.com' },
    { kind: 'mcp', name: 'playwright', scope: 'global', transport: 'stdio', target: 'npx' },
    { kind: 'skill', name: 'cloudflare', description: 'About cloudflare', scope: 'project' },
    { kind: 'skill', name: 'repo-skill', description: 'About repo-skill', scope: 'project' },
    { kind: 'skill', name: 'superset-browser', description: 'About superset-browser', scope: 'global' },
  ]);
  expect(JSON.stringify(inventory)).not.toContain('secret');
});

it('reports an unreadable config.toml and still lists skills', async () => {
  const home = await temp(); const codexHome = join(home, 'codex-home');
  await skill(join(codexHome, 'skills'), 'kept');
  await write(join(codexHome, 'config.toml'), '[mcp_servers]\nbroken = { command = \n');
  const inventory = await readCodexInventory({ home, project: join(home, 'app'), codexHome });
  expect(inventory.entries.map(e => e.name)).toEqual(['kept']);
  expect(inventory.problems).toEqual(['Could not fully read MCP servers in ~/codex-home/config.toml']);
});

it('keeps a later command after a multi-line array in the same table', () => {
  expect(parseCodexMcpServers('[mcp_servers.a]\nargs = [\n "x",\n ["y"]\n]\ncommand = "late"')).toEqual({ ok: true, servers: { a: { command: 'late' } } });
});

it('reports multi-line strings for mcp_servers commands as unreadable', () => {
  expect(parseCodexMcpServers('[mcp_servers.x]\ncommand = """multi\nline"""').ok).toBe(false);
  expect(parseCodexMcpServers("[mcp_servers.x]\ncommand = '''multi\nline'''").ok).toBe(false);
});

it('reports an unclosed header as unreadable and reads a quoted mcp_servers root only when the whole key is parsed', () => {
  expect(parseCodexMcpServers('[mcp_servers.x\ncommand = "npx"').ok).toBe(false);
  expect(parseCodexMcpServers('["mcp_servers"].x\ncommand = "npx"').ok).toBe(false);
  expect(parseCodexMcpServers('[ "mcp_servers" .x ]\ncommand = "npx"')).toEqual({ ok: true, servers: { x: { command: 'npx' } } });
});

it('parses a realistic config with hook state and nested tool tables', () => {
  const toml = [
    '[hooks.state."/Users/x/.codex/hooks.json:session_end:0:0"]',
    'trusted_hash = "sha256:..."',
    '[mcp_servers.playwright]',
    'command = "npx"',
    'args = ["-y", "@playwright/mcp@latest", "--extension"]',
    '[mcp_servers.playwright.tools.browser_fill_form]',
    'approval_mode = "approve"',
  ].join('\n');
  expect(parseCodexMcpServers(toml)).toEqual({ ok: true, servers: { playwright: { command: 'npx' } } });
});
