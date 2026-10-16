import { useEffect, useState } from 'react';
import type { CatalogSnapshot } from '../core/session-catalog.js';
import { authHeaders, sessionRequest } from './session-client.js';
import { readServerEvents } from './server-events.js';

export interface SessionCatalogState {
  catalog: CatalogSnapshot | null;
  error: string | null;
}

/** One cancellable transport lifetime, shared by the hook and its ordering tests. */
export function subscribeSessionCatalog(
  listener: (state: SessionCatalogState) => void,
): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  let current: CatalogSnapshot | null = null;
  let revision = 0;
  const retired = new Set<string>();
  let retry: ReturnType<typeof setTimeout> | undefined;
  const accept = (value: CatalogSnapshot) => {
    if (signal.aborted || retired.has(value.epoch)) return;
    if (current?.epoch === value.epoch && value.sequence < current.sequence) return;
    if (current && current.epoch !== value.epoch) retired.add(current.epoch);
    current = value;
    revision++;
    listener({ catalog: current, error: null });
  };
  const failed = (error: unknown) => {
    if (signal.aborted) return;
    const message = error instanceof Error ? error.message : 'Catalog connection unavailable';
    listener({
      catalog: current ? { ...current, discovery: { state: 'stale', error: message } } : null,
      error: message,
    });
  };
  const connect = async () => {
    const requestedAt = revision;
    let active = true;
    let initialHttpEpoch: string | undefined;
    let firstFrame = true;
    // Snapshot and stream may race. A response requested before an accepted event
    // cannot replace it, even if it belongs to a previously unseen epoch.
    void sessionRequest<CatalogSnapshot>('/api/session-catalog', { signal })
      .then((value) => {
        if (active && firstFrame && revision === requestedAt) {
          accept(value);
          if (current?.epoch === value.epoch) initialHttpEpoch = value.epoch;
        }
      })
      .catch((error) => {
        if (active && firstFrame && revision === requestedAt) failed(error);
      });
    try {
      const response = await fetch('/api/session-catalog/events', {
        headers: authHeaders(),
        signal,
      });
      if (!response.ok || !response.body) throw new Error('Catalog connection unavailable');
      if (signal.aborted) {
        await response.body.cancel();
        return;
      }
      for await (const value of readServerEvents<CatalogSnapshot>(response.body, signal)) {
        // Concurrent initialization requests have no cross-epoch ordering. A
        // buffered old stream must not retire the epoch returned by HTTP. Retry
        // both against the current server instead of guessing UUID chronology.
        if (firstFrame && initialHttpEpoch && initialHttpEpoch !== value.epoch) {
          throw new Error('Catalog epoch changed during initialization');
        }
        firstFrame = false;
        accept(value);
      }
      if (!signal.aborted) throw new Error('Catalog connection interrupted');
    } catch (error) {
      failed(error);
    } finally {
      active = false;
    }
    if (!signal.aborted)
      retry = setTimeout(() => {
        void connect();
      }, 1000);
  };
  void connect();
  return () => {
    controller.abort();
    clearTimeout(retry);
  };
}

export function useSessionCatalog(): SessionCatalogState {
  const [state, setState] = useState<SessionCatalogState>({ catalog: null, error: null });
  useEffect(() => subscribeSessionCatalog(setState), []);
  return state;
}
