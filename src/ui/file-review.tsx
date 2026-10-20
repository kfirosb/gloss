import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { FilePreview } from '../core/file-references.js';
import type { SessionClient } from './session-client.js';
import {
  languageDirection,
  languageName,
  needsReplyTranslation,
  type LanguageSettings,
} from '../core/language-settings.js';
import { RichText } from './rich-text.js';
import { errorMessage } from './error-message.js';
type Mode = 'summary' | 'translation';
function SavedMark() {
  return (
    <span className="file-review-saved" aria-hidden="true">
      ✓
    </span>
  );
}
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
  const [saved, setSaved] = useState<Partial<Record<Mode, boolean>>>({});
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const { relativePath, version, state } = preview;
  useEffect(() => {
    // Only text previews show the chips, so other files need no status request.
    if (!version || state !== 'text') return;
    const controller = new AbortController();
    client
      .fileReviewStatus(relativePath, version, controller.signal)
      .then((status) => {
        if (controller.signal.aborted) return;
        // Merge: a review finished meanwhile must keep its mark against a slow status response.
        setSaved((current) => ({
          summary: current.summary || status.summary,
          translation: current.translation || status.translation,
        }));
      })
      .catch(() => {
        // Best-effort: the marks are only a hint, and a failed status request must not
        // disturb the preview; the chips simply stay unmarked.
      });
    return () => controller.abort();
  }, [client, relativePath, version, state]);
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
      setSaved((current) => ({ ...current, [next]: true }));
      setMode(next);
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error, 'File review failed'));
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
          title={
            saved.summary
              ? 'Saved summary — shows instantly'
              : `Brief summary in ${languageName(languageSettings.assist)}`
          }
          data-saved={saved.summary ? 'true' : undefined}
          aria-pressed={mode === 'summary'}
          disabled={!!loading}
          onClick={() => void review('summary')}
        >
          TL;DR
          {saved.summary && <SavedMark />}
        </button>
        {needsReplyTranslation(languageSettings) && (
          <button
            type="button"
            title={
              saved.translation
                ? 'Saved translation — shows instantly'
                : `Translate the full file into ${languageName(languageSettings.reply)}`
            }
            data-saved={saved.translation ? 'true' : undefined}
            aria-pressed={mode === 'translation'}
            disabled={!!loading}
            onClick={() => void review('translation')}
          >
            Translate
            {saved.translation && <SavedMark />}
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
          <strong>{mode === 'summary' ? 'Summary' : 'Translation'}</strong>
          <RichText language={code} text={results[mode] ?? ''} />
        </section>
      )}
    </>
  );
}
