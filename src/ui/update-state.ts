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

/** The current update state, or null in browser mode (no desktop bridge). */
export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    const bridge = updatesBridge();
    if (!bridge) return;
    let live = true;
    // A pushed state is newer than the initial read, so the read must not overwrite it.
    let pushed = false;
    const unsubscribe = bridge.onState((next) => {
      pushed = true;
      if (live) setState(next);
    });
    bridge
      .state()
      .then((initial) => {
        if (live && !pushed && initial) setState(initial);
      })
      .catch(() => undefined); // best effort: the next pushed state fills it in
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return state;
}
