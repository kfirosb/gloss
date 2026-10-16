import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { Attachment } from '../core/contracts.js';
import type { FileContentStatus, SessionClient } from './session-client.js';
import { errorMessage } from './error-message.js';
export const ImageSessionContext = createContext<SessionClient | null>(null);
export type CardReference =
  | (Attachment & { contentStatus?: FileContentStatus })
  | { id: string; name: string; mime: string; size: number; status: string };
function Preview({ file, client }: { file: CardReference; client: SessionClient }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  const headers = useMemo(
    () => ({
      Authorization: 'Bearer ' + new URLSearchParams(location.hash.slice(1)).get('capability'),
    }),
    [],
  );
  useEffect(() => {
    const abort = new AbortController();
    let objectUrl = '';
    setUrl('');
    setFailed(false);
    void fetch('sessionId' in file ? client.fileUrl(file.id) : client.imageUrl(file.id), {
      headers,
      signal: abort.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw Error('Unavailable');
        const blob = await r.blob();
        if (abort.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!abort.signal.aborted) setFailed(true);
      });
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.id, client, headers]);
  return url ? (
    <img src={url} alt={file.name} />
  ) : (
    <span>{failed ? 'Preview unavailable' : 'Loading image…'}</span>
  );
}
function displayOriginalPath(file: CardReference): string | undefined {
  if (!('originalPath' in file) || !file.originalPath) return;
  const original = file.originalPath.replaceAll('\\', '/');
  if ('path' in file && (!('source' in file) || file.source !== 'worktree')) {
    const managed = file.path.replaceAll('\\', '/');
    const directory = managed.slice(0, managed.lastIndexOf('/') + 1);
    if (original === managed || (directory && original.startsWith(directory))) return;
  }
  const root =
    'worktreePath' in file ? file.worktreePath.replaceAll('\\', '/').replace(/\/$/, '') : '';
  if (root && original.startsWith(root + '/')) return original.slice(root.length + 1);
  if ('source' in file && file.source === 'worktree')
    return /^(?:\/|[A-Za-z]:)/.test(original) ? file.name : original;
  return /^(?:\/|[A-Za-z]:)/.test(original) ? original : undefined;
}
function ReferenceCard({
  file,
  client,
  onRemove,
}: {
  file: CardReference;
  client: SessionClient | null;
  onRemove?: ((id: string) => void) | undefined;
}) {
  const originalPath = displayOriginalPath(file);
  const suppliedStatus = 'contentStatus' in file ? file.contentStatus : undefined;
  const generic = 'kind' in file && file.kind === 'file';
  const [contentStatus, setContentStatus] = useState<FileContentStatus | undefined>(suppliedStatus);
  useEffect(() => {
    setContentStatus(suppliedStatus);
    if (!generic || suppliedStatus || !client) return;
    const controller = new AbortController();
    // Historical snapshots retain captured identity; refresh only content status.
    void client
      .fileMetadata(file.id, controller.signal)
      .then((metadata) => {
        if (!controller.signal.aborted) setContentStatus(metadata.contentStatus);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setContentStatus({
            state: 'unreadable',
            reason: errorMessage(error, 'Content unavailable'),
          });
      });
    return () => controller.abort();
  }, [file.id, generic, suppliedStatus, client]);
  const image = file.mime.startsWith('image/');
  const label = ('kind' in file ? file.kind === 'image' : image) ? 'Image' : 'File';
  const number = 'index' in file ? file.index : undefined;
  return (
    <figure
      className={'attachment-card' + (image && onRemove ? ' image-thumb' : '')}
      dir="ltr"
      data-reference-id={file.id}
    >
      {image && client && <Preview file={file} client={client} />}
      <figcaption>
        {label} {number ?? '—'}
      </figcaption>
      <strong>{file.name}</strong>
      {originalPath && <span className="reference-path">{originalPath}</span>}
      {'source' in file && file.source === 'upload' && <span>Uploaded copy</span>}
      {'status' in file && <span role="status">{file.status}</span>}
      {contentStatus?.state === 'unreadable' && (
        <span role="status">
          Unreadable content: {contentStatus.reason ?? 'Content unavailable'}
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${label} ${number ?? '—'}`}
          onClick={() => onRemove(file.id)}
        >
          Remove
        </button>
      )}
    </figure>
  );
}
export function AttachmentCards({
  references,
  onRemove,
  client: provided,
}: {
  references: CardReference[] | undefined;
  onRemove?: (id: string) => void;
  client?: SessionClient;
}) {
  const context = useContext(ImageSessionContext);
  const client = provided ?? context;
  if (!references?.length) return null;
  return (
    <div className="reference-images attachment-cards">
      {references.map((file) => (
        <ReferenceCard key={file.id} file={file} client={client} onRemove={onRemove} />
      ))}
    </div>
  );
}
