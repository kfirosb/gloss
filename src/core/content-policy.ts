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

/** Kinds the Files preview plays or shows from a streamed local URL instead of inline data. */
export type StreamedPreviewKind = 'video' | 'audio' | 'pdf' | 'svg';
/** Kinds that are recognized but deliberately not previewed. */
export type UnpreviewedKind = 'archive' | 'binary';
const GiB = 1024 * MiB;
/**
 * Largest file per streamed kind, in bytes. Video and audio are served with range requests,
 * so the browser fetches only what it plays; PDFs are read whole by the viewer; SVG matches
 * the inline image limit because it is decoded as one image.
 */
export const MAX_STREAMED_PREVIEW_BYTES: Readonly<Record<StreamedPreviewKind, number>> =
  Object.freeze({
    video: 2 * GiB,
    audio: 512 * MiB,
    pdf: 128 * MiB,
    svg: MAX_IMAGE_PREVIEW_BYTES,
  });
export function isStreamedPreviewKind(value: unknown): value is StreamedPreviewKind {
  return typeof value === 'string' && Object.hasOwn(MAX_STREAMED_PREVIEW_BYTES, value);
}
const STREAMED_PREVIEW_TYPES: Readonly<
  Record<string, { kind: StreamedPreviewKind; mime: string }>
> = Object.freeze({
  '.mp4': { kind: 'video', mime: 'video/mp4' },
  '.m4v': { kind: 'video', mime: 'video/mp4' },
  '.mov': { kind: 'video', mime: 'video/quicktime' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.ogv': { kind: 'video', mime: 'video/ogg' },
  '.mp3': { kind: 'audio', mime: 'audio/mpeg' },
  '.m4a': { kind: 'audio', mime: 'audio/mp4' },
  '.wav': { kind: 'audio', mime: 'audio/wav' },
  '.ogg': { kind: 'audio', mime: 'audio/ogg' },
  '.pdf': { kind: 'pdf', mime: 'application/pdf' },
  '.svg': { kind: 'svg', mime: 'image/svg+xml' },
});
const ARCHIVE_EXTENSIONS = new Set([
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.dmg',
  '.jar',
  '.deb',
  '.rpm',
  '.appimage',
]);
const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
};
/** The streamed preview kind and served MIME type for a file name, by extension only. */
export function streamedPreviewType(name: string) {
  return STREAMED_PREVIEW_TYPES[extensionOf(name)];
}
export function isArchiveName(name: string): boolean {
  return ARCHIVE_EXTENSIONS.has(extensionOf(name));
}
export function byteLimitLabel(bytes: number): string {
  return bytes >= GiB && bytes % GiB === 0 ? `${bytes / GiB} GiB` : `${bytes / MiB} MiB`;
}
const KIND_NAMES: Record<StreamedPreviewKind | 'image', string> = {
  video: 'Video',
  audio: 'Audio',
  pdf: 'PDF',
  svg: 'SVG image',
  image: 'Image',
};
export function previewLimitMessage(kind: StreamedPreviewKind | 'image'): string {
  const limit = kind === 'image' ? MAX_IMAGE_PREVIEW_BYTES : MAX_STREAMED_PREVIEW_BYTES[kind];
  return `${KIND_NAMES[kind]} exceeds the ${byteLimitLabel(limit)} preview limit.`;
}
export const UNPREVIEWED_MESSAGES: Readonly<Record<UnpreviewedKind, string>> = Object.freeze({
  archive: 'Archives are not previewed. You can still attach the file.',
  binary: 'Binary files are not previewed. You can still attach the file.',
});
/** A short kind label for an attachment card ("Video", "Audio", "PDF"), or undefined for plain files. */
export function attachmentKindLabel(name: string): string | undefined {
  const type = streamedPreviewType(name);
  if (type) return type.kind === 'svg' ? 'SVG' : KIND_NAMES[type.kind];
  return isArchiveName(name) ? 'Archive' : undefined;
}

export const ATTACHMENT_LIMIT_MESSAGE = `Attach at most ${MAX_ATTACHMENTS} files`;
export const IMAGE_LIMIT_MESSAGE = `Attach at most ${MAX_IMAGES} images`;
export const ATTACHMENT_AND_IMAGE_LIMIT_MESSAGE = `Attach at most ${MAX_ATTACHMENTS} files and ${MAX_IMAGES} images`;
export const DISTINCT_ATTACHMENT_LIMIT_MESSAGE = `Attach at most ${MAX_ATTACHMENTS} distinct files`;
/** Newest-first cap on persisted file TL;DR/translation results, in rows. */
export const MAX_FILE_REVIEW_CACHE_ROWS = 2000;
