import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { FilePreview } from '../core/file-references.js';
import type { SessionClient } from './session-client.js';
import {
  languageDirection,
  needsReplyTranslation,
  type LanguageSettings,
} from '../core/language-settings.js';
import { RichText } from './rich-text.js';
type Mode = 'summary' | 'translation';
export function FileReview({
  client,
  preview,
  children,
  languageSettings,
}: {
  client: SessionClient;
  preview: FilePreview;
  children: ReactNode;
  languageSettings: LanguageSettings;
}) {
  const [mode, setMode] = useState<Mode | 'original'>('original');
  const [results, setResults] = useState<Partial<Record<Mode, string>>>({});
  const [loading, setLoading] = useState<Mode | null>(null);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const review = async (next: Mode) => {
    if (loading) return;
    if (results[next]) {
      setMode(next);
      setError('');
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setLoading(next);
    setError('');
    try {
      const result = await client.reviewFile(
        preview.relativePath,
        next,
        preview.version,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (result.path !== preview.relativePath || result.mode !== next || !result.text.trim())
        throw new Error('File review unavailable; try again');
      setResults((current) => ({ ...current, [next]: result.text }));
      setMode(next);
    } catch (error) {
      if (!controller.signal.aborted)
        setError(error instanceof Error ? error.message : 'File review failed');
    } finally {
      if (!controller.signal.aborted) setLoading(null);
    }
  };
  const code = mode === 'summary' ? languageSettings.assist : languageSettings.reply;
  if (preview.state !== 'text' || !preview.text?.trim()) return <>{children}</>;
  return (
    <>
      <div className="file-review-controls" aria-label="File review tools">
        <button
          type="button"
          title="Brief Hebrew summary"
          aria-pressed={mode === 'summary'}
          disabled={!!loading}
          onClick={() => void review('summary')}
        >
          TL;DR
        </button>
        {needsReplyTranslation(languageSettings) && (
          <button
            type="button"
            title="Translate the full file into Hebrew"
            aria-pressed={mode === 'translation'}
            disabled={!!loading}
            onClick={() => void review('translation')}
          >
            Translate
          </button>
        )}
        {(mode !== 'original' || loading) && (
          <button
            type="button"
            onClick={() => {
              pending.current?.abort();
              setLoading(null);
              setError('');
              setMode('original');
            }}
          >
            Show original
          </button>
        )}
        {loading && (
          <span role="status">{loading === 'summary' ? 'Summarizing…' : 'Translating…'}</span>
        )}
      </div>
      {error && (
        <p role="alert" className="file-review-error">
          {error}
        </p>
      )}
      {mode === 'original' ? (
        children
      ) : (
        <section
          className="preview-content file-review-result"
          aria-label={mode === 'summary' ? 'File summary' : 'File translation'}
          dir={languageDirection(code)}
        >
          <strong>
            {mode === 'summary'
              ? languageSettings.assist === 'he'
                ? 'תקציר הקובץ'
                : 'File summary'
              : 'תרגום הקובץ לעברית'}
          </strong>
          <RichText language={code} text={results[mode] ?? ''} />
        </section>
      )}
    </>
  );
}
