import { access, opendir, realpath, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { collectProcess, runProcess, type ProcessRunner } from './process-runner.js';
import { isWithin } from './path-containment.js';

export interface FolderHit {
  path: string;
  name: string;
  git: boolean;
}
export interface FolderSearchResult {
  hits: FolderHit[];
  timedOut: boolean;
  unavailable: boolean;
}

/** Spotlight predicate: folders whose name contains the query, with metacharacters escaped. */
export const mdfindPredicate = (query: string) =>
  `kMDItemContentType == 'public.folder' && kMDItemFSName == '*${query.replace(/[\\"'*?]/g, (c) => '\\' + c)}*'c`;

const skipped = (segments: string[]) =>
  segments[0] === 'Library' ||
  segments.some((s) => s === 'node_modules' || s === '.worktrees' || s.startsWith('.'));

const hasGitEntry = (path: string) =>
  access(join(path, '.git')).then(
    () => true,
    () => false,
  );

/** A typed `/…` or `~/…` path is its own single candidate: an existing directory below home (hidden folders included). */
async function pathCandidate(
  q: string,
  rawHome: string,
  home: string,
  isGit: (path: string) => Promise<boolean>,
): Promise<FolderSearchResult> {
  const none = { hits: [], timedOut: false, unavailable: false };
  const path = await realpath(q.startsWith('~/') ? join(rawHome, q.slice(2)) : q).catch(
    () => undefined,
  );
  if (
    !path ||
    !(await stat(path).then(
      (s) => s.isDirectory(),
      () => false,
    ))
  )
    return none;
  if (path === home || !isWithin(home, path)) return none;
  return {
    hits: [{ path, name: basename(path), git: await isGit(path) }],
    timedOut: false,
    unavailable: false,
  };
}

/** Deepest folder level the walk visits below home; project folders live near the top. */
const WALK_MAX_DEPTH = 8;

/**
 * Without Spotlight: a breadth-first walk of real directories under home (symlinks are not followed), matching the
 * query against each folder name case-insensitively. Stops at `limit` hits or at the deadline, in which case the
 * partial result says so.
 */
async function walkFolders(
  home: string,
  query: string,
  options: { limit: number; timeoutMs: number; isGit: (path: string) => Promise<boolean> },
): Promise<FolderSearchResult> {
  const deadline = Date.now() + options.timeoutMs;
  const needle = query.toLowerCase();
  const hits: FolderHit[] = [];
  const queue: { path: string; depth: number }[] = [{ path: home, depth: 0 }];
  for (let next = queue.shift(); next; next = queue.shift()) {
    if (Date.now() >= deadline) return { hits, timedOut: true, unavailable: false };
    let entries: string[];
    try {
      entries = [];
      for await (const entry of await opendir(next.path))
        if (entry.isDirectory()) entries.push(entry.name);
    } catch {
      continue; // Unreadable folders are simply not searched.
    }
    for (const name of entries.sort()) {
      const path = join(next.path, name);
      if (skipped(relative(home, path).split(sep))) continue;
      if (name.toLowerCase().includes(needle)) {
        hits.push({ path, name, git: await options.isGit(path) });
        if (hits.length >= options.limit) return { hits, timedOut: false, unavailable: false };
      }
      if (next.depth + 1 < WALK_MAX_DEPTH) queue.push({ path, depth: next.depth + 1 });
    }
  }
  return { hits, timedOut: false, unavailable: false };
}

export async function searchFolders(
  query: string,
  options: {
    home: string;
    runner?: ProcessRunner;
    timeoutMs?: number;
    limit?: number;
    isGit?: (path: string) => Promise<boolean>;
    platform?: NodeJS.Platform;
  },
): Promise<FolderSearchResult> {
  const q = (query ?? '').trim();
  const isPath = q.startsWith('/') || q.startsWith('~/');
  if (!q || q.length > (isPath ? 4096 : 120))
    throw new Error('Enter a folder name of up to 120 characters');
  const runner = options.runner ?? runProcess;
  const limit = options.limit ?? 50;
  const timeoutMs = options.timeoutMs ?? 2000;
  const isGit = options.isGit ?? hasGitEntry;
  const home = await realpath(options.home).catch(() => options.home);
  if (isPath) return pathCandidate(q, options.home, home, isGit);
  if ((options.platform ?? process.platform) !== 'darwin')
    return walkFolders(home, q, { limit, timeoutMs, isGit });
  const result = await collectProcess(
    runner(
      '/usr/bin/mdfind',
      ['-onlyin', home, mdfindPredicate(q)],
      '',
      AbortSignal.timeout(timeoutMs + 500),
      { timeoutMs, maxOutputBytes: 1024 * 1024, maxLineBytes: 8192 },
    ),
  );
  const { reason, code } = result.outcome;
  if (
    reason === 'spawn-error' ||
    reason === 'output-limit' ||
    reason === 'cancelled' ||
    (reason === 'exited' && code !== 0)
  )
    return { hits: [], timedOut: false, unavailable: true };
  const hits: FolderHit[] = [];
  const seen = new Set<string>();
  for (const line of result.lines) {
    if (hits.length >= limit) break;
    const path = await realpath(line).catch(() => undefined);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    if (path === home || !isWithin(home, path) || skipped(relative(home, path).split(sep)))
      continue;
    hits.push({ path, name: basename(path), git: await isGit(path) });
  }
  return { hits, timedOut: result.outcome.reason === 'timeout', unavailable: false };
}
