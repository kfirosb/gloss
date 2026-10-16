import { afterEach, expect, it } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudePeerSetting } from '../../src/runtime/claude-peer-setting.js';

const clean: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of clean.splice(0)) await close();
});
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'peer-setting-')));
  clean.push(() => rm(home, { recursive: true, force: true }));
  const configDir = join(home, '.claude');
  const managedDir = join(home, 'managed');
  const systemLibraryDir = join(home, 'system-library');
  const project = join(home, 'project');
  await mkdir(configDir);
  await mkdir(join(project, '.claude'), { recursive: true });
  return {
    home,
    configDir,
    managedDir,
    project,
    settings: join(configDir, 'settings.json'),
    peer: createClaudePeerSetting({ homeDir: home, configDir, managedDir, systemLibraryDir }),
  };
}

it('creates the user setting when settings.json is missing', async () => {
  const f = await fixture();
  expect(await f.peer.read(f.project)).toEqual({ user: 'unset' });
  expect(await f.peer.allowAll(f.project)).toEqual({ user: 'accept' });
  expect(JSON.parse(await readFile(f.settings, 'utf8'))).toEqual({ crossSessionInbound: 'accept' });
  expect((await stat(f.settings)).mode & 0o777).toBe(0o600);
});

it('keeps every other key and the file mode when allowing', async () => {
  const f = await fixture();
  const original = {
    model: 'opus',
    permissions: { allow: ['Bash(ls)'] },
    crossSessionInbound: 'hold',
  };
  await writeFile(f.settings, JSON.stringify(original, null, 2), { mode: 0o644 });
  await f.peer.allowAll(f.project);
  expect(JSON.parse(await readFile(f.settings, 'utf8'))).toEqual({
    ...original,
    crossSessionInbound: 'accept',
  });
  expect((await stat(f.settings)).mode & 0o777).toBe(0o644);
});

it('refuses an unparsable settings.json and leaves it byte-for-byte unchanged', async () => {
  const f = await fixture();
  await writeFile(f.settings, '{ "model": "opus", }');
  expect(await f.peer.read(f.project)).toEqual({ user: 'unreadable' });
  await expect(f.peer.allowAll(f.project)).rejects.toThrow(/settings\.json/);
  expect(await readFile(f.settings, 'utf8')).toBe('{ "model": "opus", }');
});

it('refuses a symlinked settings.json and keeps the link', async () => {
  const f = await fixture();
  const real = join(f.home, 'dotfiles-settings.json');
  await writeFile(real, '{"model":"opus"}');
  await symlink(real, f.settings);
  await expect(f.peer.allowAll(f.project)).rejects.toThrow(/link/);
  expect(await readlink(f.settings)).toBe(real);
  expect(await readFile(real, 'utf8')).toBe('{"model":"opus"}');
});

it('reports a repository or organization that forces hold, organization first, and never writes', async () => {
  const f = await fixture();
  await writeFile(
    join(f.project, '.claude', 'settings.local.json'),
    JSON.stringify({ crossSessionInbound: 'hold' }),
  );
  expect(await f.peer.read(f.project)).toEqual({
    user: 'unset',
    forcedBy: 'repository',
    forced: 'hold',
  });
  await expect(f.peer.allowAll(f.project)).rejects.toThrow(/repository/);
  await mkdir(f.managedDir);
  await writeFile(
    join(f.managedDir, 'managed-settings.json'),
    JSON.stringify({ crossSessionInbound: 'refuse' }),
  );
  expect(await f.peer.read(f.project)).toEqual({
    user: 'unset',
    forcedBy: 'organization',
    forced: 'refuse',
  });
});

it('treats a managed policy folder it cannot interpret as the organization controlling the setting', async () => {
  const f = await fixture();
  await mkdir(join(f.managedDir, 'managed-settings.d'), { recursive: true });
  expect(await f.peer.read(f.project)).toEqual({ user: 'unset', forcedBy: 'organization' });
  await expect(f.peer.allowAll(f.project)).rejects.toThrow(/organization/);
  await expect(stat(f.settings)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('treats an unreadable managed-settings.json as the organization controlling the setting', async () => {
  const f = await fixture();
  await mkdir(f.managedDir);
  await writeFile(join(f.managedDir, 'managed-settings.json'), '{ nope');
  expect(await f.peer.read(f.project)).toEqual({ user: 'unset', forcedBy: 'organization' });
  await expect(f.peer.allowAll(f.project)).rejects.toThrow(/organization/);
  await expect(stat(f.settings)).rejects.toMatchObject({ code: 'ENOENT' });
});
