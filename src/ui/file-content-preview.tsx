import { MAX_IMAGE_PREVIEW_LABEL, MAX_MEDIA_PREVIEW_BYTES } from '../core/content-policy.js';
import { useMemo, useState, useEffect, useContext, type ReactNode } from 'react';
import type { FilePreview } from '../core/file-references.js';
import { FileLinkContext, localFilePath, isLocalFileLink } from './file-links.js';
import type { SessionClient } from './session-client.js';
import { RichText } from './rich-text.js';
import './file-content-preview.css';
import { errorMessage } from './error-message.js';

function fileFormat(name: string) {
  const extension = name.split('.').at(-1)?.toLowerCase() ?? '';
  if (['md', 'markdown', 'mdown'].includes(extension)) return 'markdown';
  if (['html', 'htm'].includes(extension)) return 'html';
  if (
    [
      'js',
      'jsx',
      'ts',
      'tsx',
      'mjs',
      'cjs',
      'json',
      'jsonc',
      'py',
      'sh',
      'bash',
      'zsh',
      'css',
      'scss',
      'less',
      'java',
      'c',
      'cpp',
      'cc',
      'h',
      'hpp',
      'cs',
      'go',
      'rs',
      'rb',
      'php',
      'sql',
      'yaml',
      'yml',
      'toml',
      'xml',
      'svg',
    ].includes(extension)
  )
    return 'code';
  return 'text';
}
function sourceLines(text: string, highlight: boolean) {
  const lines: ReactNode[][] = [[]];
  let serial = 0;
  const append = (value: string, kind?: string) => {
    value.split('\n').forEach((part, i) => {
      if (i) lines.push([]);
      if (part)
        lines.at(-1)!.push(
          kind ? (
            <span key={serial++} className={'syntax-' + kind}>
              {part}
            </span>
          ) : (
            part
          ),
        );
    });
  };
  if (!highlight) {
    append(text);
    return lines;
  }
  const pattern =
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|if|else|for|while|class|interface|type|import|export|from|async|await|new|throw|try|catch|true|false|null|undefined|def|self|None|True|False|in|as|with|public|private|static|void|package|fn|use|struct|impl|SELECT|FROM|WHERE)\b|\b\d+(?:\.\d+)?\b/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    append(text.slice(cursor, match.index));
    const value = match[0];
    append(
      value,
      /^(\/\/|\/\*|#)/.test(value)
        ? 'comment'
        : /^["'`]/.test(value)
          ? 'string'
          : /^\d/.test(value)
            ? 'number'
            : 'keyword',
    );
    cursor = match.index! + value.length;
  }
  append(text.slice(cursor));
  return lines;
}
function FileSource({ text, highlight }: { text: string; highlight: boolean }) {
  const lines = useMemo(() => sourceLines(text, highlight), [text, highlight]);
  return (
    <div className="file-source" tabIndex={0} aria-label="File source">
      <div className="source-lines">
        {lines.map((line, index) => (
          <div className="source-line" key={index}>
            <span className="line-number" aria-hidden="true">
              {index + 1}
            </span>
            <code>{line.length ? line : '\u200b'}</code>
          </div>
        ))}
      </div>
    </div>
  );
}
function staticHtml(text: string, media: Map<string, string>) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  doc
    .querySelectorAll(
      'script,iframe,frame,frameset,object,embed,base,meta,link,animate,animateMotion,animateTransform,set',
    )
    .forEach((node) => node.remove());
  for (const element of doc.querySelectorAll('*'))
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith('on') ||
        [
          'href',
          'xlink:href',
          'action',
          'formaction',
          'srcdoc',
          'ping',
          'target',
          'download',
        ].includes(name)
      )
        element.removeAttribute(attribute.name);
    }
  doc.querySelectorAll('video,audio').forEach((element) => {
    element.setAttribute('controls', '');
    element.removeAttribute('autoplay');
    element.setAttribute('preload', 'metadata');
  });
  doc
    .querySelectorAll('video[src],audio[src],video source[src],audio source[src]')
    .forEach((element) => {
      const source = element.getAttribute('src') ?? '';
      const resolved = media.get(source);
      if (resolved) element.setAttribute('src', resolved);
      else element.removeAttribute('src');
    });
  doc
    .querySelectorAll('input,button,select,textarea,fieldset')
    .forEach((element) => element.setAttribute('disabled', ''));
  const policy = doc.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content =
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src blob: data: https: http:; form-action 'none'; base-uri 'none'";
  doc.head.prepend(policy);
  return '<!doctype html>' + doc.documentElement.outerHTML;
}
function HtmlPreview({
  text,
  path,
  client,
}: {
  text: string;
  path: string;
  client: SessionClient;
}) {
  const files = useContext(FileLinkContext);
  const root = files?.root ?? '';
  const [document, setDocument] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    const urls: string[] = [];
    setDocument(staticHtml(text, new Map()));
    setErrors([]);
    const prepare = async () => {
      const doc = new DOMParser().parseFromString(text, 'text/html');
      const sources = [
        ...new Set(
          [
            ...doc.querySelectorAll('video[src],audio[src],video source[src],audio source[src]'),
          ].map((el) => el.getAttribute('src') ?? ''),
        ),
      ];
      const media = new Map<string, string>();
      const failures: string[] = [];
      let remaining = MAX_MEDIA_PREVIEW_BYTES;
      for (const source of sources) {
        if (controller.signal.aborted) break;
        try {
          if (/^https?:\/\//i.test(source) || /^data:(video|audio)\//i.test(source)) {
            media.set(source, source);
            continue;
          }
          if (!isLocalFileLink(source)) throw new Error('Unsupported media link');
          const blob = await client.previewMedia(
            localFilePath(source, root, path),
            controller.signal,
            remaining,
          );
          if (controller.signal.aborted) return;
          remaining -= blob.size;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          media.set(source, url);
        } catch (error) {
          if (!controller.signal.aborted)
            failures.push(`${source}: ${errorMessage(error, 'Media unavailable')}`);
        }
      }
      if (!controller.signal.aborted) {
        setDocument(staticHtml(text, media));
        setErrors(failures);
      }
    };
    void prepare();
    return () => {
      controller.abort();
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [text, path, client, root]);
  return (
    <>
      <p className="preview-format-note">
        HTML preview · video controls enabled · scripts are not run
      </p>
      {errors.map((error) => (
        <p key={error} role="status">
          {error}
        </p>
      ))}
      {document ? (
        <iframe
          title="HTML preview"
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
          srcDoc={document}
        />
      ) : (
        <p role="status">Loading HTML preview…</p>
      )}
    </>
  );
}
export function FileContentPreview({
  preview,
  client,
}: {
  preview: FilePreview;
  client: SessionClient;
}) {
  const files = useContext(FileLinkContext);
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const format = fileFormat(preview.name);
  const rendered = preview.state === 'text' && (format === 'markdown' || format === 'html');
  return (
    <>
      {rendered && (
        <div className="file-preview-tabs" role="tablist" aria-label="File display">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'preview'}
            onClick={() => setMode('preview')}
          >
            Preview
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'source'}
            onClick={() => setMode('source')}
          >
            Source
          </button>
        </div>
      )}
      <div
        className={
          'preview-content file-format-' + (rendered && mode === 'preview' ? format : 'source')
        }
      >
        {preview.state === 'text' ? (
          rendered && mode === 'preview' ? (
            format === 'markdown' ? (
              <FileLinkContext.Provider
                value={
                  files
                    ? { ...files, open: (href) => files.open(href, preview.relativePath) }
                    : null
                }
              >
                <RichText text={preview.text ?? ''} />
              </FileLinkContext.Provider>
            ) : (
              <HtmlPreview text={preview.text ?? ''} path={preview.relativePath} client={client} />
            )
          ) : (
            <FileSource text={preview.text ?? ''} highlight={format !== 'text'} />
          )
        ) : preview.state === 'image' ? (
          <img src={preview.dataUrl} alt={preview.name} />
        ) : (
          <p role="status">
            {preview.state === 'large'
              ? `Image exceeds the ${MAX_IMAGE_PREVIEW_LABEL} preview limit.`
              : 'Preview unavailable for this file type. You can still attach the file.'}
          </p>
        )}
      </div>
      {preview.truncated && (
        <p className="preview-format-note" role="status">
          Preview truncated to the first 128 KiB.
        </p>
      )}
    </>
  );
}
