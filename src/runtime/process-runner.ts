import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxDiagnosticBytes?: number;
  maxLineBytes?: number;
}
export interface ProcessOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  reason: 'exited' | 'cancelled' | 'timeout' | 'output-limit' | 'spawn-error';
  /** Internal diagnostics only. Never forward to a browser or use as an Error message. */
  diagnostics: string;
}
export type ProcessEvent = { type: 'line'; line: string } | { type: 'exit'; outcome: ProcessOutcome };
export type ProcessRunner = (executable: string, args: string[], input: string, signal: AbortSignal, options?: ProcessOptions) => AsyncIterable<ProcessEvent>;

/** Bounded JSONL-friendly output, with shell-free arguments and explicit terminal outcome. */
export async function* runProcess(executable: string, args: string[], input: string, signal: AbortSignal, options: ProcessOptions = {}): AsyncGenerator<ProcessEvent> {
  if (signal.aborted) { yield { type: 'exit', outcome: { code: null, signal: null, reason: 'cancelled', diagnostics: '' } }; return; }
  const maxOutput = options.maxOutputBytes ?? 2 * 1024 * 1024;
  const maxLine = options.maxLineBytes ?? 256 * 1024;
  const maxDiagnostic = options.maxDiagnosticBytes ?? 8192;
  const queue: ProcessEvent[] = [];
  let wake: (() => void) | undefined;
  const push = (event: ProcessEvent) => { queue.push(event); wake?.(); wake = undefined; };
  // Own a separate POSIX process group so helpers cannot outlive cancellation or
  // hold inherited pipes open. This group never contains the launching coding CLI.
  const ownGroup = process.platform !== 'win32';
  const child = spawn(executable, args, { shell: false, detached: ownGroup, stdio: ['pipe', 'pipe', 'pipe'], ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.env ? { env: options.env } : {}) });
  let reason: ProcessOutcome['reason'] = 'exited';
  let closed = false;
  let partial = '';
  let outputBytes = 0;
  let diagnostic = Buffer.alloc(0);
  let cleanup: Promise<void> | undefined;
  const killOwned = (killSignal: NodeJS.Signals) => {
    try {
      if (ownGroup && child.pid) process.kill(-child.pid, killSignal);
      else child.kill(killSignal);
    } catch { /* The owned group may already have exited. */ }
  };
  const stop = (why: ProcessOutcome['reason']) => {
    if (closed) return;
    if (reason === 'exited') reason = why;
    killOwned('SIGTERM');
    // The leader can close while a helper with separate stdio is still alive.
    // Keep this group cleanup independent of the leader's close event, and wait
    // for it before publishing the terminal outcome or finishing iterator return.
    cleanup ??= new Promise<void>(resolve => setTimeout(() => {
      if (ownGroup || !closed) killOwned('SIGKILL');
      resolve();
    }, 250));
  };
  const abort = () => stop('cancelled');
  const timeout = setTimeout(() => stop('timeout'), options.timeoutMs ?? 90_000);
  signal.addEventListener('abort', abort, { once: true });
  const decoder = new StringDecoder('utf8');
  child.stdout.on('data', (chunk: Buffer) => {
    if (reason !== 'exited') return;
    outputBytes += chunk.length;
    if (outputBytes > maxOutput) { stop('output-limit'); return; }
    partial += decoder.write(chunk);
    let end: number;
    while ((end = partial.indexOf('\n')) >= 0) {
      const line = partial.slice(0, end).replace(/\r$/, '');
      partial = partial.slice(end + 1);
      if (Buffer.byteLength(line) > maxLine) { stop('output-limit'); return; }
      push({ type: 'line', line });
    }
    if (Buffer.byteLength(partial) > maxLine) stop('output-limit');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const remaining = maxDiagnostic - diagnostic.length;
    if (remaining > 0) diagnostic = Buffer.concat([diagnostic, chunk.subarray(0, remaining)]);
  });
  child.on('error', () => { reason = 'spawn-error'; });
  // EPIPE is expected when cancellation or an early CLI failure closes stdin.
  child.stdin.on('error', () => {});
  const finished = new Promise<void>(resolve => child.once('close', async (code, exitSignal) => {
    closed = true;
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    await cleanup;
    partial += decoder.end();
    if (partial && reason === 'exited') push({ type: 'line', line: partial.replace(/\r$/, '') });
    // A decoder drops a trailing partial UTF8 sequence, preserving the byte bound.
    const diagnosticDecoder = new StringDecoder('utf8');
    push({ type: 'exit', outcome: { code, signal: exitSignal, reason, diagnostics: diagnosticDecoder.write(diagnostic) } });
    resolve();
  }));
  child.stdin.end(input, 'utf8');
  if (signal.aborted) abort();
  try {
    while (true) {
      const event = queue.shift();
      if (event) { yield event; if (event.type === 'exit') return; }
      else await new Promise<void>(resolve => { wake = resolve; });
    }
  } finally {
    if (!closed) stop('cancelled');
    await finished;
  }
}

export async function collectProcess(events: AsyncIterable<ProcessEvent>): Promise<{ lines: string[]; outcome: ProcessOutcome }> {
  const lines: string[] = [];
  for await (const event of events) {
    if (event.type === 'line') lines.push(event.line);
    else return { lines, outcome: event.outcome };
  }
  throw new Error('Process ended without an exit outcome.');
}
