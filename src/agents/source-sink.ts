import type { SourceSink } from './shared.js';

export interface HttpSourceSinkOptions {
  endpoint: string;
  capability: string;
  fetcher?: typeof fetch;
  onDelivered?: (message: Parameters<SourceSink['send']>[0]) => void;
}

/** Sends agent-stamped completed assistant messages to the local panel bridge. */
export function createHttpSourceSink(options: HttpSourceSinkOptions): SourceSink {
  const fetcher = options.fetcher ?? fetch;
  return {
    async send(message) {
      const response = await fetcher(options.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.capability}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`Source bridge rejected message (${response.status})`);
      options.onDelivered?.(message);
    },
  };
}
