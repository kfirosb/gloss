import { access, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { collectProcess, runProcess, type ProcessRunner } from './process-runner.js';

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
  const rel = relative(home, path);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return none;
  return {
    hits: [{ path, name: basename(path), git: await isGit(path) }],
    timedOut: false,
    unavailable: false,
  };
}

export async function searchFolders(
  query: string,
  options: {
    home: string;
    runner?: ProcessRunner;
    timeoutMs?: number;
    limit?: number;
    isGit?: (path: string) => Promise<boolean>;
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
    const rel = relative(home, path);
    if (!rel || rel.startsWith('..') || skipped(rel.split(sep))) continue;
    hits.push({ path, name: basename(path), git: await isGit(path) });
  }
  return { hits, timedOut: result.outcome.reason === 'timeout', unavailable: false };
}
