import type { EditableFile, LineEnding } from '../core/file-edits.js';

/** Unsaved editor text for one file, with the version it started from. */
export interface FileEditDraft {
  base: EditableFile;
  lineEnding: LineEnding;
  /** The editor's text, line breaks as LF. */
  text: string;
}
/**
 * Unsaved edits, kept in memory only (never in browser storage: they may hold secrets such as .env values). They
 * outlive the editor, so switching sessions and coming back restores them; a page reload or quit does not.
 */
const drafts = new Map<string, FileEditDraft>();
const key = (sessionId: string, relativePath: string) => sessionId + '\n' + relativePath;

/** Asks before the browser page unloads with unsaved edits. The desktop app's quit path does not wait for this. */
const warnOnUnload = (event: BeforeUnloadEvent) => {
  event.preventDefault();
  event.returnValue = '';
};
function syncUnloadGuard() {
  // The desktop window would silently refuse to close; only the browser build shows its own prompt.
  if (typeof window === 'undefined' || window.languageAssistant) return;
  if (drafts.size) window.addEventListener('beforeunload', warnOnUnload);
  else window.removeEventListener('beforeunload', warnOnUnload);
}
export function readDraft(sessionId: string, relativePath: string): FileEditDraft | undefined {
  return drafts.get(key(sessionId, relativePath));
}
export function writeDraft(sessionId: string, relativePath: string, draft: FileEditDraft): void {
  drafts.set(key(sessionId, relativePath), draft);
  syncUnloadGuard();
}
export function clearDraft(sessionId: string, relativePath: string): void {
  drafts.delete(key(sessionId, relativePath));
  syncUnloadGuard();
}
