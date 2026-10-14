import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpEntries, mergeEntries, parseFrontmatter, readJsonConfig, readSkillDir, type InventoryEntry } from '../../src/agents/inventory.js';

const cleanups: string[] = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), 'inventory-')); cleanups.push(dir); return dir; };
const skill = async (root: string, folder: string, body: string) => { await mkdir(join(root, folder), { recursive: true }); await writeFile(join(root, folder, 'SKILL.md'), body); };

it('reads name and description from frontmatter, including folded descriptions', () => {
  expect(parseFrontmatter('---\nname: frontend-design\ndescription: "Build UIs"\n---\nbody')).toEqual({ name: 'frontend-design', description: 'Build UIs' });
  expect(parseFrontmatter('---\nname: x\ndescription: >-\n  first line\n  second line\nother: 1\n---\n')).toEqual({ name: 'x', description: 'first line second line' });
  expect(parseFrontmatter('no frontmatter')).toEqual({});
});

it('lists skill folders, falls back to the folder name, follows symlinks and skips folders without SKILL.md', async () => {
  const home = await temp(); const dir = join(home, 'skills');
  await skill(dir, 'alpha', '---\nname: alpha\ndescription: First\n---\n');
  await skill(dir, 'beta', '---\ndescription: ' + 'long '.repeat(100) + '\n---\n');
  await mkdir(join(dir, 'not-a-skill'));
  await mkdir(join(dir, '.hidden'));
  const elsewhere = join(home, 'elsewhere'); await skill(elsewhere, 'gamma', '---\nname: gamma\n---\n');
  await symlink(join(elsewhere, 'gamma'), join(dir, 'gamma'));
  const ctx = { home, problems: [] as string[] };
  const entries = await readSkillDir(dir, 'global', ctx);
  expect(entries.map(e => e.name).sort()).toEqual(['alpha', 'beta', 'gamma']);
  const beta = entries.find(e => e.name === 'beta')!;
  expect(beta.description!.length).toBeLessThanOrEqual(300);
  expect(beta.description).not.toMatch(/\s{2}/);
  expect(ctx.problems).toEqual([]);
});

it('prefixes plugin skills and treats a missing directory as empty', async () => {
  const home = await temp(); const dir = join(home, 'skills');
  await skill(dir, 'brainstorming', '---\nname: brainstorming\n---\n');
  const ctx = { home, problems: [] as string[] };
  expect(await readSkillDir(dir, 'plugin', ctx, 'superpowers')).toEqual([{ kind: 'skill', name: 'superpowers:brainstorming', scope: 'plugin', plugin: 'superpowers' }]);
  expect(await readSkillDir(join(home, 'missing'), 'global', ctx)).toEqual([]);
  expect(ctx.problems).toEqual([]);
});

it('caps a huge skill directory and reports it', async () => {
  const home = await temp(); const dir = join(home, 'skills');
  for (let i = 0; i < 505; i++) await skill(dir, 's' + i, '---\nname: s' + i + '\n---\n');
  const ctx = { home, problems: [] as string[] };
  expect((await readSkillDir(dir, 'global', ctx)).length).toBe(500);
  expect(ctx.problems).toEqual(['Only the first 500 skills in ~/skills are listed']);
});

it('reports malformed and oversized JSON without contents, and ignores missing files', async () => {
  const home = await temp(); const ctx = { home, problems: [] as string[] };
  await writeFile(join(home, 'bad.json'), '{"secret": "tok');
  await writeFile(join(home, 'big.json'), JSON.stringify({ pad: 'x'.repeat(2048) }));
  expect(await readJsonConfig(join(home, 'bad.json'), ctx)).toBeUndefined();
  expect(await readJsonConfig(join(home, 'big.json'), ctx, 1024)).toBeUndefined();
  expect(await readJsonConfig(join(home, 'none.json'), ctx)).toBeUndefined();
  expect(ctx.problems).toEqual(['Could not parse ~/bad.json', '~/big.json is too large to read']);
  expect(ctx.problems.join()).not.toContain('tok');
});

it('describes MCP servers without secrets', () => {
  const entries = mcpEntries({
    local: { command: '/usr/local/bin/node', args: ['--token', 'abc'], env: { KEY: 'secret' } },
    remote: { type: 'http', url: 'https://mcp.example.com/v1?key=secret', headers: { Authorization: 'Bearer x' } },
    events: { type: 'sse', url: 'not a url' },
    'bad name!': { command: 'x' },
    broken: 'nope',
  }, 'global');
  expect(entries).toEqual([
    { kind: 'mcp', name: 'local', scope: 'global', transport: 'stdio', target: 'node' },
    { kind: 'mcp', name: 'remote', scope: 'global', transport: 'http', target: 'https://mcp.example.com' },
    { kind: 'mcp', name: 'events', scope: 'global', transport: 'sse' },
  ]);
  expect(JSON.stringify(entries)).not.toMatch(/secret|abc|Bearer/);
});

it('keeps the project entry over plugin and global ones and sorts the result', () => {
  const e = (name: string, scope: InventoryEntry['scope'], kind: InventoryEntry['kind'] = 'skill'): InventoryEntry => ({ kind, name, scope });
  expect(mergeEntries([e('b', 'global'), e('a', 'global'), e('a', 'project'), e('x', 'plugin', 'mcp'), e('x', 'global', 'mcp'), e('a', 'global', 'mcp')]))
    .toEqual([e('a', 'global', 'mcp'), e('x', 'plugin', 'mcp'), e('a', 'project'), e('b', 'global')]);
});
