// "Open in Finder" for the main process, kept free of Electron so it can be unit tested.
// Trust boundary: the page is not trusted and never names an absolute path. It sends a session id and a path relative
// to that session's folder; `locate` asks the local server, which resolves it with the same containment checks as
// every other Files endpoint (relative only, no `..` or symlink escape, must exist). A file is only revealed
// (showItemInFolder) and never opened, because opening a file would launch it; only a folder is opened.
import { isAbsolute } from 'node:path';

const MAX_PATH_CHARS = 4096;

export function createRevealHandler({ locate, showItemInFolder, openPath, isDirectory }) {
  return {
    async handle(payload) {
      const sessionId = payload?.sessionId;
      const relativePath = payload?.relativePath;
      if (
        typeof sessionId !== 'string' ||
        !sessionId ||
        typeof relativePath !== 'string' ||
        relativePath.length > MAX_PATH_CHARS
      )
        return { error: 'Invalid file' };
      let location;
      try {
        location = await locate(sessionId, relativePath);
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'File unavailable' };
      }
      if (!location || typeof location.path !== 'string' || !isAbsolute(location.path))
        return { error: 'File unavailable' };
      if (location.kind === 'file') {
        showItemInFolder(location.path);
        return { ok: true };
      }
      // Checked again right before opening: a folder replaced by a file since the lookup must not be launched.
      if (location.kind !== 'directory' || !isDirectory(location.path))
        return { error: 'Folder unavailable' };
      const failure = await openPath(location.path);
      return failure ? { error: failure } : { ok: true };
    },
  };
}
