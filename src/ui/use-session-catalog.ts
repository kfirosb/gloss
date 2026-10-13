import { useEffect, useState } from 'react';
import type { CatalogSnapshot } from '../core/session-catalog.js';
import { authHeaders, sessionRequest } from './session-client.js';

export interface SessionCatalogState { catalog: CatalogSnapshot | null; error: string | null }

/** One cancellable transport lifetime, shared by the hook and its ordering tests. */
export function subscribeSessionCatalog(listener: (state: SessionCatalogState) => void): () => void {
 const controller = new AbortController(); const { signal } = controller;
 let current: CatalogSnapshot | null = null;
 let revision = 0;
 const retired = new Set<string>();
 let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
 let retry: ReturnType<typeof setTimeout> | undefined;
 const accept = (value: CatalogSnapshot) => {
  if (signal.aborted || retired.has(value.epoch)) return;
  if (current?.epoch === value.epoch && value.sequence < current.sequence) return;
  if (current && current.epoch !== value.epoch) retired.add(current.epoch);
  current = value; revision++;
  listener({ catalog: current, error: null });
 };
 const failed = (error: unknown) => {
  if (signal.aborted) return;
  const message = error instanceof Error ? error.message : 'Catalog connection unavailable';
  listener({ catalog: current ? { ...current, discovery: { state: 'stale', error: message } } : null, error: message });
 };
 const connect = async () => {
  const requestedAt = revision;
  let active = true;
  let initialHttpEpoch: string | undefined;
  let firstFrame = true;
  // Snapshot and stream may race. A response requested before an accepted event
  // cannot replace it, even if it belongs to a previously unseen epoch.
  void sessionRequest<CatalogSnapshot>('/api/session-catalog', { signal }).then(value => {
   if (active && firstFrame && revision === requestedAt) {
    accept(value);
    if (current?.epoch === value.epoch) initialHttpEpoch = value.epoch;
   }
  }).catch(error => { if (active && firstFrame && revision === requestedAt) failed(error); });
  try {
   const response = await fetch('/api/session-catalog/events', { headers: authHeaders(), signal });
   if (!response.ok || !response.body) throw new Error('Catalog connection unavailable');
   if (signal.aborted) { await response.body.cancel(); return; }
   reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
   while (!signal.aborted) {
    const part = await reader.read();
    if (part.done) throw new Error('Catalog connection interrupted');
    buffer += decoder.decode(part.value, { stream: true });
    const chunks = buffer.split(/\r?\n\r?\n/); buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
     const data = chunk.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
     if (data) {
      const value = JSON.parse(data) as CatalogSnapshot;
      // Concurrent initialization requests have no cross-epoch ordering. A
      // buffered old stream must not retire the epoch returned by HTTP. Retry
      // both against the current server instead of guessing UUID chronology.
      if (firstFrame && initialHttpEpoch && initialHttpEpoch !== value.epoch) {
       throw new Error('Catalog epoch changed during initialization');
      }
      firstFrame = false;
      accept(value);
     }
    }
   }
  } catch (error) { failed(error); }
  finally { active = false; await reader?.cancel().catch(() => {}); reader = undefined; }
  if (!signal.aborted) retry = setTimeout(() => { void connect(); }, 1000);
 };
 void connect();
 return () => { controller.abort(); clearTimeout(retry); void reader?.cancel().catch(() => {}); };
}

export function useSessionCatalog(): SessionCatalogState {
 const [state, setState] = useState<SessionCatalogState>({ catalog: null, error: null });
 useEffect(() => subscribeSessionCatalog(setState), []);
 return state;
}
