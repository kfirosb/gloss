import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { collectProcess, runProcess, type ProcessRunner } from './process-runner.js';

export interface ProjectMetadata { canonicalRoot: string; projectName: string; projectKey?: string; branch?: string; worktreePath?: string; available: boolean }
export async function readProjectMetadata(path: string, runner: ProcessRunner = runProcess): Promise<ProjectMetadata> {
  let folder: string;
  try {
    folder = await realpath(path);
    if (!(await stat(folder)).isDirectory()) throw new Error('Not a directory');
  } catch { return { canonicalRoot: '', projectName: basename(path), projectKey: resolve(path), available: false }; }
  const git = async (...flags: string[]) => {
    const result = await collectProcess(runner('git', ['rev-parse', ...flags], '', new AbortController().signal, { cwd: folder, timeoutMs: 5000, maxOutputBytes: 16384 }));
    return result.outcome.reason === 'exited' && result.outcome.code === 0 ? result.lines.join('\n').trim() : undefined;
  };
  const root = await git('--show-toplevel');
  if (!root) return { canonicalRoot: folder, projectName: basename(folder), projectKey: folder, available: true };
  const canonicalRoot = await realpath(root);
  const common = await git('--git-common-dir');
  const head = await git('--abbrev-ref', 'HEAD');
  const branch = head === 'HEAD' ? await git('--short', 'HEAD') : head;
  const commonPath = common ? await realpath(resolve(folder, common)).catch(() => undefined) : undefined;
  return { canonicalRoot, projectName: basename(commonPath ? dirname(commonPath) : canonicalRoot), projectKey: commonPath ?? canonicalRoot, worktreePath: canonicalRoot, ...(branch ? { branch } : {}), available: true };
}
