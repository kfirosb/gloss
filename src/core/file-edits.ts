/** Shared contract for editing and creating text files from the Files panel. */

/** A text file opened for editing; `version` is a hash of the bytes the text came from. */
export interface EditableFile {
  relativePath: string;
  text: string;
  version: string;
}
/** The file's version after a save or create. */
export interface SavedFile {
  relativePath: string;
  version: string;
}
/**
 * `file-changed`: the file on disk no longer matches the version the edit started from.
 * `file-exists`: a create named a path that is already taken.
 */
export type FileEditConflictCode = 'file-changed' | 'file-exists';
export const FILE_EDIT_CONFLICT_CODES: readonly FileEditConflictCode[] = [
  'file-changed',
  'file-exists',
];

export type LineEnding = '\n' | '\r\n';
/**
 * The line ending a file mostly uses. Text areas normalize every line break to LF, so a save converts back to
 * this ending; a file with mixed endings is saved with its dominant one.
 */
export function dominantLineEnding(text: string): LineEnding {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lf ? '\r\n' : '\n';
}
/** Text as a text area shows it: every line break as LF. */
export const normalizeLineBreaks = (text: string) => text.replace(/\r\n?/g, '\n');
/** Editor text converted back to the file's line ending; a trailing newline stays exactly as the user left it. */
export const withLineEnding = (text: string, ending: LineEnding) =>
  ending === '\n' ? normalizeLineBreaks(text) : normalizeLineBreaks(text).replace(/\n/g, '\r\n');

/**
 * Environment and key files. Their content may be edited but is never sent for TL;DR or translation.
 * Matched on the file name only.
 */
export function isSecretFileName(pathOrName: string): boolean {
  const name = (pathOrName.split(/[\\/]/).at(-1) ?? '').toLowerCase();
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    name.endsWith('.env') ||
    name === '.envrc' ||
    name === '.netrc' ||
    name === '.npmrc' ||
    name === '.pypirc' ||
    /\.(pem|key|p12|pfx)$/.test(name) ||
    /^id_(rsa|dsa|ecdsa|ed25519)$/.test(name)
  );
}

/** The English note "Tell the agent" puts in the composer; the user decides whether to send it. */
export const fileEditedNote = (relativePath: string) => `I edited ${relativePath}.`;
