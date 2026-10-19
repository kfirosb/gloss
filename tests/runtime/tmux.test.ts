// tests/runtime/tmux.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  chmod,
  realpath,
  writeFile,
  readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createTmux,
  ensureSocketDirectory,
  locateTmux,
  MAX_PANE_ROW,
  sessionNameFor,
  tmuxCandidates,
  TmuxUnavailable,
} from '../../src/runtime/tmux.js';
import type { ProcessOptions } from '../../src/runtime/process-runner.js';

const dirs: string[] = [];
const stateDirs: string[] = [];
afterEach(async () => {
  for (const state of stateDirs.splice(0)) {
    // Kill the private server this test may have started; ignore failures when none is running.
    await new Promise<void>((resolve) =>
      execFile('/opt/homebrew/bin/tmux', ['-S', join(state, 'tmux', 'socket'), 'kill-server'], () =>
        resolve(),
      ),
    );
  }
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const temp = async () => {
  const d = await realpath(await mkdtemp(join(tmpdir(), 'la-tmux-')));
  dirs.push(d);
  return d;
};
const stateTemp = async () => {
  const d = await temp();
  stateDirs.push(d);
  return d;
};
const available = await locateTmux().then(
  () => true,
  () => false,
);

it('reports tmux unavailable', async () => {
  await expect(locateTmux(['/nonexistent/tmux'])).rejects.toBeInstanceOf(TmuxUnavailable);
});
it('falls back to the bundled tmux in resourcesPath when the Homebrew paths are absent', async () => {
  const proc = process as { resourcesPath?: string };
  const original = proc.resourcesPath;
  proc.resourcesPath = '/fake/Resources';
  const tried: string[] = [];
  const runner = (executable: string) =>
    (async function* () {
      tried.push(executable);
      if (executable === '/fake/Resources/bin/tmux') {
        yield { type: 'line' as const, line: 'tmux 3.5a' };
        yield {
          type: 'exit' as const,
          outcome: { code: 0, signal: null, reason: 'exited' as const, diagnostics: '' },
        };
      } else
        yield {
          type: 'exit' as const,
          outcome: { code: null, signal: null, reason: 'spawn-error' as const, diagnostics: '' },
        };
    })();
  try {
    await expect(locateTmux(undefined, runner)).resolves.toBe('/fake/Resources/bin/tmux');
  } finally {
    if (original === undefined) delete proc.resourcesPath;
    else proc.resourcesPath = original;
  }
  expect(tried).toEqual([
    '/opt/homebrew/bin/tmux',
    '/usr/local/bin/tmux',
    '/fake/Resources/bin/tmux',
  ]);
});
it('checks the desktop-provided bundled tmux after Homebrew and before resourcesPath', () => {
  expect(
    tmuxCandidates(
      { LANGUAGE_ASSISTANT_TMUX: '/App/Contents/Resources/bin/tmux' },
      '/Other/Resources',
    ),
  ).toEqual([
    '/opt/homebrew/bin/tmux',
    '/usr/local/bin/tmux',
    '/App/Contents/Resources/bin/tmux',
    '/Other/Resources/bin/tmux',
  ]);
  expect(tmuxCandidates({ LANGUAGE_ASSISTANT_TMUX: 'relative/tmux' }, undefined)).toEqual([
    '/opt/homebrew/bin/tmux',
    '/usr/local/bin/tmux',
  ]);
  expect(tmuxCandidates({}, undefined)).toEqual(['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux']);
});
it('runs tmux without the panel capability and never lets tmux shell-parse a one-item command', async () => {
  const calls: { args: string[]; options?: ProcessOptions }[] = [];
  const saved = {
    cap: process.env.LANGUAGE_PANEL_CAPABILITY,
    node: process.env.ELECTRON_RUN_AS_NODE,
    tmux: process.env.TMUX,
  };
  Object.assign(process.env, {
    LANGUAGE_PANEL_CAPABILITY: 'secret-cap',
    ELECTRON_RUN_AS_NODE: '1',
    TMUX: '/x,1,0',
  });
  try {
    const tmux = await createTmux({
      stateDir: await temp(),
      executable: '/stub/tmux',
      runner: async function* (_exe, args, _in, _signal, options) {
        calls.push({ args, ...(options ? { options } : {}) });
        if (args.includes('new-session')) yield { type: 'line', line: '4242' };
        yield {
          type: 'exit',
          outcome: { code: 0, signal: null, reason: 'exited', diagnostics: '' },
        };
      },
    });
    await tmux.newSession('la-one', '/tmp', ['/Applications/My Tools/codex']);
  } finally {
    for (const [k, v] of [
      ['LANGUAGE_PANEL_CAPABILITY', saved.cap],
      ['ELECTRON_RUN_AS_NODE', saved.node],
      ['TMUX', saved.tmux],
    ] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
  const create = calls.find((c) => c.args.includes('new-session'))!;
  expect(create.args.slice(create.args.indexOf('--'))).toEqual([
    '--',
    '/usr/bin/env',
    '-u',
    'LANGUAGE_PANEL_CAPABILITY',
    '-u',
    'ELECTRON_RUN_AS_NODE',
    '/Applications/My Tools/codex',
  ]);
  for (const call of calls) {
    expect(call.options?.env).toBeDefined();
    expect(call.options!.env).not.toHaveProperty('LANGUAGE_PANEL_CAPABILITY');
    expect(call.options!.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(call.options!.env).not.toHaveProperty('TMUX');
  }
  expect(calls.map((c) => c.args.slice(5, 9).join(' '))).toEqual(
    expect.arrayContaining([
      'set-environment -g -u LANGUAGE_PANEL_CAPABILITY',
      'set-environment -g -u ELECTRON_RUN_AS_NODE',
    ]),
  );
});
it('rejects unsafe socket directories', async () => {
  const d = await temp();
  const loose = join(d, 'loose');
  await mkdir(loose);
  await chmod(loose, 0o755);
  await expect(ensureSocketDirectory(loose)).rejects.toThrow('Unsafe tmux directory');
  const link = join(d, 'link');
  await symlink(d, link);
  await expect(ensureSocketDirectory(link)).rejects.toThrow('Unsafe tmux directory');
  await ensureSocketDirectory(join(d, 'fresh'));
});
it('names sessions', () => {
  expect(sessionNameFor('abc')).toBe('la-abc');
});
describe.skipIf(!available)('with real tmux on a private socket', () => {
  it('creates, captures, resizes and kills a session in a path with spaces and Hebrew', async () => {
    const state = await stateTemp();
    const folder = join(state, 'פרויקט with "quotes"');
    await mkdir(folder);
    const tmux = await createTmux({ stateDir: state });
    const { panePid } = await tmux.newSession('la-t1', folder, ['sh', '-c', 'pwd; sleep 30']);
    expect(panePid).toBeGreaterThan(1);
    await expect
      .poll(() => tmux.capturePane('la-t1'), { timeout: 5000 })
      .toContain('פרויקט with "quotes"');
    expect((await tmux.listSessions()).map((s) => s.name)).toEqual(['la-t1']);
    await tmux.resizeWindow('la-t1', 90, 30);
    await tmux.killSession('la-t1');
    expect(await tmux.hasSession('la-t1')).toBe(false);
  });
  it('runs a one-item command whose path has a space, scrubs the capability and configures the popup terminal', async () => {
    const state = await stateTemp();
    const bin = join(state, 'my tools');
    await mkdir(bin);
    const script = join(bin, 'agent');
    await writeFile(
      script,
      '#!/bin/sh\necho "agent-ran cap=[$LANGUAGE_PANEL_CAPABILITY] node=[$ELECTRON_RUN_AS_NODE]"\nsleep 30\n',
    );
    await chmod(script, 0o755);
    const socket = join(state, 'tmux', 'socket');
    const tmuxBin = '/opt/homebrew/bin/tmux';
    const tmuxCmd = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
      new Promise<string>((resolve, reject) =>
        execFile(tmuxBin, ['-S', socket, ...args], { env }, (e, out) =>
          e ? reject(e) : resolve(out),
        ),
      );
    const tmux = await createTmux({ stateDir: state });
    // A server started earlier by a process that still carried the capability.
    await tmuxCmd(['-f', '/dev/null', 'new-session', '-d', '-s', 'la-old', 'sleep 30'], {
      ...process.env,
      LANGUAGE_PANEL_CAPABILITY: 'leaked',
      ELECTRON_RUN_AS_NODE: '1',
    });
    expect(await tmuxCmd(['show-environment', '-g'])).toContain('LANGUAGE_PANEL_CAPABILITY=leaked');
    await tmux.newSession('la-t2', state, [script]);
    await expect
      .poll(() => tmux.capturePane('la-t2'), { timeout: 5000 })
      .toContain('agent-ran cap=[] node=[]');
    const globalEnv = await tmuxCmd(['show-environment', '-g']);
    expect(globalEnv).not.toContain('LANGUAGE_PANEL_CAPABILITY');
    expect(globalEnv).not.toMatch(/^ELECTRON_RUN_AS_NODE=/m);
    expect(await tmuxCmd(['show-options', '-gv', 'prefix'])).toBe('None\n');
    expect(await tmuxCmd(['show-options', '-gv', 'status'])).toBe('off\n');
    expect(await tmuxCmd(['show-options', '-sv', 'escape-time'])).toBe('0\n');
  });
  it('lists sessions when the app was opened without a locale (a Dock or Finder launch)', async () => {
    // Without a UTF-8 locale tmux prints control characters such as the listing's tabs as "_".
    const keys = ['LANG', 'LC_ALL', 'LC_CTYPE'];
    const saved = keys.map((k) => process.env[k]);
    for (const k of keys) delete process.env[k];
    try {
      const tmux = await createTmux({ stateDir: await stateTemp() });
      const { panePid } = await tmux.newSession('la-t3', tmpdir(), ['sh', '-c', 'sleep 30']);
      expect(await tmux.listSessions()).toEqual([
        expect.objectContaining({ name: 'la-t3', panePid }),
      ]);
    } finally {
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      });
    }
  });
  it('lists nothing when the private server is not running', async () => {
    const tmux = await createTmux({ stateDir: await stateTemp() });
    expect(await tmux.listSessions()).toEqual([]);
  });
  it('scrolls a shell into its history and returns to the live screen', async () => {
    const tmux = await createTmux({ stateDir: await stateTemp() });
    await tmux.newSession('la-t3', '/', ['sh', '-c', 'seq 1 200; sleep 30']);
    await expect.poll(() => tmux.capturePane('la-t3'), { timeout: 5000 }).toContain('200');
    const paneState = async () =>
      (
        await new Promise<string>((resolve, reject) =>
          execFile(
            tmux.executable,
            [
              '-S',
              tmux.socket,
              'display-message',
              '-p',
              '-t',
              '=la-t3:',
              '#{pane_in_mode} #{scroll_position}',
            ],
            (e, out) => (e ? reject(e) : resolve(out)),
          ),
        )
      ).trim();
    await tmux.scroll('la-t3', { lines: -5, col: 1, row: 1 });
    expect(await paneState()).toBe('1 5');
    await tmux.scroll('la-t3', { lines: 2, col: 1, row: 1 });
    expect(await paneState()).toBe('1 3');
    await tmux.exitCopyMode('la-t3');
    expect(await paneState()).toBe('0');
    await tmux.exitCopyMode('la-t3');
  });
});

it('distinguishes an absent server from tmux timeouts and other listing failures', async () => {
  const outcomes = [
    {
      code: 1,
      signal: null,
      reason: 'exited' as const,
      diagnostics: 'no server running on /private/socket',
    },
    {
      code: 1,
      signal: null,
      reason: 'exited' as const,
      diagnostics: 'error connecting to /private/socket (No such file or directory)',
    },
    { code: 1, signal: null, reason: 'exited' as const, diagnostics: 'permission denied' },
    { code: null, signal: null, reason: 'timeout' as const, diagnostics: '' },
  ];
  const tmux = await createTmux({
    stateDir: await temp(),
    executable: '/stub/tmux',
    runner: async function* () {
      yield { type: 'exit', outcome: outcomes.shift()! };
    },
  });
  expect(await tmux.listSessions()).toEqual([]);
  expect(await tmux.listSessions()).toEqual([]);
  await expect(tmux.listSessions()).rejects.toThrow('tmux command failed');
  await expect(tmux.listSessions()).rejects.toThrow('tmux command failed');
});
it('passes leading-dash input as keys rather than tmux options', async () => {
  let received: string[] = [];
  const tmux = await createTmux({
    stateDir: await temp(),
    executable: '/stub/tmux',
    runner: async function* (_exe, args) {
      received = args;
      yield { type: 'exit', outcome: { code: 0, signal: null, reason: 'exited', diagnostics: '' } };
    },
  });
  await tmux.sendKeys('la-test', ['-evil', 'Enter']);
  expect(received.slice(-6)).toEqual(['send-keys', '-t', '=la-test:', '--', '-evil', 'Enter']);
});
it('does not report a live session absent or ended on tmux command failures', async () => {
  const outcomes = [
    { code: null, signal: null, reason: 'timeout' as const, diagnostics: '' },
    { code: 1, signal: null, reason: 'exited' as const, diagnostics: 'permission denied' },
    {
      code: 1,
      signal: null,
      reason: 'exited' as const,
      diagnostics: "can't find session: la-test",
    },
    {
      code: 1,
      signal: null,
      reason: 'exited' as const,
      diagnostics: 'no server running on /private/socket',
    },
  ];
  const tmux = await createTmux({
    stateDir: await temp(),
    executable: '/stub/tmux',
    runner: async function* () {
      yield { type: 'exit', outcome: outcomes.shift()! };
    },
  });
  await expect(tmux.hasSession('la-test')).rejects.toThrow('tmux command failed');
  await expect(tmux.killSession('la-test')).rejects.toThrow('tmux command failed');
  expect(await tmux.hasSession('la-test')).toBe(false);
  await expect(tmux.killSession('la-test')).resolves.toBeUndefined();
});
it('treats a server that exits while answering (the last session was just killed) as absent', async () => {
  // Seen with tmux 3.5a: kill-session of the last session with a client attached, then has-session, prints this ~1 in 10 times.
  const exited = {
    code: 1,
    signal: null,
    reason: 'exited' as const,
    diagnostics: 'server exited unexpectedly',
  };
  const tmux = await createTmux({
    stateDir: await temp(),
    executable: '/stub/tmux',
    runner: async function* () {
      yield { type: 'exit', outcome: exited };
    },
  });
  expect(await tmux.hasSession('la-test')).toBe(false);
  await expect(tmux.killSession('la-test')).resolves.toBeUndefined();
  expect(await tmux.listSessions()).toEqual([]);
});
it('lists the current command of each pane', async () => {
  const tmux = await createTmux({
    stateDir: await temp(),
    executable: '/stub/tmux',
    runner: async function* (_exe, args) {
      if (args.includes('list-sessions')) {
        yield { type: 'line', line: 'la-one\t41\tzsh' };
        yield { type: 'line', line: 'la-two\t42\tnode' };
        yield { type: 'line', line: 'other\t43\tzsh' };
      }
      yield { type: 'exit', outcome: { code: 0, signal: null, reason: 'exited', diagnostics: '' } };
    },
  });
  expect(await tmux.listSessions()).toEqual([
    { name: 'la-one', panePid: 41, currentCommand: 'zsh' },
    { name: 'la-two', panePid: 42, currentCommand: 'node' },
  ]);
});
it('types text literally and then presses Enter as two commands', async () => {
  const calls: string[][] = [];
  const tmux = await createTmux({
    stateDir: await temp(),
    executable: '/stub/tmux',
    runner: async function* (_exe, args) {
      calls.push(args);
      yield { type: 'exit', outcome: { code: 0, signal: null, reason: 'exited', diagnostics: '' } };
    },
  });
  await tmux.typeText('la-one', '-n "C-c" && echo done');
  expect(calls.map((c) => c.slice(5))).toEqual([
    ['send-keys', '-t', '=la-one:', '-l', '--', '-n "C-c" && echo done'],
    ['send-keys', '-t', '=la-one:', '--', 'Enter'],
  ]);
});

const ok = { code: 0, signal: null, reason: 'exited' as const, diagnostics: '' };
it('captures with styles, reads the cursor, and passes paste text on stdin only', async () => {
  const calls: { args: string[]; input: string }[] = [];
  const tmux = await createTmux({
    stateDir: await temp(),
    executable: '/stub/tmux',
    runner: async function* (_exe, args, input) {
      calls.push({ args, input });
      if (args.includes('display-message')) yield { type: 'line', line: '2 7 0' };
      yield { type: 'exit', outcome: ok };
    },
  });
  await tmux.capturePaneStyled('la-one');
  expect(await tmux.paneCursor('la-one')).toEqual({ x: 2, y: 7, inMode: false });
  await tmux.loadBuffer('gloss-delivery-1', '-x "$(rm -rf /)"\nline');
  await tmux.pasteBuffer('la-one', 'gloss-delivery-1');
  await tmux.deleteBuffer('gloss-delivery-1');
  expect(calls.map((c) => c.args.slice(5))).toEqual([
    ['capture-pane', '-e', '-p', '-t', '=la-one:'],
    ['display-message', '-p', '-t', '=la-one:', '#{cursor_x} #{cursor_y} #{pane_in_mode}'],
    ['load-buffer', '-b', 'gloss-delivery-1', '-'],
    ['paste-buffer', '-p', '-r', '-d', '-b', 'gloss-delivery-1', '-t', '=la-one:'],
    ['delete-buffer', '-b', 'gloss-delivery-1'],
  ]);
  expect(calls.map((c) => c.input)).toEqual(['', '', '-x "$(rm -rf /)"\nline', '', '']);
  await expect(tmux.loadBuffer('other', 'x')).rejects.toThrow('Invalid tmux buffer name');
  await expect(tmux.pasteBuffer('la-one', 'gloss-a b')).rejects.toThrow('Invalid tmux buffer name');
  await expect(tmux.paneCursor('evil')).rejects.toThrow('Invalid tmux session name');
});
it('rejects an unreadable cursor report and treats an absent buffer as deleted', async () => {
  const replies = [
    { line: 'garbage', outcome: ok },
    {
      outcome: {
        code: 1,
        signal: null,
        reason: 'exited' as const,
        diagnostics: 'no buffer gloss-x\n',
      },
    },
  ];
  const tmux = await createTmux({
    stateDir: await temp(),
    executable: '/stub/tmux',
    runner: async function* () {
      const reply = replies.shift();
      if (reply && 'line' in reply) yield { type: 'line', line: reply.line };
      yield { type: 'exit', outcome: reply?.outcome ?? ok };
    },
  });
  await expect(tmux.paneCursor('la-one')).rejects.toThrow('tmux did not report the cursor');
  await expect(tmux.deleteBuffer('gloss-x')).resolves.toBeUndefined();
});
it('captures only the rows asked for and presses only Ctrl+S, once per call', async () => {
  const calls: string[][] = [];
  const tmux = await createTmux({
    stateDir: await temp(),
    executable: '/stub/tmux',
    runner: async function* (_exe, args) {
      calls.push(args);
      yield { type: 'exit', outcome: ok };
    },
  });
  await tmux.captureRows('la-one', 5, 17);
  await tmux.pressStash('la-one');
  expect(calls.map((c) => c.slice(5))).toEqual([
    ['capture-pane', '-e', '-p', '-S', '5', '-E', '17', '-t', '=la-one:'],
    ['send-keys', '-t', '=la-one:', '--', 'C-s'],
  ]);
  for (const [start, end] of [
    [-1, 3],
    [4, 3],
    [1.5, 3],
    [0, MAX_PANE_ROW + 1],
  ] as const)
    await expect(tmux.captureRows('la-one', start, end)).rejects.toThrow('Invalid rows');
  await expect(tmux.pressStash('evil')).rejects.toThrow('Invalid tmux session name');
  expect(calls).toHaveLength(2);
});
describe.skipIf(!available)('pasting into a real pane', () => {
  const tui = fileURLToPath(new URL('../fixtures/fake-claude-tui.mjs', import.meta.url));
  async function pane() {
    const state = await stateTemp();
    const log = join(state, 'input.log');
    const tmux = await createTmux({ stateDir: state });
    await tmux.newSession('la-paste', state, [process.execPath, tui, log]);
    await expect.poll(() => tmux.capturePane('la-paste'), { timeout: 5000 }).toContain('❯');
    return { tmux, read: () => readFile(log, 'utf8').catch(() => '') };
  }
  it('pastes a multi-line message as one bracketed block, then presses Enter', async () => {
    const { tmux, read } = await pane();
    await tmux.loadBuffer('gloss-multi', 'line one\nline two');
    await tmux.pasteBuffer('la-paste', 'gloss-multi');
    await tmux.sendKeys('la-paste', ['Enter']);
    await expect.poll(read, { timeout: 5000 }).toBe('\u001b[200~line one\nline two\u001b[201~\r');
    // -d removed the buffer already; deleting it again is not an error.
    await expect(tmux.deleteBuffer('gloss-multi')).resolves.toBeUndefined();
  });
  it('pastes a message far larger than one tmux command can carry', async () => {
    const { tmux, read } = await pane();
    const text = 'a'.repeat(50_000) + '\n' + 'b';
    await tmux.loadBuffer('gloss-large', text);
    await tmux.pasteBuffer('la-paste', 'gloss-large');
    await expect
      .poll(async () => (await read()).length, { timeout: 10_000 })
      .toBe(text.length + 12);
    expect(await read()).toBe('\u001b[200~' + text + '\u001b[201~');
  });
  it('reads the cursor and the styled screen of the pane', async () => {
    const { tmux } = await pane();
    expect(await tmux.paneCursor('la-paste')).toEqual({ x: 2, y: 2, inMode: false });
    expect(await tmux.capturePaneStyled('la-paste')).toContain('─'.repeat(60));
  });
  it('captures only the rows asked for, clamped to the pane, and delivers Ctrl+S as one byte', async () => {
    const { tmux, read } = await pane();
    const plain = (text: string) => text.replace(/\u001b\[[0-9;:]*m/g, '').trimEnd();
    const rows = (await tmux.captureRows('la-paste', 1, 3)).split('\n').map(plain);
    expect(rows).toEqual(['─'.repeat(60), '❯', '─'.repeat(60)]);
    expect(await tmux.captureRows('la-paste', 1, MAX_PANE_ROW)).toContain('❯');
    await tmux.pressStash('la-paste');
    await expect.poll(read, { timeout: 5000 }).toBe('\u0013');
  });
});

describe('scroll', () => {
  const scrollCalls = async (
    paneState: string,
    wheel: { lines: number; col: number; row: number },
  ) => {
    const calls: string[][] = [];
    const tmux = await createTmux({
      stateDir: await temp(),
      executable: '/stub/tmux',
      runner: async function* (_exe, args) {
        calls.push(args.slice(5));
        if (args.includes('display-message')) yield { type: 'line', line: paneState };
        yield {
          type: 'exit',
          outcome: { code: 0, signal: null, reason: 'exited', diagnostics: '' },
        };
      },
    });
    await tmux.scroll('la-one', wheel);
    return calls.slice(1);
  };
  // Pane state fields: in copy mode, app wants the mouse, app wants SGR reports, alternate screen, height.
  it('scrolls copy mode when the pane is already browsing history', async () => {
    expect(await scrollCalls('1 0 0 0', { lines: -3, col: 1, row: 1 })).toEqual([
      ['send-keys', '-X', '-N', '3', '-t', '=la-one:', 'scroll-up'],
    ]);
    expect(await scrollCalls('1 1 1 1', { lines: 2, col: 1, row: 1 })).toEqual([
      ['send-keys', '-X', '-N', '2', '-t', '=la-one:', 'scroll-down'],
    ]);
  });
  it('sends wheel reports at the pointer cell to an app that asked for the mouse', async () => {
    const sgr = (s: string) => [...Buffer.from(s)].map((b) => b.toString(16));
    expect(await scrollCalls('0 1 1 1', { lines: -2, col: 7, row: 3 })).toEqual([
      ['send-keys', '-H', '-t', '=la-one:', ...sgr('\x1b[<64;7;3M\x1b[<64;7;3M')],
    ]);
    expect(await scrollCalls('0 1 1 1', { lines: 1, col: 7, row: 3 })).toEqual([
      ['send-keys', '-H', '-t', '=la-one:', ...sgr('\x1b[<65;7;3M')],
    ]);
    expect(await scrollCalls('0 1 0 1', { lines: -1, col: 300, row: 3 })).toEqual([
      [
        'send-keys',
        '-H',
        '-t',
        '=la-one:',
        '1b',
        '5b',
        '4d',
        (96).toString(16),
        (255).toString(16),
        (35).toString(16),
      ],
    ]);
  });
  it('pages other full-screen apps once a third of a screen has been scrolled', async () => {
    const calls: string[][] = [];
    const tmux = await createTmux({
      stateDir: await temp(),
      executable: '/stub/tmux',
      runner: async function* (_exe, args) {
        if (args.includes('display-message')) yield { type: 'line', line: '0 0 0 1 30' };
        else calls.push(args.slice(5));
        yield {
          type: 'exit',
          outcome: { code: 0, signal: null, reason: 'exited', diagnostics: '' },
        };
      },
    });
    const at = { col: 1, row: 1 };
    await tmux.scroll('la-one', { lines: -6, ...at });
    expect(calls).toEqual([]);
    await tmux.scroll('la-one', { lines: -6, ...at });
    await tmux.scroll('la-one', { lines: -20, ...at });
    // Reversing direction drops the carry instead of cancelling it out.
    await tmux.scroll('la-one', { lines: 9, ...at });
    await tmux.scroll('la-one', { lines: 1, ...at });
    expect(calls).toEqual([
      ['send-keys', '-N', '1', '-t', '=la-one:', 'PPage'],
      ['send-keys', '-N', '2', '-t', '=la-one:', 'PPage'],
      ['send-keys', '-N', '1', '-t', '=la-one:', 'NPage'],
    ]);
  });
  it('enters copy mode to scroll a plain shell up and ignores scrolling down past the live screen', async () => {
    expect(await scrollCalls('0 0 0 0', { lines: -3, col: 1, row: 1 })).toEqual([
      [
        'copy-mode',
        '-e',
        '-t',
        '=la-one:',
        ';',
        'send-keys',
        '-X',
        '-N',
        '3',
        '-t',
        '=la-one:',
        'scroll-up',
      ],
    ]);
    expect(await scrollCalls('0 0 0 0', { lines: 3, col: 1, row: 1 })).toEqual([]);
  });
  it('rejects malformed wheel movements without running tmux', async () => {
    for (const wheel of [
      { lines: 0, col: 1, row: 1 },
      { lines: 51, col: 1, row: 1 },
      { lines: 1.5, col: 1, row: 1 },
      { lines: 1, col: 0, row: 1 },
      { lines: 1, col: 1, row: 1001 },
    ])
      await expect(scrollCalls('0 0 0 0', wheel)).rejects.toThrow('Invalid scroll');
  });
});

it('prefers the bundled tmux on Linux and falls back to the distribution one', () => {
  expect(tmuxCandidates({ LANGUAGE_ASSISTANT_TMUX: '/r/bin/tmux' }, '/res', 'linux')).toEqual([
    '/r/bin/tmux',
    '/res/bin/tmux',
    '/usr/bin/tmux',
    '/usr/local/bin/tmux',
  ]);
  expect(tmuxCandidates({}, undefined, 'linux')).toEqual(['/usr/bin/tmux', '/usr/local/bin/tmux']);
});
