import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
// A missing executable and a missing cwd both surface as ENOENT; only the former means rg is absent.
function spawnFailure(error: NodeJS.ErrnoException, root: string): Error {
  if (error.code !== 'ENOENT' || !existsSync(root)) return error;
  return Object.assign(new Error('File search needs ripgrep (rg); install it, for example with brew install ripgrep'), { code: 'search-unavailable' });
}
const escapeGlob = (path: string) => path.replace(/[\\*?[\]{}!]/g, '\\$&');
/**
 * ripgrep argv; `excludes` are worktree folders nested under the root, relative to it. `.worktrees` is always skipped.
 * A leading `/` anchors each exclusion to the search root (gitignore semantics), so `docs` never hides other `docs` folders.
 */
export function inventoryArgs(excludes: readonly string[] = []): string[] {
  const nested = excludes.filter(Boolean).flatMap(path => { const glob = escapeGlob(path); return ['-g', '!/' + glob, '-g', '!/' + glob + '/**']; });
  return ['--files', '--hidden', '--null', '--no-require-git', '-g', '!.git', '-g', '!node_modules', '-g', '!dist', '-g', '!build', '-g', '!/.worktrees', ...nested];
}
export function fileInventory(root: string, signal: AbortSignal, excludes: readonly string[] = []): Promise<{ paths: string[]; limited: boolean }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn('rg', inventoryArgs(excludes), { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = []; let bytes = 0; let candidates = 0; let capped = false;
    const abort = () => { child.kill(); };
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => { capped = true; child.kill(); }, 3000);
    const cleanup = () => { clearTimeout(timeout); signal.removeEventListener('abort', abort); };
    child.stdout.on('data', (chunk: Buffer) => {
      if (capped) return;
      let end = Math.min(chunk.length, 2 * 1024 * 1024 - bytes);
      for (let i = 0; i < end; i++) if (chunk[i] === 0 && ++candidates === 10000) { end = i + 1; capped = true; break; }
      chunks.push(chunk.subarray(0,end)); bytes += end;
      if (bytes >= 2 * 1024 * 1024) capped = true;
      if (capped) child.kill();
    });
    child.once('error', error => { cleanup(); reject(spawnFailure(error, root)); });
    child.once('close', code => {
      cleanup();
      if (signal.aborted) { reject(signal.reason ?? new Error('Search cancelled')); return; }
      if (!capped && code !== 0 && code !== 1) { reject(new Error('File search failed')); return; }
      const paths = Buffer.concat(chunks).toString('utf8').split('\0'); paths.pop();
      resolve({paths,limited:capped});
    });
  });
}

export async function searchFiles(root: string, query: string, signal: AbortSignal, excludes: readonly string[] = []): Promise<{ relativePath: string; name: string }[]> {
  if (typeof query !== 'string' || query.length > 1000) throw new Error('Invalid file search query');
  const {paths} = await fileInventory(root, signal, excludes);
  return paths.filter(path => path.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0,50).map(relativePath => ({ relativePath, name: basename(relativePath) }));
}
