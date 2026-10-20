import { useEffect, useState, useRef, type ReactNode } from 'react';
import type { SummarySource } from '../core/summary-contracts.js';
import type { SessionClient } from './session-client.js';
import { RichText } from './rich-text.js';
import { languageDirection, languageName } from '../core/language-settings.js';
import { errorMessage } from './error-message.js';
export function ResponseSummaryView({
  client,
  source,
  complete,
  children,
  assist,
}: {
  client: SessionClient;
  source: SummarySource;
  complete: boolean;
  children: ReactNode;
  assist: string;
}) {
  const [text, setText] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const summarize = async () => {
    if (loading) return;
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const result = await client.summarizeResponse(source);
      if (current !== generation.current) return;
      if (
        result.source.kind !== source.kind ||
        result.source.messageId !== source.messageId ||
        result.source.contentHash !== source.contentHash
      )
        throw new Error('Response changed; retry summary');
      setText(result.text);
      setCollapsed(true);
    } catch (error) {
      if (current === generation.current) setError(errorMessage(error, 'Summary failed'));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  };
  return (
    <>
      {complete && (
        <div className="summary-controls">
          {text ? (
            <button type="button" onClick={() => setCollapsed((value) => !value)}>
              {collapsed ? 'Show full response' : 'Show summary'}
            </button>
          ) : (
            <button type="button" disabled={loading} onClick={() => void summarize()}>
              {loading
                ? 'Summarizing…'
                : error
                  ? 'Retry summary'
                  : `Summarize in ${languageName(assist)}`}
            </button>
          )}
          {error && <span role="alert">{error}</span>}
        </div>
      )}
      {collapsed && text && (
        <aside
          className="response-summary"
          aria-label={languageName(assist) + ' summary'}
          dir={languageDirection(assist)}
        >
          <strong>Summary</strong>
          <RichText language={assist} text={text} />
        </aside>
      )}
      <div hidden={collapsed && !!text}>{children}</div>
    </>
  );
}
/** Hash original text, not the translation. A new identity remounts all presentation state. */
export function SummarizableResponse({
  client,
  kind,
  messageId,
  text,
  complete,
  children,
  assist,
}: {
  client: SessionClient;
  kind: SummarySource['kind'];
  messageId: string;
  text: string;
  complete: boolean;
  children: ReactNode;
  assist: string;
}) {
  const identity = JSON.stringify([client.sessionId, kind, messageId, text, complete]);
  const [hashed, setHashed] = useState<{ identity: string; hash: string } | null>(null);
  useEffect(() => {
    let active = true;
    if (complete && text.trim())
      void crypto.subtle
        .digest('SHA-256', new TextEncoder().encode(text))
        .then((buffer) => {
          if (active)
            setHashed({
              identity,
              hash: [...new Uint8Array(buffer)]
                .map((b) => b.toString(16).padStart(2, '0'))
                .join(''),
            });
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [identity]);
  if (!complete || !hashed || hashed.identity !== identity) return <>{children}</>;
  return (
    <ResponseSummaryView
      key={JSON.stringify([identity, assist])}
      client={client}
      source={{ kind, messageId, contentHash: hashed.hash }}
      complete={complete}
      assist={assist}
    >
      {children}
    </ResponseSummaryView>
  );
}
