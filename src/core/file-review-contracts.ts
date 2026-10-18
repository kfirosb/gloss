export type FileReviewMode = 'summary' | 'translation';
/** `scope` is the canonical session root the file belongs to. */
export interface FileReviewScope {
  scope: string;
  path: string;
  version: string;
}
export interface FileReviewKey extends FileReviewScope {
  mode: FileReviewMode;
  language: string;
  model: string;
  promptVersion: string;
}
export const FILE_REVIEW_PROMPT_VERSION = 'file-review-v1';
export const fileReviewCacheKey = (key: FileReviewKey): string =>
  JSON.stringify([
    key.scope,
    key.path,
    key.version,
    key.mode,
    key.language,
    key.model,
    key.promptVersion,
  ]);
