import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIALOG_OPEN_REASON, type AgentMessage } from '../../src/core/contracts.js';
import { recordOf } from '../../src/core/json-record.js';
import { claudeMessage, parseClaudeRecord } from '../../src/agents/claude/index.js';
import type { FileReference } from '../../src/core/file-references.js';
import { createTmux } from '../../src/runtime/tmux.js';
import {
  COMMAND_PREFIX_REASON,
  NO_INPUT_BOX_REASON,
  OTHER_MODE_REASON,
  PASTE_PREPARE_REASON,
  PASTE_SETTLE_MS,
  PASTE_SETTLE_POLL_MS,
  SCROLLED_REASON,
  SESSION_SWITCHED_REASON,
  TERMINAL_READ_REASON,
  TYPING_UNCERTAIN_REASON,
  UNKNOWN_VERSION_REASON,
  UNSAFE_TEXT_REASON,
  UNSENT_TEXT_REASON,
  assignTypedMessages,
  checkAtSend,
  checkTerminal,
  createTypingQueue,
  pasteBufferName,
  sameTypedText,
  typeIntoTerminal,
  typedMessagesAfter,
  type GlossTerminal,
  type TerminalFacts,
  type TypingClock,
} from '../../src/agents/claude/tmux-delivery.js';
import {
  CAPTURED,
  CAPTURED_LONG,
  CAPTURED_STASH,
  FIXTURE_DIR,
  FIXTURE_VERSIONS,
  LONG_FIXTURE_VERSIONS,
  NARROW_READINGS,
  STASH_FIXTURE_VERSIONS,
  STASH_READINGS,
  fixtureTerminal,
  readCursor,
  readRecord,
  readScreen,
} from './tmux-fixtures.js';

const idle = (version: string) => ({ status: 'idle', version });
/** Test time: each sleep moves the clock forward by its length. */
function stepClock() {
  let time = 0;
  const sleeps: number[] = [];
  const clock: TypingClock = {
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
  };
  return { clock, sleeps };
}

const facts = (
  version: string,
  state: string,
  over: Partial<TerminalFacts> = {},
): TerminalFacts => ({
  session: idle(version),
  screen: readScreen(version, state),
  cursor: readCursor(version, state),
  ...over,
});
describe.each(FIXTURE_VERSIONS)('check at Send on captured Claude %s screens', (version) => {
  it.each(['empty', 'typed', 'multiline', 'pasted-chip', 'working-typed', 'working-queued'])(
    'lets %s through: what is in the box is the stash step’s business',
    (state) => {
      expect(checkAtSend(facts(version, state, { session: { status: 'busy', version } }))).toEqual({
        ready: true,
      });
    },
  );
  it('opens the terminal for shell mode', () => {
    expect(checkAtSend(facts(version, 'bash'))).toEqual({
      ready: false,
      reason: OTHER_MODE_REASON,
    });
  });
  it('opens the terminal for the dialog and the permission prompt, from the record and from the screen alone', () => {
    for (const state of ['dialog', 'permission'] as const) {
      expect(checkAtSend(facts(version, state, { session: readRecord(version, state) }))).toEqual({
        ready: false,
        reason: DIALOG_OPEN_REASON,
      });
      expect(checkAtSend(facts(version, state)).ready).toBe(false);
    }
  });
});
describe.each(STASH_FIXTURE_VERSIONS)(
  'check at Send on captured Claude %s stash screens',
  (version) => {
    it.each([...Object.keys(STASH_READINGS), ...Object.keys(NARROW_READINGS), 'typed'])(
      'lets %s through',
      (state) => {
        expect(checkAtSend(facts(version, state))).toEqual({ ready: true });
      },
    );
    it('opens the terminal while the Ctrl+R history picker is open: its cursor is on the footer, not in the box', () => {
      expect(checkAtSend(facts(version, 'stash-history'))).toEqual({
        ready: false,
        reason: NO_INPUT_BOX_REASON,
      });
    });
  },
);
describe('check at Send', () => {
  it('opens the terminal for a dialog named only in the record, an approval, a scrolled pane, an old or unreadable version and an unread screen', () => {
    const hold = (reason: string) => ({ ready: false, reason });
    expect(
      checkAtSend(
        facts('2.1.301', 'empty', {
          session: { status: 'busy', waitingFor: 'dialog open', version: '2.1.301' },
        }),
      ),
    ).toEqual(hold(DIALOG_OPEN_REASON));
    expect(
      checkAtSend(
        facts('2.1.301', 'empty', {
          session: { status: 'waiting_for_approval', version: '2.1.301' },
        }),
      ),
    ).toEqual(hold(DIALOG_OPEN_REASON));
    const scrolled = { ...readCursor('2.1.301', 'empty'), inMode: true };
    expect(checkAtSend(facts('2.1.301', 'empty', { cursor: scrolled }))).toEqual(
      hold(SCROLLED_REASON),
    );
    for (const version of ['2.1.200', 'garbage'])
      expect(checkAtSend(facts('2.1.301', 'empty', { session: idle(version) }))).toEqual(
        hold(UNKNOWN_VERSION_REASON),
      );
    expect(checkAtSend(facts('2.1.301', 'empty', { screen: undefined }))).toEqual(
      hold(TERMINAL_READ_REASON),
    );
    expect(checkAtSend(facts('2.1.301', 'empty', { cursor: undefined }))).toEqual(
      hold(TERMINAL_READ_REASON),
    );
    // Synthetic: a screen with no input box on it.
    expect(checkAtSend(facts('2.1.301', 'empty', { screen: 'no box here\n' }))).toEqual(
      hold(NO_INPUT_BOX_REASON),
    );
  });
});

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
    {
      paneRunsSession = async () => true,
      clock = stepClock().clock,
    }: { paneRunsSession?: () => Promise<boolean>; clock?: TypingClock } = {},
  ) =>
    typeIntoTerminal({
      terminal,
      requestId,
      body,
      session: idle('2.1.301'),
      paneRunsSession,
      transcriptSize: async () => 1234,
      onTyping,
      clock,
    });
  it('checks, loads the buffer, records typing-started, pastes, sees the paste and presses Enter, in that order', async () => {
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
      'capture',
      'enter',
    ]);
    expect(log.loaded).toEqual(['line one\nline two']);
    expect(typing).toEqual([1234]);
  });
  it('presses Enter only once the pasted text shows in the input', async () => {
    const { terminal, log } = fixtureTerminal('2.1.301', 'empty', { pasteDrawnAfter: 3 });
    const { clock, sleeps } = stepClock();
    expect(await send(terminal, 'hello', undefined, undefined, { clock })).toEqual({
      state: 'typed',
      nativeAfterRevision: 1234,
    });
    expect(log.calls.slice(log.calls.indexOf('paste:gloss-delivery-1'))).toEqual([
      'paste:gloss-delivery-1',
      'capture',
      'capture',
      'capture',
      'capture',
      'enter',
    ]);
    expect(sleeps).toEqual([PASTE_SETTLE_POLL_MS, PASTE_SETTLE_POLL_MS, PASTE_SETTLE_POLL_MS]);
  });
  it('presses Enter once anyway when the paste never shows within the bound', async () => {
    const { terminal, log } = fixtureTerminal('2.1.301', 'empty', { pastedState: null });
    const { clock, sleeps } = stepClock();
    expect(await send(terminal, 'hello', undefined, undefined, { clock })).toEqual({
      state: 'typed',
      nativeAfterRevision: 1234,
    });
    expect(sleeps.reduce((total, ms) => total + ms, 0)).toBe(PASTE_SETTLE_MS);
    expect(log.calls.filter((call) => call === 'enter')).toHaveLength(1);
    expect(log.calls.at(-1)).toBe('enter');
  });
  it('ends the wait for the paste even when the clock stops', async () => {
    const { terminal, log } = fixtureTerminal('2.1.301', 'empty', { pastedState: null });
    const stopped: TypingClock = { now: () => 0, sleep: async () => undefined };
    expect((await send(terminal, 'hello', undefined, undefined, { clock: stopped })).state).toBe(
      'typed',
    );
    expect(log.calls.at(-1)).toBe('enter');
  });
  it('types nothing when the pane switched to another session while the screen was read', async () => {
    for (const paneRunsSession of [
      async () => false,
      async () => {
        throw new Error('record unreadable');
      },
    ]) {
      const { terminal, log } = fixtureTerminal('2.1.301', 'empty');
      let typed = false;
      const result = await send(
        terminal,
        'hello',
        () => {
          typed = true;
        },
        undefined,
        { paneRunsSession },
      );
      expect(result).toEqual({ state: 'failed', reason: SESSION_SWITCHED_REASON });
      expect(typed).toBe(false);
      expect(log.calls).toEqual(['capture', 'cursor']);
    }
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
      paneRunsSession: async () => true,
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
  // Synthetic records (not captured): only a single, whole wrapper with one id in both tags is Claude's paste wrapper.
  it('does not unwrap a record that is not exactly one pasted-content wrapper (synthetic)', () => {
    const send = { id: 'a', body: 'Fix it', after: 0 };
    const records = [
      '<pasted_content id="aa11">\nFix it\n</pasted_content id="bb22">',
      '<pasted_content id="aa11">\nFix it\n</pasted_content id="aa11">\n\n<pasted_content id="aa11">\nFix it\n</pasted_content id="aa11">',
      '<pasted_content id="aa11">\nFix\n</pasted_content id="aa11">\n<pasted_content id="aa11">\nit\n</pasted_content id="aa11">',
      'Please: <pasted_content id="aa11">\nFix it\n</pasted_content id="aa11">',
      '<pasted_content id="aa11">\nFix it\n</pasted_content id="aa11">\nand more',
      '<pasted_content id="aa11">\n<pasted_content id="bb22">\nFix it\n</pasted_content id="bb22">\n</pasted_content id="aa11">',
      '<pasted_content id="aa11">\nFix it later\n</pasted_content id="aa11">',
      '<pasted_content id="aa11">\nFix it',
    ];
    for (const [index, text] of records.entries())
      expect(assignTypedMessages([send], [user(`m${index}`, 1, text)]).size, text).toBe(0);
  });
  it('confirms the text inside one whole pasted-content wrapper and its blank lines (synthetic)', () => {
    const send = { id: 'a', body: 'Fix it\r\nnow', after: 0 };
    const wrapped = '\n\n<pasted_content id="aa11">\nFix it\nnow\n</pasted_content id="aa11">\n';
    expect([...assignTypedMessages([send], [user('m1', 1, wrapped)])]).toEqual([['a', 'm1']]);
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

describe.each(LONG_FIXTURE_VERSIONS)('long pastes in the captured Claude %s session', (version) => {
  const messages = readFileSync(join(FIXTURE_DIR, `claude-typed-long-${version}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line, offset) => {
      const value: unknown = JSON.parse(line);
      const record = recordOf(value);
      if (!record || typeof record.sessionId !== 'string') return [];
      const parsed = parseClaudeRecord(record, offset, record.sessionId);
      return parsed.message ? [parsed.message] : [];
    });
  const confirms = (body: string) =>
    assignTypedMessages([{ id: 'send', body, after: -1 }], messages).has('send');
  const project = CAPTURED_LONG.project(version);
  const reference = (kind: 'file' | 'image', name: string, mime: string): FileReference => ({
    id: name,
    sessionId: 'session',
    kind,
    index: 1,
    name,
    path: `${project}/${name}`,
    worktreePath: project,
    source: 'worktree',
    mime,
    size: 1,
  });
  it('records a chip paste wrapped in pasted-content tags', () => {
    const sevenLines = messages.find((m) => m.text.includes(CAPTURED_LONG.sevenLines));
    expect(sevenLines?.text).toMatch(/^\n\n<pasted_content id="[0-9a-f]+">\n/);
  });
  it('confirms a seven-line message', () => {
    expect(confirms(CAPTURED_LONG.sevenLines)).toBe(true);
  });
  it('confirms a 2,000-character single line', () => {
    expect(CAPTURED_LONG.longLine).toHaveLength(2000);
    expect(confirms(CAPTURED_LONG.longLine)).toBe(true);
  });
  it('confirms a message with the numbered attachment manifest', () => {
    const body = claudeMessage(CAPTURED_LONG.manifestText, [
      reference('file', 'note.txt', 'text/plain'),
      reference('image', 'red.png', 'image/png'),
    ]);
    expect(confirms(body)).toBe(true);
  });
  it('confirms messages on each side of the chip thresholds', () => {
    for (const body of [
      CAPTURED_LONG.probeLines(3),
      CAPTURED_LONG.probeLines(4),
      CAPTURED_LONG.probeLine(800),
      CAPTURED_LONG.probeLine(801),
    ])
      expect(confirms(body), body.slice(0, 40)).toBe(true);
  });
});

describe.each(STASH_FIXTURE_VERSIONS)(
  'transcript of the captured Claude %s stash session',
  (version) => {
    const typed = readFileSync(join(FIXTURE_DIR, `claude-typed-stash-${version}.jsonl`), 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .flatMap((line, offset) => {
        const value: unknown = JSON.parse(line);
        const record = recordOf(value);
        if (!record || typeof record.sessionId !== 'string') return [];
        const parsed = parseClaudeRecord(record, offset, record.sessionId);
        return parsed.message ? [parsed.message] : [];
      })
      .filter((m) => m.role === 'user' && m.clientId === undefined);
    it('records each message sent over a stash exactly, and never the stashed text', () => {
      expect(typed.filter((m) => sameTypedText(m.text, CAPTURED_STASH.busy))).toHaveLength(1);
      expect(typed.filter((m) => sameTypedText(m.text, CAPTURED_STASH.message))).toHaveLength(1);
      expect(
        typed.some(
          (m) =>
            m.text.includes(CAPTURED_STASH.draft) || m.text.includes(CAPTURED_STASH.secondDraft),
        ),
      ).toBe(false);
    });
  },
);
