// "Open in Finder" for the main process, kept free of Electron so it can be unit tested.
// Trust boundary: the page is not trusted and never names an absolute path. It sends a session id and a path relative
// to that session's folder; `locate` asks the local server, which resolves it with the same containment checks as
// every other Files endpoint (relative only, no `..` or symlink escape, must exist). A file is only revealed
// (showItemInFolder) and never opened, because opening a file would launch it; only a plain folder is opened.
import { basename, isAbsolute } from 'node:path';

const MAX_PATH_CHARS = 4096;
// On macOS an app, bundle, framework or package (`Foo.app`, `.pkg`, `.xcodeproj`) is a directory, and opening it
// launches it. Any folder whose name has an extension is therefore revealed instead, on every platform; a folder
// such as `v1.2` is revealed too, which is the accepted cost of the simple rule. Dot-folders (`.github`) open.
const isPackageLike = (path) => /.\.[^./]+$/.test(basename(path));

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
      if (
        location.kind === 'file' ||
        (location.kind === 'directory' && isPackageLike(location.path))
      ) {
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
