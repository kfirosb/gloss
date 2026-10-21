import { expect, it } from 'vitest';
// @ts-expect-error untyped desktop module
import { createRevealHandler } from '../../desktop/reveal-path.mjs';

type Location = { path: unknown; kind: unknown };
function harness(location: Location | Error, directoryNow = true) {
  const calls: string[] = [];
  const handler = createRevealHandler({
    locate: async (sessionId: string, relativePath: string) => {
      calls.push(`locate ${sessionId} ${relativePath}`);
      if (location instanceof Error) throw location;
      return location;
    },
    showItemInFolder: (path: string) => calls.push('reveal ' + path),
    openPath: async (path: string) => {
      calls.push('open ' + path);
      return '';
    },
    isDirectory: () => directoryNow,
  });
  return { calls, handler };
}

it('reveals a file without opening it, and opens a folder', async () => {
  const file = harness({ path: '/work/src/app.ts', kind: 'file' });
  expect(await file.handler.handle({ sessionId: 's', relativePath: 'src/app.ts' })).toEqual({
    ok: true,
  });
  expect(file.calls).toEqual(['locate s src/app.ts', 'reveal /work/src/app.ts']);
  const folder = harness({ path: '/work/src', kind: 'directory' });
  expect(await folder.handler.handle({ sessionId: 's', relativePath: 'src' })).toEqual({
    ok: true,
  });
  expect(folder.calls).toEqual(['locate s src', 'open /work/src']);
});

it('reveals app bundles and other package-like folders instead of opening (launching) them', async () => {
  for (const name of ['Foo.app', 'Tool.bundle', 'Kit.framework', 'App.xcodeproj', 'v1.2']) {
    const bundle = harness({ path: `/work/${name}`, kind: 'directory' });
    expect(await bundle.handler.handle({ sessionId: 's', relativePath: name })).toEqual({
      ok: true,
    });
    expect(bundle.calls).toEqual([`locate s ${name}`, `reveal /work/${name}`]);
  }
  const plain = harness({ path: '/work/src', kind: 'directory' });
  await plain.handler.handle({ sessionId: 's', relativePath: 'src' });
  expect(plain.calls).toEqual(['locate s src', 'open /work/src']);
  const dotFolder = harness({ path: '/work/.github', kind: 'directory' });
  await dotFolder.handler.handle({ sessionId: 's', relativePath: '.github' });
  expect(dotFolder.calls).toEqual(['locate s .github', 'open /work/.github']);
});

it('refuses paths the server rejects, relative answers and junk payloads', async () => {
  const outside = harness(new Error('File is outside the selected worktree'));
  expect(await outside.handler.handle({ sessionId: 's', relativePath: '../etc' })).toEqual({
    error: 'File is outside the selected worktree',
  });
  const relative = harness({ path: 'src/app.ts', kind: 'file' });
  expect(await relative.handler.handle({ sessionId: 's', relativePath: 'src/app.ts' })).toEqual({
    error: 'File unavailable',
  });
  expect(relative.calls).toEqual(['locate s src/app.ts']);
  const junk = harness({ path: '/work', kind: 'directory' });
  for (const payload of [null, 'src', { sessionId: 's' }, { sessionId: '', relativePath: '' }])
    expect(await junk.handler.handle(payload)).toEqual({ error: 'Invalid file' });
  expect(junk.calls).toEqual([]);
});

it('never opens a folder that became a file, or an unknown kind', async () => {
  const swapped = harness({ path: '/work/src', kind: 'directory' }, false);
  expect(await swapped.handler.handle({ sessionId: 's', relativePath: 'src' })).toEqual({
    error: 'Folder unavailable',
  });
  const odd = harness({ path: '/work/run.sh', kind: 'executable' });
  expect(await odd.handler.handle({ sessionId: 's', relativePath: 'run.sh' })).toEqual({
    error: 'Folder unavailable',
  });
  expect([...swapped.calls, ...odd.calls].some((call) => call.startsWith('open'))).toBe(false);
});
