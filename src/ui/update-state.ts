import { useEffect, useState } from 'react';

// Mirrors the UpdateState union in desktop/updater.mjs; the desktop bridge is the only producer.
export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'error'; message: string };

export interface UpdatesBridge {
  onState(callback: (state: UpdateState) => void): () => void;
  state(): Promise<UpdateState | null>;
  check(): Promise<void>;
  install(): Promise<void>;
}

export const updatesBridge = (): UpdatesBridge | undefined => window.gloss?.updates;

/**
 * Subscribes to update states and reads the current one once. A state pushed before the read resolves
 * is newer than the read, so the read never overwrites it. Returns the disposer.
 */
export function watchUpdates(
  bridge: UpdatesBridge,
  onChange: (state: UpdateState) => void,
): () => void {
  let live = true;
  let pushed = false;
  const unsubscribe = bridge.onState((next) => {
    pushed = true;
    if (live) onChange(next);
  });
  bridge
    .state()
    .then((initial) => {
      if (live && !pushed && initial) onChange(initial);
    })
    .catch(() => undefined); // best effort: the next pushed state fills it in
  return () => {
    live = false;
    unsubscribe();
  };
}

/** The current update state, or null in browser mode (no desktop bridge). */
export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    const bridge = updatesBridge();
    return bridge ? watchUpdates(bridge, setState) : undefined;
  }, []);
  return state;
}
