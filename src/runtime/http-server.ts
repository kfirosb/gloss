import { MAX_UPLOAD_REQUEST_BYTES } from '../core/content-policy.js';
import { MAX_RUN_COMMAND_LENGTH } from '../core/command-text.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readFileContext, readReferenceChunks } from './file-content.js';
import type { FileReference } from '../core/file-references.js';
import type { Application } from './application.js';
import type { Action } from './protocol.js';
import { readProjectMetadata, type ProjectMetadata } from './project-metadata.js';
import { validateLanguageOverride } from '../core/language-settings.js';
import { isLoopbackHost, isLoopbackOrigin, LOOPBACK_HOST } from './loopback.js';
import { createAsyncCache } from '../core/async-cache.js';

const respond = (res: ServerResponse, status: number, value: unknown) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
};
async function readBody(req: IncomingMessage, limit = 256000) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error('Request too large');
    chunks.push(bytes);
  }
  return size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
function events<T>(
  res: ServerResponse,
  snapshot: T,
  subscribe: (listener: (value: T) => void) => () => void,
) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (value: T) => {
    res.write('data: ' + JSON.stringify(value) + '\n\n');
  };
  send(snapshot);
  // SessionManager subscriptions do not replay; the initial snapshot is sent once here.
  const unsubscribe = subscribe(send);
  res.once('close', unsubscribe);
}
async function attachmentRoute(
  app: Application,
  req: IncomingMessage,
  res: ServerResponse,
  suffix: string,
  sessionId?: string,
) {
  if (req.method === 'POST' && suffix === 'attachments') {
    if (!app.uploadImage) {
      respond(res, 501, { error: 'Attachments unavailable' });
      return true;
    }
    const { path, ...image } = await app.uploadImage(
      await readBody(req, MAX_UPLOAD_REQUEST_BYTES),
      sessionId,
    );
    respond(res, 200, image);
    return true;
  }
  const match = /^attachments\/([^/]+)$/.exec(suffix);
  if (req.method === 'GET' && match) {
    if (!app.readImage) {
      respond(res, 501, { error: 'Attachments unavailable' });
      return true;
    }
    const image = await app.readImage(decodeURIComponent(match[1]!), sessionId);
    res.setHeader('content-type', image.mime);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    if ('sessionId' in image && 'source' in image)
      await pipeline(Readable.from(readReferenceChunks(image as FileReference)), res);
    else res.end(await readFile(image.path));
    return true;
  }
  return false;
}
// Saved records carry the repository's project key (git common dir) so worktrees group under their repository.
const projectMetadataCache = createAsyncCache<string, ProjectMetadata>({ ttlMs: 30_000 });
function cachedProjectMetadata(path: string) {
  // The unavailable fallback is cached too, so a missing folder is not re-read on every listing.
  return projectMetadataCache.get(path, () =>
    readProjectMetadata(path).catch((): ProjectMetadata => ({
      canonicalRoot: '',
      projectName: path,
      available: false,
    })),
  );
}
async function sessionRoute(
  app: Application,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
) {
  if (path !== '/api/sessions' && !path.startsWith('/api/sessions/')) return false;
  if (!app.sessions) {
    respond(res, 501, { error: 'Sessions unavailable' });
    return true;
  }
  if (path === '/api/sessions' && req.method === 'GET') {
    respond(
      res,
      200,
      await Promise.all(
        app.sessions.list().map(async (record) => {
          const meta = await cachedProjectMetadata(record.target.projectId);
          return meta.available
            ? { ...record, ...(meta.projectKey ? { projectKey: meta.projectKey } : {}) }
            : { ...record, folderMissing: true };
        }),
      ),
    );
    return true;
  }
  if (path === '/api/sessions/discover' && req.method === 'POST' && app.discoverSessions) {
    respond(res, 200, await app.discoverSessions((await readBody(req)).projectPath));
    return true;
  }
  if (path === '/api/sessions' && req.method === 'POST' && app.createSession) {
    respond(res, 200, await app.createSession((await readBody(req)).target));
    return true;
  }
  const removal = /^\/api\/sessions\/([^/]+)$/.exec(path);
  if (removal && req.method === 'DELETE') {
    if (!app.removeSession) {
      respond(res, 501, { error: 'Removing sessions is unavailable' });
      return true;
    }
    await app.removeSession(decodeURIComponent(removal[1]!));
    respond(res, 200, { removed: true });
    return true;
  }
  const match = /^\/api\/sessions\/([^/]+)\/(.+)$/.exec(path);
  if (!match) return false;
  const id = decodeURIComponent(match[1]!);
  const route = match[2]!;
  // Validate before reading bodies, opening workflows or allocating SSE subscriptions.
  const snapshot = app.sessions.snapshot(id);
  if (route === 'claude-channel') {
    res.setHeader('cache-control', 'no-store');
    if (req.method === 'GET' && app.claudeChannelStatus) {
      respond(res, 200, await app.claudeChannelStatus(id));
      return true;
    }
    if (req.method === 'POST' && app.prepareClaudeChannel) {
      const body = await readBody(req, 1024);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
        throw new Error('Channel setup accepts no target or filesystem overrides.');
      respond(res, 200, await app.prepareClaudeChannel(id));
      return true;
    }
  }
  if (route === 'language') {
    res.setHeader('cache-control', 'no-store');
    if (req.method === 'GET' && app.sessionLanguage) {
      respond(res, 200, app.sessionLanguage(id));
      return true;
    }
    if (req.method === 'PUT' && app.setSessionLanguage) {
      const body = await readBody(req, 4096);
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new Error('Invalid language settings');
      respond(res, 200, app.setSessionLanguage(id, body));
      return true;
    }
    if (req.method === 'DELETE' && app.setSessionLanguage) {
      respond(res, 200, app.setSessionLanguage(id, null));
      return true;
    }
  }
  if (route === 'usage' && req.method === 'GET' && app.sessionUsage) {
    res.setHeader('cache-control', 'no-store');
    respond(res, 200, app.sessionUsage(id));
    return true;
  }
  if (route === 'snapshot' && req.method === 'GET') {
    respond(res, 200, snapshot);
    return true;
  }
  if (route === 'events' && req.method === 'GET') {
    events(res, snapshot, (listener) => app.sessions!.subscribe(id, listener));
    return true;
  }
  if (route === 'actions' && req.method === 'POST') {
    respond(res, 200, await app.sessions.action(id, (await readBody(req)) as Action));
    return true;
  }
  if (route === 'summaries' && req.method === 'POST') {
    respond(res, 200, await app.sessions.summarizeResponse(id, await readBody(req)));
    return true;
  }
  if (route === 'workspace' && req.method === 'GET' && app.readWorkspace) {
    respond(res, 200, app.readWorkspace(id));
    return true;
  }
  if (route === 'workspace' && req.method === 'PUT' && app.writeWorkspace) {
    const body = await readBody(req);
    respond(res, 200, await app.writeWorkspace(id, body.expectedRevision, body.data));
    return true;
  }
  if (route === 'inventory' && req.method === 'GET' && app.inventory) {
    res.setHeader('cache-control', 'no-store');
    respond(res, 200, await app.inventory(id));
    return true;
  }
  const metadata = /^attachments\/([^/]+)\/metadata$/.exec(route);
  if (req.method === 'GET' && metadata) {
    if (!app.readImage) {
      respond(res, 501, { error: 'Attachments unavailable' });
      return true;
    }
    const {
      id: imageId,
      name,
      mime,
      size,
    } = await app.readImage(decodeURIComponent(metadata[1]!), id);
    respond(res, 200, { id: imageId, name, mime, size });
    return true;
  }
  if (app.files) {
    const fileMetadata = /^files\/([^/]+)\/metadata$/.exec(route);
    if (fileMetadata && req.method === 'GET') {
      const [file] = await app.files.resolve(id, [decodeURIComponent(fileMetadata[1]!)]);
      if (!file) throw new Error('File unavailable');
      if (file.kind === 'image') {
        respond(res, 200, file);
        return true;
      }
      let contentStatus: { state: 'readable' | 'unreadable'; reason?: string };
      try {
        const [context] = await readFileContext([file]);
        contentStatus = context?.unreadable
          ? { state: 'unreadable', reason: context.unreadable }
          : { state: 'readable' };
      } catch (error) {
        contentStatus = {
          state: 'unreadable',
          reason: error instanceof Error ? error.message : 'Content unavailable',
        };
      }
      // Only status leaves this endpoint; decoded text remains operation input.
      respond(res, 200, { ...file, contentStatus });
      return true;
    }
    if (route === 'files' && req.method === 'POST') {
      respond(res, 200, await app.files.upload(id, await readBody(req, MAX_UPLOAD_REQUEST_BYTES)));
      return true;
    }
    if (route === 'files/reference' && req.method === 'POST') {
      respond(res, 200, await app.files.reference(id, (await readBody(req)).relativePath));
      return true;
    }
    if (route === 'files/review' && req.method === 'POST') {
      const body = await readBody(req, 8192);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      res.once('close', cancel);
      try {
        res.setHeader('cache-control', 'no-store');
        respond(
          res,
          200,
          await app.sessions.reviewFile(id, body.path, body.mode, body.version, controller.signal),
        );
      } finally {
        res.off('close', cancel);
      }
      return true;
    }
    if (route === 'files/media' && req.method === 'GET') {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      res.once('close', cancel);
      try {
        const file = await app.files.media(
          id,
          url.searchParams.get('path') ?? '',
          controller.signal,
        );
        res.setHeader('content-length', file.size);
        res.setHeader('content-type', file.mime);
        res.setHeader('cache-control', 'no-store');
        res.setHeader('x-content-type-options', 'nosniff');
        await pipeline(Readable.from(readReferenceChunks(file)), res, {
          signal: controller.signal,
        });
      } finally {
        res.off('close', cancel);
      }
      return true;
    }
    if (['files/browse', 'files/preview', 'files/find'].includes(route) && req.method === 'GET') {
      const controller = new AbortController();
      const cancel = () => controller.abort(new Error('Client cancelled file browsing'));
      res.once('close', cancel);
      try {
        const relativePath = url.searchParams.get('path') ?? '';
        const result =
          route === 'files/browse'
            ? await app.files.browse(
                id,
                relativePath,
                Number(url.searchParams.get('offset') ?? 0),
                controller.signal,
              )
            : route === 'files/preview'
              ? await app.files.preview(id, relativePath, controller.signal)
              : await app.files.find(
                  id,
                  url.searchParams.get('q') ?? '',
                  (url.searchParams.get('mode') ?? 'name') as 'name' | 'content',
                  controller.signal,
                );
        res.setHeader('cache-control', 'no-store');
        respond(res, 200, result);
      } finally {
        res.off('close', cancel);
      }
      return true;
    }
    if (route === 'files/search' && req.method === 'GET') {
      const controller = new AbortController();
      const cancel = () => controller.abort(new Error('Client cancelled file search'));
      res.once('close', cancel);
      try {
        respond(
          res,
          200,
          await app.files.search(id, url.searchParams.get('q') ?? '', controller.signal),
        );
      } finally {
        res.off('close', cancel);
      }
      return true;
    }
    const content = /^files\/([^/]+)\/content$/.exec(route);
    if (content && req.method === 'GET') {
      const [file] = await app.files.resolve(id, [decodeURIComponent(content[1]!)]);
      if (!file) throw new Error('File unavailable');
      res.setHeader('content-type', file.mime);
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      if (file.kind !== 'image')
        res.setHeader(
          'content-disposition',
          "attachment; filename*=UTF-8''" + encodeURIComponent(file.name),
        );
      await pipeline(Readable.from(readReferenceChunks(file)), res);
      return true;
    }
  }
  return attachmentRoute(app, req, res, route, id);
}
async function launchRoute(
  app: Application,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
) {
  if (path !== '/api/launches' && !path.startsWith('/api/launches/')) return false;
  if (!app.launcher) {
    respond(res, 501, { error: 'Session launching unavailable' });
    return true;
  }
  res.setHeader('cache-control', 'no-store');
  if (path === '/api/launches' && req.method === 'GET') {
    respond(res, 200, app.launcher.list());
    return true;
  }
  if (path === '/api/launches' && req.method === 'POST') {
    const body = await readBody(req, 16384);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Error('Invalid launch request');
    // Only these fields are forwarded; argv, executables and environment are never client-controlled.
    const languageOverride =
      body.languageOverride === undefined
        ? undefined
        : validateLanguageOverride(body.languageOverride);
    respond(
      res,
      200,
      await app.launcher.launch({
        agent: body.agent,
        folder: body.folder,
        ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
        ...(languageOverride ? { languageOverride } : {}),
      }),
    );
    return true;
  }
  if (path === '/api/launches/run' && req.method === 'POST') {
    const body = await readBody(req, 16384);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Error('Invalid run request');
    if (typeof body.command !== 'string' || body.command.length > MAX_RUN_COMMAND_LENGTH)
      throw new Error('Invalid command');
    respond(
      res,
      200,
      await app.launcher.run({
        folder: body.folder,
        command: body.command,
        ...(typeof body.originSessionId === 'string'
          ? { originSessionId: body.originSessionId }
          : {}),
      }),
    );
    return true;
  }
  const match = /^\/api\/launches\/([^/]+)\/(terminal-ticket|end|identify)$/.exec(path);
  if (match && req.method === 'POST') {
    const id = decodeURIComponent(match[1]!);
    if (match[2] === 'end') {
      await app.launcher.end(id);
      respond(res, 200, {});
      return true;
    }
    // Retrying can take up to the identification timeout; the catalog reports the outcome.
    if (match[2] === 'identify') {
      if (app.launcher.list().some((r) => r.id === id && r.agent === 'shell'))
        throw new Error('Terminals have nothing to identify');
      if (!app.launcher.list().some((r) => r.id === id && r.state !== 'ended'))
        throw Object.assign(new Error('Unknown launch'), { code: 'unknown-session' });
      void app.launcher.identify(id).catch(() => {});
      respond(res, 202, {});
      return true;
    }
    if (!app.terminals) {
      respond(res, 501, { error: 'Terminal access unavailable' });
      return true;
    }
    respond(res, 200, app.terminals.issueTicket(id));
    return true;
  }
  return false;
}
// Worktree management for one project; the key is the encoded projectKey (Git common dir or plain folder).
async function projectRoute(
  app: Application,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
) {
  const match =
    /^\/api\/projects\/([^/]+)\/(worktrees|worktrees\/inspect|worktrees\/summary|git-init)$/.exec(
      path,
    );
  if (!match) return false;
  res.setHeader('cache-control', 'no-store');
  const key = decodeURIComponent(match[1]!);
  const route = match[2]!;
  const body = async () => {
    const value = await readBody(req, 8192);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  };
  if (route === 'worktrees' && req.method === 'GET' && app.listWorktrees) {
    respond(res, 200, await app.listWorktrees(key));
    return true;
  }
  if (route === 'worktrees' && req.method === 'POST' && app.createWorktree) {
    const input = await body();
    respond(
      res,
      200,
      await app.createWorktree(key, { name: input.name, location: input.location }),
    );
    return true;
  }
  if (route === 'worktrees' && req.method === 'DELETE' && app.removeWorktree) {
    const current = url.searchParams.get('current');
    respond(
      res,
      200,
      await app.removeWorktree(key, {
        path: url.searchParams.get('path'),
        removeConversations: url.searchParams.get('removeConversations') === 'true',
        ...(current ? { current } : {}),
      }),
    );
    return true;
  }
  if (route === 'worktrees/inspect' && req.method === 'GET' && app.inspectWorktree) {
    respond(res, 200, await app.inspectWorktree(key, url.searchParams.get('path')));
    return true;
  }
  if (route === 'worktrees/summary' && req.method === 'POST' && app.summarizeWorktreeChanges) {
    respond(res, 200, await app.summarizeWorktreeChanges(key, (await body()).path));
    return true;
  }
  if (route === 'git-init' && req.method === 'POST' && app.initGit) {
    await body();
    respond(res, 200, await app.initGit(key));
    return true;
  }
  return false;
}
// The native folder picker returns a path; only an existing absolute directory is approved for launching.
async function launchFolderRoute(
  app: Application,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
) {
  if (path !== '/api/launch-folders' || req.method !== 'POST') return false;
  if (!app.approveLaunchFolder) {
    respond(res, 501, { error: 'Folder approval unavailable' });
    return true;
  }
  const body = await readBody(req, 4096);
  const folder =
    body && typeof body === 'object' ? (body as { folder?: unknown }).folder : undefined;
  if (typeof folder !== 'string' || !isAbsolute(folder))
    throw new Error('Folder must be an absolute path');
  const real = await realpath(folder).catch(() => {
    throw new Error('Folder unavailable');
  });
  if (!(await stat(real)).isDirectory()) throw new Error('Folder must be a directory');
  app.approveLaunchFolder(real);
  res.setHeader('cache-control', 'no-store');
  respond(res, 200, { folder: real });
  return true;
}
async function staticRoute(req: IncomingMessage, res: ServerResponse, path: string) {
  if (req.method !== 'GET' || path.startsWith('/api/')) return false;
  if (path.includes('..')) {
    respond(res, 400, { error: 'Invalid path', code: 'bad-request' });
    return true;
  }
  const relative = path === '/' ? '/index.html' : normalize(path);
  try {
    const file = await readFile(join(process.cwd(), 'dist/ui', relative));
    res.setHeader(
      'content-type',
      relative.endsWith('.css')
        ? 'text/css'
        : relative.endsWith('.js')
          ? 'text/javascript'
          : 'text/html',
    );
    res.end(file);
    return true;
  } catch {
    return false;
  }
}
export async function startServer(
  application: Application,
  options: { port?: number; host?: string } = {},
) {
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      if (!isLoopbackHost(host))
        return respond(res, 403, { error: 'Loopback host required', code: 'host-unavailable' });
      const origin = req.headers.origin;
      if (origin && !isLoopbackOrigin(origin))
        return respond(res, 403, { error: 'Origin is not allowed', code: 'origin-rejected' });
      const url = new URL(req.url ?? '/', 'http://' + host);
      if (await staticRoute(req, res, url.pathname)) return;
      if (req.headers.authorization !== 'Bearer ' + application.capability)
        return respond(res, 401, { error: 'Unauthorized', code: 'unauthorized' });
      if (
        req.method === 'GET' &&
        (url.pathname === '/api/session-catalog' || url.pathname === '/api/session-catalog/events')
      ) {
        const catalog = application.catalog;
        if (!catalog) return respond(res, 501, { error: 'Session catalog unavailable' });
        if (url.pathname.endsWith('/events'))
          return events(res, catalog.snapshot(), (listener) => catalog.subscribe(listener));
        res.setHeader('cache-control', 'no-store');
        return respond(res, 200, catalog.snapshot());
      }
      if (
        url.pathname === '/api/usage/refresh' &&
        req.method === 'POST' &&
        application.refreshUsage
      ) {
        const body = (await readBody(req, 1024)) as { provider?: unknown } | null;
        if (
          !body ||
          typeof body !== 'object' ||
          (body.provider !== 'claude' && body.provider !== 'codex')
        ) {
          respond(res, 400, { error: 'Unknown provider' });
          return;
        }
        res.setHeader('cache-control', 'no-store');
        return respond(res, 200, await application.refreshUsage(body.provider));
      }
      if (req.method === 'POST' && url.pathname === '/api/session-catalog/seen') {
        const catalog = application.catalog;
        if (!catalog) return respond(res, 501, { error: 'Session catalog unavailable' });
        const body = (await readBody(req, 4096)) as { sessionId?: unknown; sequence?: unknown };
        if (
          !body ||
          typeof body.sessionId !== 'string' ||
          !Number.isSafeInteger(body.sequence) ||
          (body.sequence as number) < 0
        )
          return respond(res, 400, { error: 'Invalid seen request', code: 'bad-request' });
        const result = catalog.markSeen(body.sessionId, body.sequence as number);
        if (result === 'unknown')
          return respond(res, 404, { error: 'Unknown session', code: 'unknown-session' });
        res.setHeader('cache-control', 'no-store');
        return respond(res, 200, { result });
      }
      if (url.pathname === '/api/about' && req.method === 'GET' && application.about) {
        res.setHeader('cache-control', 'no-store');
        return respond(res, 200, application.about());
      }
      if (
        url.pathname === '/api/folders/search' &&
        req.method === 'GET' &&
        application.searchFolders
      ) {
        res.setHeader('cache-control', 'no-store');
        return respond(res, 200, await application.searchFolders(url.searchParams.get('q') ?? ''));
      }
      if (url.pathname === '/api/folders' && application.listFolders) {
        res.setHeader('cache-control', 'no-store');
        if (req.method === 'GET') return respond(res, 200, await application.listFolders());
        if (req.method === 'POST' && application.connectFolder) {
          const body = await readBody(req, 8192);
          return respond(
            res,
            200,
            await application.connectFolder(
              body && typeof body === 'object' ? (body as { path?: unknown }).path : undefined,
            ),
          );
        }
        if (req.method === 'DELETE' && application.forgetFolder) {
          application.forgetFolder(url.searchParams.get('path'));
          return respond(res, 200, {});
        }
      }
      if (url.pathname === '/api/settings/sidebar') {
        res.setHeader('cache-control', 'no-store');
        if (req.method === 'GET' && application.sidebarSettings)
          return respond(res, 200, application.sidebarSettings());
        if (req.method === 'PUT' && application.setSidebarSettings)
          return respond(res, 200, application.setSidebarSettings(await readBody(req, 65536)));
      }
      if (url.pathname === '/api/settings/language') {
        res.setHeader('cache-control', 'no-store');
        if (req.method === 'GET' && application.languageDefaults)
          return respond(res, 200, application.languageDefaults());
        if (req.method === 'PUT' && application.setLanguageDefaults)
          return respond(res, 200, application.setLanguageDefaults(await readBody(req, 4096)));
      }
      if (url.pathname === '/api/dictation' && req.method === 'GET') {
        res.setHeader('cache-control', 'no-store');
        if (!application.dictation)
          return respond(res, 404, { error: 'Dictation unavailable', code: 'not-found' });
        return respond(res, 200, await application.dictation.status());
      }
      if (url.pathname === '/api/dictation/model/cancel' && req.method === 'POST') {
        if (!application.dictation)
          return respond(res, 404, { error: 'Dictation unavailable', code: 'not-found' });
        application.dictation.cancelDownload();
        return respond(res, 200, { cancelled: true });
      }
      if (url.pathname === '/api/settings/launch') {
        res.setHeader('cache-control', 'no-store');
        if (req.method === 'GET' && application.launchSettings)
          return respond(res, 200, application.launchSettings());
        if (req.method === 'PUT' && application.setLaunchSettings)
          return respond(res, 200, application.setLaunchSettings(await readBody(req, 4096)));
      }
      if (await projectRoute(application, req, res, url.pathname, url)) return;
      if (await launchFolderRoute(application, req, res, url.pathname)) return;
      if (await launchRoute(application, req, res, url.pathname)) return;
      if (await sessionRoute(application, req, res, url.pathname, url)) return;
      if (
        url.pathname.startsWith('/api/') &&
        (await attachmentRoute(application, req, res, url.pathname.slice('/api/'.length)))
      )
        return;
      if (req.method === 'GET' && url.pathname === '/api/snapshot')
        return respond(res, 200, application.snapshot());
      if (req.method === 'POST' && url.pathname === '/api/actions')
        return respond(res, 200, await application.action((await readBody(req)) as Action));
      if (req.method === 'POST' && url.pathname === '/api/source/messages') {
        if (!application.ingestSourceMessage)
          return respond(res, 501, { error: 'Source bridge unavailable' });
        return respond(res, 200, await application.ingestSourceMessage(await readBody(req)));
      }
      if (req.method === 'GET' && url.pathname === '/api/events')
        return events(res, application.snapshot(), (listener) => application.subscribe(listener));
      respond(res, 404, { error: 'Not found', code: 'not-found' });
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      const failure = error as { code?: string; current?: unknown; path?: unknown };
      const fileSystemFailure =
        /^\/api\/sessions\/[^/]+\/files(?:[/?]|$)/.test(req.url ?? '') &&
        failure?.path !== undefined;
      const status =
        failure?.code === 'unknown-session' || failure?.code === 'unknown-project'
          ? 404
          : ['workspace-conflict', 'session-open', 'worktree-conflict'].includes(
                failure?.code ?? '',
              )
            ? 409
            : 400;
      respond(res, status, {
        error: fileSystemFailure
          ? 'File unavailable or unreadable; refresh the folder and try again'
          : error instanceof Error
            ? error.message
            : 'Request failed',
        code: failure?.code ?? 'bad-request',
        ...(failure?.code === 'workspace-conflict' ? { current: failure.current } : {}),
      });
    }
  });
  // Tickets and capabilities travel in these URLs' query strings, so the URLs are never logged.
  server.on('upgrade', (req, socket, head) => {
    const host = req.headers.host ?? '';
    const url = req.url ?? '';
    if (!isLoopbackHost(host)) {
      socket.destroy();
      return;
    }
    if (url.startsWith('/api/launches/') && application.terminals) {
      application.terminals.handleUpgrade(req, socket, head);
      return;
    }
    if (url.startsWith('/api/dictation/') && application.dictation) {
      application.dictation.handleUpgrade(req, socket, head);
      return;
    }
    socket.destroy();
  });
  return new Promise<{ url: string; close(): Promise<void> }>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? LOOPBACK_HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      resolve({
        url:
          'http://' +
          (options.host ?? LOOPBACK_HOST) +
          ':' +
          port +
          '/#capability=' +
          application.capability,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
