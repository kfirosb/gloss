import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmux, locateTmux, type Tmux } from '../../src/runtime/tmux.js';
import { glossTerminalFor } from '../../src/runtime/launch-services.js';
import { UNSENT_TEXT_REASON, typeIntoTerminal } from '../../src/agents/claude/tmux-delivery.js';

const available = await locateTmux().then(
  () => true,
  () => false,
);
const started: { tmux: Tmux; home: string }[] = [];
afterEach(async () => {
  for (const { tmux, home } of started.splice(0)) {
    await new Promise<void>((resolve) =>
      execFile(tmux.executable, ['-S', tmux.socket, 'kill-server'], () => resolve()),
    );
    await rm(home, { recursive: true, force: true });
  }
});

describe.skipIf(!available)('typing into a real tmux pane', () => {
  it('holds while the input has a draft, then types the message exactly once after it is cleared', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'la-type-')));
    const tmux = await createTmux({ stateDir: home });
    started.push({ tmux, home });
    const log = join(home, 'input.log');
    const tui = fileURLToPath(new URL('../fixtures/fake-claude-tui.mjs', import.meta.url));
    const { panePid } = await tmux.newSession('la-type', home, [
      process.execPath,
      tui,
      log,
      'draft',
    ]);
    await expect.poll(() => tmux.capturePane('la-type'), { timeout: 5000 }).toContain('❯ draft');
    const terminal = glossTerminalFor(tmux, { id: 'type', panePid });
    const typingStarted: number[] = [];
    const send = () =>
      typeIntoTerminal({
        terminal,
        requestId: 'delivery-1',
        body: 'line one\nline two',
        session: { status: 'idle', version: '2.1.301' },
        transcriptSize: async () => 0,
        onTyping: ({ nativeAfterRevision }) => {
          typingStarted.push(nativeAfterRevision);
          return undefined;
        },
      });
    expect(await send()).toEqual({ state: 'held', reason: UNSENT_TEXT_REASON });
    expect(typingStarted).toEqual([]);
    await tmux.sendKeys('la-type', ['C-u']);
    await expect.poll(() => tmux.capturePane('la-type'), { timeout: 5000 }).not.toContain('draft');
    expect(await send()).toEqual({ state: 'typed', nativeAfterRevision: 0 });
    expect(typingStarted).toEqual([0]);
    const read = () => readFile(log, 'utf8').catch(() => '');
    await expect
      .poll(read, { timeout: 5000 })
      .toBe('\u0015\u001b[200~line one\nline two\u001b[201~\r');
  });
});
