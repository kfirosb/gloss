import type { SessionClient } from './session-client.js';
import { MAX_ATTACHMENTS } from '../core/content-policy.js';
import { useRef, type ReactNode } from 'react';
import { AttachmentCards, type CardReference } from './attachment-cards.js';
import type { Attachment } from '../core/contracts.js';
export { ImageSessionContext } from './attachment-cards.js';
export function ImageAttachments({
  images,
  busy,
  add,
  remove,
  client,
  children,
}: {
  children?: ReactNode;
  client: SessionClient;
  images: CardReference[];
  busy: boolean;
  add(files: File[]): void;
  remove(id: string): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="attachment-tools">
      <input
        ref={input}
        type="file"
        aria-label="Attach files"
        multiple
        hidden
        onChange={(e) => {
          add(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      <button
        type="button"
        disabled={busy || images.length >= MAX_ATTACHMENTS}
        onClick={() => input.current?.click()}
        title="Attach files, or paste a screenshot"
      >
        {busy ? 'Attaching…' : 'Attach files'}
      </button>
      {children}
      <AttachmentCards client={client} references={images} onRemove={remove} />
    </div>
  );
}
export function ReferenceImages({
  images,
  client,
}: {
  client?: SessionClient;
  images: Attachment[] | undefined;
}) {
  return <AttachmentCards references={images} {...(client ? { client } : {})} />;
}
