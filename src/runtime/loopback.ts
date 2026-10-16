import type { Duplex } from 'node:stream';

/** The address every local listener binds to. */
export const LOOPBACK_HOST = '127.0.0.1';
/** A Host header naming the loopback address or localhost, with an optional port. */
export const isLoopbackHost = (host: string) => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
/** An Origin header for a page served from the loopback address or localhost. */
export const isLoopbackOrigin = (origin: string) =>
  /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
const STATUS_TEXT = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden' } as const;
/** Refuses a WebSocket upgrade on the raw socket with a bare HTTP status and closes it. */
export function rejectUpgrade(socket: Duplex, status: keyof typeof STATUS_TEXT): void {
  socket.write(`HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
