import { recordOf, type JsonRecord } from '../core/json-record.js';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import * as pty from 'node-pty';
import { WebSocketServer } from 'ws';
import { isLoopbackOrigin, rejectUpgrade } from './loopback.js';
import type { LaunchRecord } from './session-launcher.js';
import { isTerminalWheel } from '../core/terminal-wheel.js';
import { sessionNameFor, tmuxEnvironment, type Tmux } from './tmux.js';

export interface PtyProcess {
  onData(cb: (d: Buffer) => void): void;
  write(d: string | Buffer): void;
  kill(): void;
  onExit(cb: () => void): void;
  resize?(cols: number, rows: number): void;
  pause?(): void;
  resume?(): void;
}
export interface TerminalBridge {
  issueTicket(launchId: string): { ticket: string; expiresAt: number };
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
}

// PTY strategy recorded in docs/superpowers/research/2026-10-10-terminal-popup-spike.md: node-pty.
// The attach client must not see an enclosing tmux (nested-session refusal) or the panel capability.
export const attachEnvironment = (env: NodeJS.ProcessEnv = process.env): Record<string, string> =>
  ({ ...tmuxEnvironment(env), TERM: 'xterm-256color' }) as Record<string, string>;
export function nodePty(
  argv: string[],
  cols = 80,
  rows = 24,
  spawn: typeof pty.spawn = pty.spawn,
): PtyProcess {
  const child = spawn(argv[0]!, argv.slice(1), {
    name: 'xterm-256color',
    cols,
    rows,
    encoding: null,
    env: attachEnvironment(),
  });
  let exited = false;
  child.onExit(() => {
    exited = true;
  });
  return {
    onData: (cb) => {
      child.onData((d) => cb(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    },
    write: (d) => {
      if (!exited) child.write(d);
    },
    resize: (c, r) => {
      if (!exited)
        try {
          child.resize(c, r);
        } catch {
          /* pty already closed */
        }
    },
    kill: () => {
      if (exited) return;
      try {
        child.kill('SIGHUP');
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        if (!exited)
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
      }, 2000).unref();
    },
    onExit: (cb) => {
      child.onExit(() => cb());
    },
    pause: () => {
      if (!exited) child.pause();
    },
    resume: () => {
      if (!exited) child.resume();
    },
  };
}

const HIGH_WATER = 1024 * 1024,
  HARD_CAP = 8 * 1024 * 1024,
  RATE_PER_SECOND = 200,
  RATE_BURST = 400,
  RATE_ABUSE_DROPS = 200;
const PATH = /^\/api\/launches\/([A-Za-z0-9-]{1,64})\/terminal$/;
export function createTerminalBridge(options: {
  tmux: () => Promise<Tmux>;
  launches: () => LaunchRecord[];
  now?: () => number;
  spawnPty?: (argv: string[]) => PtyProcess;
}): TerminalBridge {
  const now = options.now ?? Date.now;
  const tickets = new Map<string, { launchId: string; expiresAt: number }>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const live = (id: string) => options.launches().find((r) => r.id === id && r.state !== 'ended');
  return {
    issueTicket(launchId) {
      if (!live(launchId))
        throw Object.assign(new Error('Unknown launch'), { code: 'unknown-session' });
      for (const [k, v] of tickets) if (v.expiresAt <= now()) tickets.delete(k);
      const ticket = randomBytes(24).toString('hex');
      const expiresAt = now() + 30_000;
      tickets.set(ticket, { launchId, expiresAt });
      return { ticket, expiresAt };
    },
    handleUpgrade(req, socket, head) {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const match = PATH.exec(url.pathname);
      const origin = req.headers.origin;
      if (origin && !isLoopbackOrigin(origin)) return rejectUpgrade(socket, 403);
      const ticket = url.searchParams.get('ticket') ?? '';
      const entry = tickets.get(ticket);
      tickets.delete(ticket);
      if (
        !match ||
        !entry ||
        entry.launchId !== match[1] ||
        entry.expiresAt <= now() ||
        !live(entry.launchId)
      )
        return rejectUpgrade(socket, 401);
      const launchId = entry.launchId;
      wss.handleUpgrade(req, socket, head, async (ws) => {
        let closed = false;
        let proc: PtyProcess | undefined;
        // A malformed or oversized client frame makes ws emit 'error'; without a listener that crashes the process.
        ws.on('error', () => ws.terminate());
        ws.on('close', () => {
          closed = true;
          proc?.kill();
        });
        const fail = () => {
          if (ws.readyState === ws.OPEN) ws.close(1011, 'terminal unavailable');
          else ws.terminate();
        };
        let tmux: Tmux;
        const name = sessionNameFor(launchId);
        try {
          tmux = await options.tmux();
          if (closed) return;
          proc = (options.spawnPty ?? nodePty)(tmux.attachArgv(name));
        } catch {
          fail();
          return;
        }
        const pty = proc;
        let paused = false;
        pty.onData((d) => {
          if (ws.readyState !== ws.OPEN) return;
          ws.send(d, () => {
            if (paused && ws.bufferedAmount < HIGH_WATER / 2) {
              paused = false;
              pty.resume?.();
            }
          });
          if (ws.bufferedAmount > HARD_CAP) {
            ws.terminate();
            return;
          }
          if (!paused && ws.bufferedAmount > HIGH_WATER && pty.pause) {
            paused = true;
            pty.pause();
          }
        });
        pty.onExit(() => ws.close());
        // Input and scrolling run in arrival order; after scrolling up, the pane may be browsing history in copy
        // mode, which would swallow keystrokes, so typing first returns it to the live screen.
        let ordered = Promise.resolve();
        let browsing = false;
        const inOrder = (step: () => Promise<void>) => {
          ordered = ordered.then(step).catch(() => undefined);
        };
        let tokens = RATE_BURST;
        let last = now();
        let dropped = 0;
        ws.on('message', (raw) => {
          const t = now();
          tokens = Math.min(RATE_BURST, tokens + ((t - last) * RATE_PER_SECOND) / 1000);
          last = t;
          if (tokens < 1) {
            if (++dropped > RATE_ABUSE_DROPS) ws.terminate();
            return;
          }
          tokens -= 1;
          let m: JsonRecord | undefined;
          try {
            m = recordOf(JSON.parse(String(raw)));
          } catch {
            return;
          }
          if (m?.type === 'input' && typeof m.data === 'string') {
            const data = m.data;
            inOrder(async () => {
              if (browsing) {
                browsing = false;
                await tmux.exitCopyMode(name).catch(() => undefined);
              }
              pty.write(data);
            });
          } else if (m?.type === 'scroll') {
            const wheel = { lines: Number(m.lines), col: Number(m.col), row: Number(m.row) };
            if (!isTerminalWheel(wheel)) return;
            inOrder(async () => {
              if (wheel.lines < 0) browsing = true;
              await tmux.scroll(name, wheel);
            });
          } else if (m?.type === 'resize') {
            const cols = Number(m.cols),
              rows = Number(m.rows);
            if (![cols, rows].every((n) => Number.isSafeInteger(n) && n >= 10 && n <= 1000)) return;
            pty.resize?.(cols, rows);
            void tmux.resizeWindow(name, cols, rows).catch(() => undefined);
          }
        });
      });
    },
    close() {
      tickets.clear();
      for (const c of wss.clients) c.terminate();
      wss.close();
    },
  };
}
