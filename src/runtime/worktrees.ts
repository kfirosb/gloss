import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { ensureIgnoreEntry } from './gitignore.js';
import { collectProcess, runProcess, type ProcessRunner } from './process-runner.js';

export interface WorktreeInfo { path: string; branch?: string; main: boolean; detached: boolean; locked: boolean; prunable: boolean }
export interface WorktreeInspection {
  path: string; branch?: string; modified: number; untracked: number; oldestChange?: number; newestChange?: number; unmergedCommits: number;
  /** At most MAX_CHANGED_FILES entries; `truncated` is set when more changed. `modified`/`untracked` stay exact. */
  changedFiles: { path: string; status: string; changedAt?: number }[]; truncated?: true;
}
export interface WorktreeService {
  list(mainCheckout: string): Promise<WorktreeInfo[]>;
  inspect(mainCheckout: string, worktreePath: string): Promise<WorktreeInspection>;
  /** `location` in the result is the canonical directory (`~` expanded, real path) the worktree was created in. */
  create(mainCheckout: string, name: string, location: string): Promise<{ path: string; branch: string; location: string; ignore?: { added: boolean; line: string } }>;
  remove(mainCheckout: string, worktreePath: string): Promise<void>;
  initGit(folder: string): Promise<void>;
  hasCommits(mainCheckout: string): Promise<boolean>;
}
export const WORKTREE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED = new Set(['main', 'master', 'HEAD']);
export const MAX_CHANGED_FILES = 500;

const firstLine = (text: string) => text.split(/\r?\n/).map(line => line.trim()).find(Boolean);
const gitError = (message: string) => Object.assign(new Error(message), { code: 'git' });
const real = (path: string) => realpath(path).catch(() => path);
/** True when `candidate` is `root` or a path below it (string comparison; see insideFolderReal). */
export const insideFolder = (candidate: string, root: string) => candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
/** insideFolder on real paths where they exist, falling back to the given strings (for folders already removed). */
export async function insideFolderReal(candidate: string, root: string): Promise<boolean> {
  if (insideFolder(candidate, root)) return true;
  const [c, r] = await Promise.all([real(candidate), real(root)]);
  return insideFolder(c, r);
}
const inside = (parent: string, child: string) => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel)); };

export function createWorktreeService(options: { runner?: ProcessRunner } = {}): WorktreeService {
  const runner = options.runner ?? runProcess;
  const git = async (cwd: string, args: string[], timeoutMs = 20_000) => {
    const result = await collectProcess(runner('git', args, '', AbortSignal.timeout(timeoutMs + 1000), { cwd, timeoutMs, maxOutputBytes: 4 * 1024 * 1024, maxDiagnosticBytes: 4096 }));
    if (result.outcome.reason !== 'exited' || result.outcome.code !== 0) throw gitError(firstLine(result.outcome.diagnostics) || 'Git command failed');
    return result.lines;
  };
  const succeeds = (cwd: string, args: string[]) => git(cwd, args).then(() => true, () => false);
  const hasCommits = (mainCheckout: string) => succeeds(mainCheckout, ['rev-parse', '--verify', '--quiet', 'HEAD']);

  async function list(mainCheckout: string): Promise<WorktreeInfo[]> {
    const lines = await git(mainCheckout, ['worktree', 'list', '--porcelain']);
    const blocks: string[][] = [[]];
    for (const line of lines) { if (line === '') blocks.push([]); else blocks.at(-1)!.push(line); }
    const parsed = blocks.filter(block => block[0]?.startsWith('worktree '));
    return Promise.all(parsed.map(async (block, index) => {
      const field = (name: string) => block.find(line => line === name || line.startsWith(name + ' '));
      const branch = field('branch')?.slice('branch '.length).replace(/^refs\/heads\//, '');
      return { path: await real(block[0]!.slice('worktree '.length)), ...(branch ? { branch } : {}), main: index === 0,
        detached: field('detached') !== undefined, locked: field('locked') !== undefined, prunable: field('prunable') !== undefined };
    }));
  }
  async function member(mainCheckout: string, worktreePath: string) {
    const target = await real(worktreePath);
    const found = (await list(mainCheckout)).find(worktree => worktree.path === target);
    if (!found) throw gitError('This path is not a worktree of this project.');
    return found;
  }
  async function baseBranch(cwd: string) {
    const remote = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).then(lines => lines[0]?.trim(), () => undefined);
    if (remote) return remote;
    for (const name of ['main', 'master']) if (await succeeds(cwd, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + name])) return name;
    return undefined;
  }
  return {
    list, hasCommits,
    async inspect(mainCheckout, worktreePath) {
      const worktree = await member(mainCheckout, worktreePath);
      // -z output is NUL separated; renames and copies carry their source path as an extra entry.
      const entries = (await git(worktree.path, ['status', '--porcelain=v1', '-z'])).join('\n').split('\0').filter(Boolean);
      const changedFiles: WorktreeInspection['changedFiles'] = [];
      let modified = 0; let untracked = 0;
      for (let i = 0; i < entries.length; i += 1) {
        const status = entries[i]!.slice(0, 2); const path = entries[i]!.slice(3);
        if (/[RC]/.test(status[0]!)) i += 1;
        if (status === '??') untracked += 1; else modified += 1;
        if (changedFiles.length < MAX_CHANGED_FILES) changedFiles.push({ path, status: status.trim() || status });
      }
      await Promise.all(changedFiles.map(async file => {
        try { file.changedAt = Math.round((await stat(join(worktree.path, file.path))).mtimeMs); } catch { /* deleted or unreadable */ }
      }));
      const times = changedFiles.flatMap(file => file.changedAt === undefined ? [] : [file.changedAt]);
      const base = await baseBranch(worktree.path);
      const unmergedCommits = base ? await git(worktree.path, ['rev-list', '--count', base + '..HEAD']).then(lines => Number(lines[0]) || 0, () => 0) : 0;
      return { path: worktree.path, ...(worktree.branch ? { branch: worktree.branch } : {}), modified, untracked,
        ...(times.length ? { oldestChange: Math.min(...times), newestChange: Math.max(...times) } : {}), unmergedCommits, changedFiles,
        ...(modified + untracked > changedFiles.length ? { truncated: true as const } : {}) };
    },
    async create(mainCheckout, name, location) {
      if (typeof name !== 'string' || !WORKTREE_NAME.test(name)) throw gitError('Use letters, numbers, hyphens or underscores for this folder name.');
      if (RESERVED.has(name)) throw gitError(`The name ${name} is reserved; choose another one.`);
      const main = await realpath(mainCheckout);
      if (!(await hasCommits(main))) throw gitError('Make a first commit in this project, then create a worktree.');
      const expanded = typeof location === 'string' && location.startsWith('~/') ? join(homedir(), location.slice(2)) : location;
      if (typeof expanded !== 'string' || !isAbsolute(expanded)) throw gitError('Choose an absolute folder for worktrees.');
      const parent = await realpath(dirname(expanded)).catch(() => { throw gitError('The folder for worktrees is unavailable.'); });
      const where = join(parent, basename(expanded));
      if ((await git(main, ['branch', '--list', name])).some(line => line.trim())) throw gitError(`A branch named ${name} already exists.`);
      const target = join(where, name);
      if (await stat(target).then(() => true, () => false)) throw gitError(`A folder named ${name} already exists there.`);
      await git(main, ['worktree', 'add', '-b', name, target, 'HEAD'], 60_000);
      const path = await real(target); const canonical = await real(where);
      if (!inside(main, where)) return { path, branch: name, location: canonical };
      const rel = relative(main, where).split(sep).join('/');
      const ignore = await ensureIgnoreEntry(main, '/' + (rel || name) + '/');
      return { path, branch: name, location: canonical, ignore };
    },
    async remove(mainCheckout, worktreePath) {
      const main = await realpath(mainCheckout); const target = await real(worktreePath);
      if (target === main) throw gitError('The main checkout cannot be deleted from here.');
      const found = await member(main, target);
      if (found.main) throw gitError('The main checkout cannot be deleted from here.');
      await git(main, ['worktree', 'remove', '--force', found.path], 60_000);
      await git(main, ['worktree', 'prune']);
    },
    async initGit(folder) { await git(folder, ['init', '-b', 'main']); },
  };
}

/**
 * Worktree folders nested under `root`, relative to it, found by running `git worktree list` in the root itself
 * (so no project key is needed). Cached per root for `ttlMs`; a folder outside Git has none.
 */
export function createNestedWorktreeLookup(service: Pick<WorktreeService, 'list'> = createWorktreeService(), ttlMs = 30_000): (root: string) => Promise<string[]> {
  const cache = new Map<string, { at: number; value: Promise<string[]> }>();
  return root => {
    const hit = cache.get(root);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = service.list(root).then(
      worktrees => worktrees.filter(w => w.path !== root && inside(root, w.path)).map(w => relative(root, w.path)),
      () => [] as string[]);
    if (cache.size > 200) cache.clear();
    cache.set(root, { at: Date.now(), value });
    return value;
  };
}
