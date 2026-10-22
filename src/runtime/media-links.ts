import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FileRegistry } from '../core/file-references.js';
import { readReferenceChunks } from './file-content.js';

/**
 * Media elements, PDF frames and <img> cannot send the Authorization header, so the page
 * exchanges its capability for a link to one file. A link is an unguessable token bound to one
 * session, one relative path and that file's identity; every request resolves the path again
 * through the session's folder checks, so a link never reaches anything the capability could not.
 */
export const MEDIA_LINK_PREFIX = '/api/media/';
/** Idle lifetime of a link; each request extends it so a long video keeps seeking. */
const LINK_IDLE_MS = 30 * 60_000;
/** Bound on live links; the least recently used link is dropped first. */
const MAX_LINKS = 128;

interface MediaLink {
  sessionId: string;
  relativePath: string;
  identity: string;
  expiresAt: number;
}
export function createMediaLinks(now = Date.now) {
  const links = new Map<string, MediaLink>();
  return {
    issue(sessionId: string, relativePath: string, identity: string, name: string) {
      const time = now();
      for (const [token, link] of links) if (link.expiresAt <= time) links.delete(token);
      for (const oldest of links.keys()) {
        if (links.size < MAX_LINKS) break;
        links.delete(oldest);
      }
      const token = randomBytes(32).toString('base64url');
      links.set(token, { sessionId, relativePath, identity, expiresAt: time + LINK_IDLE_MS });
      // The trailing name is cosmetic (players and the PDF viewer show it); only the token is read.
      return { url: MEDIA_LINK_PREFIX + token + '/' + encodeURIComponent(name) };
    },
    /** Returns the link for a request path, refreshing its lifetime, or undefined if unknown or expired. */
    use(pathname: string): MediaLink | undefined {
      const token = /^\/api\/media\/([A-Za-z0-9_-]{43})(?:\/[^/]*)?$/.exec(pathname)?.[1];
      const link = token ? links.get(token) : undefined;
      if (!token || !link) return;
      links.delete(token);
      if (link.expiresAt <= now()) return;
      link.expiresAt = now() + LINK_IDLE_MS;
      links.set(token, link);
      return link;
    },
    clear() {
      links.clear();
    },
  };
}
export type MediaLinks = ReturnType<typeof createMediaLinks>;

/**
 * Parses a single `bytes=` range against a file size. Returns undefined to serve the whole
 * file (no header, another unit, or several ranges, which RFC 9110 lets a server ignore) and
 * 'unsatisfiable' for a malformed or out-of-bounds byte range. `end` is inclusive.
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | undefined {
  if (!header) return;
  const value = header.trim();
  if (!/^bytes=/i.test(value) || value.includes(',')) return;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return 'unsatisfiable';
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if (
    (first !== undefined && !Number.isSafeInteger(first)) ||
    (last !== undefined && !Number.isSafeInteger(last))
  )
    return 'unsatisfiable';
  if (first === undefined) {
    // Suffix range: the last N bytes.
    if (!last) return 'unsatisfiable';
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  if (first >= size || (last !== undefined && last < first)) return 'unsatisfiable';
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}

/** Serves one link request (GET or HEAD) with range support. Errors propagate to the server's handler. */
export async function serveMediaLink(
  files: FileRegistry,
  link: MediaLink,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  res.once('close', cancel);
  try {
    const { file, kind, identity } = await files.streamable(
      link.sessionId,
      link.relativePath,
      controller.signal,
    );
    if (identity !== link.identity) throw new Error('File changed; reopen the preview');
    res.setHeader('content-type', file.mime);
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    res.setHeader('referrer-policy', 'no-referrer');
    // An SVG opened directly is a document; sandboxing keeps any script in it from running.
    if (kind === 'svg')
      res.setHeader(
        'content-security-policy',
        "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      );
    const range = parseByteRange(req.headers.range, file.size);
    if (range === 'unsatisfiable') {
      res.statusCode = 416;
      res.setHeader('content-range', `bytes */${file.size}`);
      res.end();
      return;
    }
    res.statusCode = range ? 206 : 200;
    if (range) res.setHeader('content-range', `bytes ${range.start}-${range.end}/${file.size}`);
    res.setHeader('content-length', range ? range.end - range.start + 1 : file.size);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    await pipeline(Readable.from(readReferenceChunks(file, range)), res, {
      signal: controller.signal,
    });
  } finally {
    res.off('close', cancel);
  }
}
