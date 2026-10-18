/** Shared product limits. Both client hints and server validation use these values. */
export const MAX_ATTACHMENTS = 10;
export const MAX_IMAGES = 4;
const MiB = 1024 * 1024;
export const MAX_UPLOAD_BYTES = 10 * MiB;
/** Human-readable upload bound used in validation messages. */
export const MAX_UPLOAD_LABEL = `${MAX_UPLOAD_BYTES / MiB} MB`;
export const MAX_UPLOAD_BASE64_CHARS = 4 * Math.ceil(MAX_UPLOAD_BYTES / 3);
/** Allow JSON metadata and escaping in addition to the base64 payload. */
export const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_BASE64_CHARS + 128 * 1024;
export const MAX_ATTACHMENT_NAME_CHARS = 160;
export const MAX_TEXT_CHARS = 160_000;
/** Longest generated response summary accepted from a language worker. */
export const MAX_SUMMARY_CHARS = 4000;
/** An edited English instruction may exceed MAX_TEXT_CHARS because translation can lengthen text. */
export const MAX_INSTRUCTION_CHARS = 200_000;
export const MAX_TEXT_FILE_BYTES = MAX_TEXT_CHARS * 4;
export const MAX_MEDIA_PREVIEW_BYTES = 128 * MiB;
export const MAX_MEDIA_PREVIEW_LABEL = `${MAX_MEDIA_PREVIEW_BYTES / MiB} MiB`;
/** Largest image file shown inline in the file preview. */
export const MAX_IMAGE_PREVIEW_BYTES = 4 * MiB;
export const MAX_IMAGE_PREVIEW_LABEL = `${MAX_IMAGE_PREVIEW_BYTES / MiB} MiB`;

export const MEDIA_MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
});

export const ATTACHMENT_LIMIT_MESSAGE = `Attach at most ${MAX_ATTACHMENTS} files`;
export const IMAGE_LIMIT_MESSAGE = `Attach at most ${MAX_IMAGES} images`;
export const ATTACHMENT_AND_IMAGE_LIMIT_MESSAGE = `Attach at most ${MAX_ATTACHMENTS} files and ${MAX_IMAGES} images`;
export const DISTINCT_ATTACHMENT_LIMIT_MESSAGE = `Attach at most ${MAX_ATTACHMENTS} distinct files`;
/** Newest-first cap on persisted file TL;DR/translation results, in rows. */
export const MAX_FILE_REVIEW_CACHE_ROWS = 2000;
