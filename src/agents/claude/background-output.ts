import { lstat, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';

export interface ExpectedOutput {
  projectDirName: string;
  sessionRef: string;
  taskId: string;
  uid: number;
}

const UNAVAILABLE = 'Output unavailable';

/** Where Claude writes a background task's output, relative to its (platform specific) tmp base. */
export function expectedOutputSuffix(
  projectDirName: string,
  sessionRef: string,
  taskId: string,
  uid: number,
): string {
  return join(`claude-${uid}`, projectDirName, sessionRef, 'tasks', `${taskId}.output`);
}

/**
 * Trust boundary for a path read from the transcript: the file must be exactly this session's
 * task output, a regular file owned by the current user, reached without a final-component symlink.
 */
export async function validateBackgroundOutputPath(
  candidate: string,
  expected: ExpectedOutput,
  io = { realpath, lstat },
): Promise<string> {
  try {
    if ((await io.lstat(candidate)).isSymbolicLink()) throw new Error(UNAVAILABLE);
    const real = await io.realpath(candidate);
    const suffix = expectedOutputSuffix(
      expected.projectDirName,
      expected.sessionRef,
      expected.taskId,
      expected.uid,
    );
    if (!real.endsWith(sep + suffix)) throw new Error(UNAVAILABLE);
    const info = await io.lstat(real);
    if (!info.isFile() || info.uid !== expected.uid) throw new Error(UNAVAILABLE);
    return real;
  } catch {
    throw new Error(UNAVAILABLE);
  }
}
