import { isAbsolute, relative, sep } from 'node:path';

/** True when `candidate` is `root` or lies below it, compared lexically (callers resolve symlinks first). */
export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}
