import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expectedOutputSuffix,
  validateBackgroundOutputPath,
} from '../../src/agents/claude/background-output.js';

const uid = process.getuid!();
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bg-output-')));
  roots.push(root);
  const tasks = join(root, `claude-${uid}`, '-proj', 'session-1', 'tasks');
  await mkdir(tasks, { recursive: true });
  await writeFile(join(tasks, 't1.output'), 'hello\n');
  return { root, tasks };
}
const expected = { projectDirName: '-proj', sessionRef: 'session-1', taskId: 't1', uid };

it('builds the expected suffix', () => {
  expect(expectedOutputSuffix('-proj', 'session-1', 't1', 501)).toBe(
    join('claude-501', '-proj', 'session-1', 'tasks', 't1.output'),
  );
});

it('returns the real path of a matching output file', async () => {
  const { tasks } = await fixture();
  expect(await validateBackgroundOutputPath(join(tasks, 't1.output'), expected)).toBe(
    join(tasks, 't1.output'),
  );
});

it('rejects other sessions, other tasks, directories, symlinks and other owners', async () => {
  const { root, tasks } = await fixture();
  const file = join(tasks, 't1.output');
  await expect(
    validateBackgroundOutputPath(file, { ...expected, sessionRef: 'session-2' }),
  ).rejects.toThrow('Output unavailable');
  await expect(validateBackgroundOutputPath(file, { ...expected, taskId: 't2' })).rejects.toThrow(
    'Output unavailable',
  );
  await expect(validateBackgroundOutputPath(file, { ...expected, uid: uid + 1 })).rejects.toThrow(
    'Output unavailable',
  );
  await mkdir(join(tasks, 'd1.output'));
  await expect(
    validateBackgroundOutputPath(join(tasks, 'd1.output'), { ...expected, taskId: 'd1' }),
  ).rejects.toThrow('Output unavailable');
  const outside = join(root, 'outside.txt');
  await writeFile(outside, 'secret');
  await symlink(outside, join(tasks, 'l1.output'));
  await expect(
    validateBackgroundOutputPath(join(tasks, 'l1.output'), { ...expected, taskId: 'l1' }),
  ).rejects.toThrow('Output unavailable');
  await expect(
    validateBackgroundOutputPath(join(tasks, 'missing.output'), { ...expected, taskId: 'missing' }),
  ).rejects.toThrow('Output unavailable');
});

it('requires the suffix on a path-separator boundary', async () => {
  const { root } = await fixture();
  const tasks = join(root, `xclaude-${uid}`, '-proj', 'session-1', 'tasks');
  await mkdir(tasks, { recursive: true });
  await writeFile(join(tasks, 't1.output'), 'x');
  await expect(validateBackgroundOutputPath(join(tasks, 't1.output'), expected)).rejects.toThrow(
    'Output unavailable',
  );
});

it('rejects identifiers that are not a single path segment', async () => {
  const { root, tasks } = await fixture();
  const escaped = join(root, 'outside.output');
  await writeFile(escaped, 'secret');
  await expect(
    validateBackgroundOutputPath(escaped, { ...expected, taskId: '../../../../outside' }),
  ).rejects.toThrow('Output unavailable');
  await expect(
    validateBackgroundOutputPath(join(tasks, 't1.output'), { ...expected, taskId: 'a/t1' }),
  ).rejects.toThrow('Output unavailable');
  await expect(
    validateBackgroundOutputPath(join(tasks, 't1.output'), {
      ...expected,
      sessionRef: 'x/session-1',
    }),
  ).rejects.toThrow('Output unavailable');
  await expect(
    validateBackgroundOutputPath(join(tasks, 't1.output'), { ...expected, projectDirName: '..' }),
  ).rejects.toThrow('Output unavailable');
});
