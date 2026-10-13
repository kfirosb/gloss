import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readProjectMetadata } from '../../src/runtime/project-metadata.js';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim();
let temporary: string;
beforeEach(async () => { temporary = await realpath(await mkdtemp(join(tmpdir(), 'project-metadata-'))); });
afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });
async function repository(path: string) {
  await mkdir(path, { recursive: true });
  await git(path, 'init', '-b', 'main');
  await git(path, '-c', 'user.name=Metadata Test', '-c', 'user.email=metadata@example.test', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Initial');
  return path;
}

describe('canonical project grouping', () => {
  it('groups linked worktrees while retaining their separate roots and worktree paths', async () => {
    const root = await repository(join(temporary, 'project'));
    const linked = join(temporary, 'linked');
    await git(root, 'worktree', 'add', '-b', 'feature', linked);
    const primary = await readProjectMetadata(root);
    const secondary = await readProjectMetadata(linked);
    expect(primary.projectKey).toBe(join(root, '.git'));
    expect(secondary.projectKey).toBe(primary.projectKey);
    expect(primary.canonicalRoot).toBe(root);
    expect(secondary.canonicalRoot).toBe(linked);
    expect(primary.worktreePath).toBe(root);
    expect(secondary.worktreePath).toBe(linked);
    expect(secondary.branch).toBe('feature');
  });

  it('keeps repositories with the same display name in distinct groups', async () => {
    const first = await readProjectMetadata(await repository(join(temporary, 'one', 'project')));
    const second = await readProjectMetadata(await repository(join(temporary, 'two', 'project')));
    expect(first.projectName).toBe(second.projectName);
    expect(first.projectKey).toBeTruthy();
    expect(second.projectKey).not.toBe(first.projectKey);
  });

  it('groups repository symlink aliases by canonical identity', async () => {
    const root = await repository(join(temporary, 'project'));
    const alias = join(temporary, 'alias');
    await symlink(root, alias);
    const metadata = await readProjectMetadata(alias);
    expect(metadata.projectKey).toBe(join(root, '.git'));
    expect(metadata.worktreePath).toBe(root);
  });

  it('groups ordinary folder aliases but keeps same-name folders separate', async () => {
    const folder = join(temporary, 'one', 'folder');
    const other = join(temporary, 'two', 'folder');
    const alias = join(temporary, 'alias');
    await mkdir(folder, { recursive: true });
    await mkdir(other, { recursive: true });
    await symlink(folder, alias);
    const metadata = await readProjectMetadata(folder);
    expect(metadata.projectKey).toBe(folder);
    expect((await readProjectMetadata(alias)).projectKey).toBe(folder);
    expect((await readProjectMetadata(other)).projectKey).toBe(other);
    expect(metadata.worktreePath).toBeUndefined();
  });

  it('labels detached HEAD with its short commit', async () => {
    const root = await repository(join(temporary, 'project'));
    const commit = await git(root, 'rev-parse', '--short', 'HEAD');
    await git(root, 'checkout', '--detach');
    expect((await readProjectMetadata(root)).branch).toBe(commit);
  });

  it('marks missing folders unavailable and gives same-name targets distinct fallback keys', async () => {
    const first = join(temporary, 'one', 'missing');
    const second = join(temporary, 'two', 'missing');
    const metadata = await readProjectMetadata(first);
    expect(metadata.available).toBe(false);
    expect(metadata.canonicalRoot).toBe('');
    expect(metadata.projectKey).toBe(first);
    expect((await readProjectMetadata(second)).projectKey).toBe(second);
  });
});
