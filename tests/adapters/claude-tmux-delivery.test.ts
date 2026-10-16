import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIALOG_OPEN_REASON, type AgentMessage } from '../../src/core/contracts.js';
import { recordOf } from '../../src/core/json-record.js';
import { parseClaudeRecord } from '../../src/agents/claude/index.js';
import { createTmux } from '../../src/runtime/tmux.js';
import {
  COMMAND_PREFIX_REASON,
  PASTE_PREPARE_REASON,
  SCROLLED_REASON,
  TERMINAL_READ_REASON,
  TYPING_UNCERTAIN_REASON,
  UNKNOWN_VERSION_REASON,
  UNSAFE_TEXT_REASON,
  UNSENT_TEXT_REASON,
  assignTypedMessages,
  checkTerminal,
  createTypingQueue,
  pasteBufferName,
  sameTypedText,
  typeIntoTerminal,
  typedMessagesAfter,
  type GlossTerminal,
} from '../../src/agents/claude/tmux-delivery.js';
import {
  CAPTURED,
  FIXTURE_DIR,
  FIXTURE_VERSIONS,
  fixtureTerminal,
  readRecord,
} from './tmux-fixtures.js';

const idle = (version: string) => ({ status: 'idle', version });

describe.each(FIXTURE_VERSIONS)('terminal checks on captured Claude %s screens', (version) => {
  it('is ready on an empty input', async () => {
    expect(await checkTerminal(fixtureTerminal(version, 'empty').terminal, idle(version))).toEqual({
      ready: true,
    });
  });
  it('is ready on the empty input below a message queued while Claude works', async () => {
    expect(
      await checkTerminal(fixtureTerminal(version, 'working-queued').terminal, {
        status: 'busy',
        version,
      }),
    ).toEqual({ ready: true });
  });
  it('holds typed text as unsent text', async () => {
    expect(await checkTerminal(fixtureTerminal(version, 'typed').terminal, idle(version))).toEqual({
      ready: false,
      reason: UNSENT_TEXT_REASON,
    });
  });
  it.each(['multiline', 'pasted-chip', 'bash', 'working-typed'])('holds %s', async (state) => {
    expect(
      (await checkTerminal(fixtureTerminal(version, state).terminal, idle(version))).ready,
    ).toBe(false);
  });
  it('holds the dialog and the permission prompt that Claude itself reported', async () => {
    for (const state of ['dialog', 'permission'] as const)
      expect(
        await checkTerminal(fixtureTerminal(version, state).terminal, readRecord(version, state)),
      ).toEqual({ ready: false, reason: DIALOG_OPEN_REASON });
  });
  it('holds the dialog and the permission prompt from the screen alone', async () => {
    for (const state of ['dialog', 'permission'])
      expect(
        (await checkTerminal(fixtureTerminal(version, state).terminal, idle(version))).ready,
      ).toBe(false);
  });
});

describe('terminal checks', () => {
  it('holds for a dialog named only in the record, a scrolled pane, and an unknown version', async () => {
    const { terminal } = fixtureTerminal('2.1.301', 'empty');
    expect(
      await checkTerminal(terminal, {
        status: 'busy',
        waitingFor: 'dialog open',
        version: '2.1.301',
      }),
    ).toEqual({ ready: false, reason: DIALOG_OPEN_REASON });
    expect(
      await checkTerminal(
        fixtureTerminal('2.1.301', 'empty', { inMode: true }).terminal,
        idle('2.1.301'),
      ),
    ).toEqual({ ready: false, reason: SCROLLED_REASON });
    expect(await checkTerminal(terminal, idle('2.1.200'))).toEqual({
      ready: false,
      reason: UNKNOWN_VERSION_REASON,
    });
  });
  it('holds when the box reads empty but the cursor is anywhere but right after the prompt', async () => {
    for (const cursorShift of [1, -1]) {
      const moved = fixtureTerminal('2.1.301', 'empty', { cursorShift });
      expect(await checkTerminal(moved.terminal, idle('2.1.301'))).toEqual({
        ready: false,
        reason: UNSENT_TEXT_REASON,
      });
    }
  });
});

describe('typing into the terminal', () => {
  const send = (
    terminal: GlossTerminal,
    body: string,
    onTyping: (evidence: { nativeAfterRevision: number }) => undefined = () => undefined,
    requestId = 'delivery-1',
  ) =>
    typeIntoTerminal({
      terminal,
      requestId,
      body,
      session: idle('2.1.301'),
      transcriptSize: async () => 1234,
      onTyping,
    });
  it('checks, loads the buffer, records typing-started, pastes and presses Enter, in that order', async () => {
    const { terminal, log } = fixtureTerminal('2.1.301', 'empty');
    const typing: number[] = [];
    const result = await send(terminal, 'line one\nline two', (evidence) => {
      log.calls.push('typing');
      typing.push(evidence.nativeAfterRevision);
    });
    expect(result).toEqual({ state: 'typed', nativeAfterRevision: 1234 });
    expect(log.calls).toEqual([
      'capture',
      'cursor',
      'load:gloss-delivery-1',
      'typing',
      'paste:gloss-delivery-1',
      'enter',
    ]);
    expect(log.loaded).toEqual(['line one\nline two']);
    expect(typing).toEqual([1234]);
  });
  it('types nothing when the terminal is not clear', async () => {
    const { terminal, log } = fixtureTerminal('2.1.301', 'typed');
    expect(await send(terminal, 'hello')).toEqual({ state: 'held', reason: UNSENT_TEXT_REASON });
    expect(log.calls).toEqual(['capture', 'cursor']);
  });
  it.each([
    ['\u001b[201~rm -rf ~\r', UNSAFE_TEXT_REASON],
    ['a\u0007b', UNSAFE_TEXT_REASON],
    ['\u009b31m red', UNSAFE_TEXT_REASON],
    ['carriage\rreturn', UNSAFE_TEXT_REASON],
    ['line\n\rreturn', UNSAFE_TEXT_REASON],
    ['/clear the cache', COMMAND_PREFIX_REASON],
    ['  !rm -rf build', COMMAND_PREFIX_REASON],
    ['# heading', COMMAND_PREFIX_REASON],
  ])('refuses %j without touching the terminal', async (body, reason) => {
    const { terminal, log } = fixtureTerminal('2.1.301', 'empty');
    expect(await send(terminal, body)).toEqual({ state: 'failed', reason });
    expect(log.calls).toEqual([]);
  });
  it('keeps tabs, newlines and Hebrew', async () => {
    const { terminal, log } = fixtureTerminal('2.1.301', 'empty');
    expect((await send(terminal, 'שלום\n\tindented')).state).toBe('typed');
    expect(log.loaded).toEqual(['שלום\n\tindented']);
  });
  it('types Windows line endings as line feeds', async () => {
    const { terminal, log } = fixtureTerminal('2.1.301', 'empty');
    expect(await send(terminal, 'line one\r\nline two\r\n')).toEqual({
      state: 'typed',
      nativeAfterRevision: 1234,
    });
    expect(log.loaded).toEqual(['line one\nline two\n']);
  });
  it('types nothing when typing-started cannot be recorded', async () => {
    const { terminal, log } = fixtureTerminal('2.1.301', 'empty');
    const result = await send(terminal, 'hello', () => {
      throw new Error('disk full');
    });
    expect(result).toEqual({ state: 'failed', reason: PASTE_PREPARE_REASON });
    expect(log.calls).toEqual([
      'capture',
      'cursor',
      'load:gloss-delivery-1',
      'delete:gloss-delivery-1',
    ]);
  });
  it('fails cleanly when the buffer cannot be loaded, and is uncertain when the paste breaks', async () => {
    let typed = false;
    const load = fixtureTerminal('2.1.301', 'empty', { fail: 'load' });
    expect(
      await send(load.terminal, 'hello', () => {
        typed = true;
      }),
    ).toEqual({ state: 'failed', reason: PASTE_PREPARE_REASON });
    expect(typed).toBe(false);
    const paste = fixtureTerminal('2.1.301', 'empty', { fail: 'paste' });
    expect(await send(paste.terminal, 'hello')).toEqual({
      state: 'unconfirmed',
      reason: TYPING_UNCERTAIN_REASON,
      nativeAfterRevision: 1234,
    });
    expect(paste.log.calls).not.toContain('enter');
  });
  it('fails before typing when the transcript size cannot be read', async () => {
    const { terminal, log } = fixtureTerminal('2.1.301', 'empty');
    let typed = false;
    const result = await typeIntoTerminal({
      terminal,
      requestId: 'delivery-1',
      body: 'hello',
      session: idle('2.1.301'),
      transcriptSize: async () => {
        throw new Error('transcript gone');
      },
      onTyping: () => {
        typed = true;
      },
    });
    expect(result).toEqual({ state: 'failed', reason: PASTE_PREPARE_REASON });
    expect(typed).toBe(false);
    expect(log.calls.some((call) => call.startsWith('paste:') || call === 'enter')).toBe(false);
  });
  it('holds when the terminal cannot be read', async () => {
    const { terminal } = fixtureTerminal('2.1.301', 'empty', { fail: 'capture' });
    expect(await send(terminal, 'hello')).toEqual({ state: 'held', reason: TERMINAL_READ_REASON });
  });
  it('names the paste buffer after the request', () => {
    expect(pasteBufferName('delivery-1')).toBe('gloss-delivery-1');
  });

  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  it('sends nothing when tmux rejects the buffer name for the request', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'la-delivery-'));
    dirs.push(stateDir);
    const tmuxCalls: string[][] = [];
    const tmux = await createTmux({
      stateDir,
      executable: '/stub/tmux',
      runner: async function* (_exe, args) {
        tmuxCalls.push(args);
        yield {
          type: 'exit',
          outcome: { code: 0, signal: null, reason: 'exited', diagnostics: '' },
        };
      },
    });
    const { terminal: screen, log } = fixtureTerminal('2.1.301', 'empty');
    const terminal: GlossTerminal = {
      ...screen,
      capture: () => screen.capture(),
      cursor: () => screen.cursor(),
      loadBuffer: (buffer, text) => tmux.loadBuffer(buffer, text),
      pasteBuffer: (buffer) => tmux.pasteBuffer('la-one', buffer),
      deleteBuffer: (buffer) => tmux.deleteBuffer(buffer),
      pressEnter: () => screen.pressEnter(),
    };
    let typed = false;
    const result = await send(
      terminal,
      'hello',
      () => {
        typed = true;
      },
      'delivery 1; rm -rf ~',
    );
    expect(result).toEqual({ state: 'failed', reason: PASTE_PREPARE_REASON });
    expect(typed).toBe(false);
    expect(tmuxCalls).toEqual([]);
    expect(log.calls).toEqual(['capture', 'cursor']);
  });
});

const user = (
  sourceId: string,
  revision: number,
  text: string,
  clientId?: string,
): AgentMessage => ({
  sourceId,
  revision,
  role: 'user',
  text,
  complete: true,
  ...(clientId ? { clientId } : {}),
});
describe('typing queue', () => {
  it('types for one session at a time, other sessions in parallel, and keeps going after a failure', async () => {
    const typeInTurn = createTypingQueue();
    const order: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = typeInTurn('session-a', async () => {
      order.push('a1 start');
      await gate;
      order.push('a1 end');
      throw new Error('pane closed');
    });
    const second = typeInTurn('session-a', async () => {
      order.push('a2');
      return 'a2';
    });
    expect(
      await typeInTurn('session-b', async () => {
        order.push('b1');
        return 'b1';
      }),
    ).toBe('b1');
    expect(order).toEqual(['a1 start', 'b1']);
    release();
    await expect(first).rejects.toThrow('pane closed');
    expect(await second).toBe('a2');
    expect(order).toEqual(['a1 start', 'b1', 'a1 end', 'a2']);
  });
});

describe('typed message matching', () => {
  it('confirms identical pending texts in send order and skips records already taken', () => {
    const messages = [user('m1', 50, 'yes'), user('m2', 60, 'yes')];
    const first = { id: 'a', body: 'yes', after: 10 };
    const second = { id: 'b', body: 'yes', after: 10 };
    expect([...assignTypedMessages([first, second], messages)]).toEqual([
      ['a', 'm1'],
      ['b', 'm2'],
    ]);
    expect([...assignTypedMessages([second], messages, new Set(['m1']))]).toEqual([['b', 'm2']]);
  });
  it('ignores records before the paste, other texts, and peer messages', () => {
    const send = { id: 'a', body: 'Fix it', after: 100 };
    const messages = [
      user('old', 90, 'Fix it'),
      user('other', 110, 'Fix it later'),
      user('peer', 120, 'Fix it', 'abcdef12'),
    ];
    expect(assignTypedMessages([send], messages).size).toBe(0);
  });
  it('compares texts without surrounding whitespace or carriage returns', () => {
    expect(sameTypedText('a\r\nb\n', 'a\nb')).toBe(true);
    expect(sameTypedText('a b', 'a  b')).toBe(false);
  });
  it('reads history pages only back to the paste', async () => {
    const pages = [
      { messages: [user('m3', 300, 'x'), user('m4', 400, 'y')], next: 'p2' },
      { messages: [user('m1', 100, 'x'), user('m2', 200, 'x')], next: 'p3' },
      { messages: [user('m0', 50, 'x')] },
    ];
    const requested: (string | undefined)[] = [];
    const history = async (cursor?: string) => {
      requested.push(cursor);
      return pages[requested.length - 1] ?? { messages: [] };
    };
    expect((await typedMessagesAfter(history, 150)).map((m) => m.sourceId)).toEqual([
      'm2',
      'm3',
      'm4',
    ]);
    expect(requested).toEqual([undefined, 'p2']);
  });
});

describe.each(FIXTURE_VERSIONS)('transcript of the captured Claude %s session', (version) => {
  const messages = readFileSync(join(FIXTURE_DIR, `claude-typed-${version}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line, offset) => {
      const value: unknown = JSON.parse(line);
      const record = recordOf(value);
      if (!record || typeof record.sessionId !== 'string') return [];
      const parsed = parseClaudeRecord(record, offset, record.sessionId);
      return parsed.message ? [parsed.message] : [];
    });
  const typed = messages.filter((m) => m.role === 'user' && m.clientId === undefined);
  it('records a pasted multi-line message as one plain user message with the same text', () => {
    expect(typed.filter((m) => sameTypedText(m.text, CAPTURED.typed))).toHaveLength(1);
  });
  it('records a message typed while Claude worked as a plain user message too', () => {
    expect(typed.filter((m) => sameTypedText(m.text, CAPTURED.busy))).toHaveLength(1);
  });
  it('records nothing for text cleared before sending', () => {
    expect(typed.some((m) => /hello there|pasted line 1|line two/.test(m.text))).toBe(false);
  });
});
