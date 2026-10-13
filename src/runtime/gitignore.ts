import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
// `/x/`, `x/`, `/x` and `x` all ignore the folder x at the root for our purposes.
const normalize = (line: string) => line.trim().replace(/^\//, '').replace(/\/$/, '');
/** Adds `entry` to root/.gitignore unless an equivalent line exists, keeping the file's newline style. */
export async function ensureIgnoreEntry(root: string, entry: string): Promise<{ added: boolean; line: string }> {
  const file = join(root, '.gitignore');
  const existing = await readFile(file, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return undefined; throw e; });
  if (existing !== undefined && existing.split(/\r?\n/).some(l => normalize(l) === normalize(entry))) return { added: false, line: entry };
  const eol = existing?.includes('\r\n') ? '\r\n' : '\n';
  const prefix = existing === undefined || existing === '' ? '' : existing.endsWith('\n') ? existing : existing + eol;
  await writeFile(file, prefix + entry + eol);
  return { added: true, line: entry };
}
