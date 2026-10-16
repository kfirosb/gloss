import { useEffect, useState } from 'react';
import type { CatalogEntry } from '../core/session-catalog.js';

export const ALERT_SOUNDS = [
  'Basso',
  'Blow',
  'Bottle',
  'Frog',
  'Funk',
  'Glass',
  'Hero',
  'Morse',
  'Ping',
  'Pop',
  'Purr',
  'Sosumi',
  'Submarine',
  'Tink',
] as const satisfies readonly string[];
export interface AlertSettings {
  version: 1;
  message: boolean;
  sound: boolean;
  soundName: string;
}
const key = 'language-assistant:alerts:v1';
const defaults = (): AlertSettings => ({
  version: 1,
  message: true,
  sound: true,
  soundName: 'Glass',
});
function validated(value: unknown): AlertSettings {
  if (!value || typeof value !== 'object' || (value as AlertSettings).version !== 1)
    return defaults();
  const v = value as Partial<AlertSettings>;
  return {
    version: 1,
    message: v.message !== false,
    sound: v.sound !== false,
    soundName: (ALERT_SOUNDS as readonly string[]).includes(v.soundName as string)
      ? (v.soundName as string)
      : 'Glass',
  };
}
export function readAlertSettings(storage?: Storage): AlertSettings {
  try {
    return validated(JSON.parse((storage ?? globalThis.localStorage)?.getItem(key) ?? 'null'));
  } catch {
    return defaults();
  }
}
export function writeAlertSettings(value: AlertSettings, storage?: Storage): void {
  try {
    (storage ?? globalThis.localStorage)?.setItem(key, JSON.stringify(validated(value)));
  } catch {
    /* In-memory settings remain usable. */
  }
}
let current: AlertSettings | undefined;
const listeners = new Set<(value: AlertSettings) => void>();
export function useAlertSettings(): [
  AlertSettings,
  (update: (s: AlertSettings) => AlertSettings) => void,
] {
  const [value, setValue] = useState(() => current ?? (current = readAlertSettings()));
  useEffect(() => {
    listeners.add(setValue);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return [
    value,
    (update) => {
      current = validated(update(current ?? value));
      writeAlertSettings(current);
      for (const listener of listeners) listener(current);
    },
  ];
}

export interface AlertEvent {
  key: string;
  sessionId: string;
  kind: 'reply' | 'approval';
}
export interface AlertTracker {
  seeded: boolean;
  known: ReadonlySet<string>;
  lastSequence: ReadonlyMap<string, number>;
  approving: ReadonlySet<string>;
  onsets: ReadonlyMap<string, number>;
}
export const emptyTracker: AlertTracker = {
  seeded: false,
  known: new Set(),
  lastSequence: new Map(),
  approving: new Set(),
  onsets: new Map(),
};
/** New replies and approval onsets since the previous snapshot. The first snapshot and sessions first seen in this one only seed state; the selected session is suppressed while the window is focused, but its state still advances so it never alerts later. */
export function diffAlerts(
  tracker: AlertTracker,
  entries: readonly CatalogEntry[],
  context: { focused: boolean; selectedId: string },
): { events: AlertEvent[]; tracker: AlertTracker } {
  const known = new Set(tracker.known),
    lastSequence = new Map(tracker.lastSequence),
    approving = new Set<string>(),
    onsets = new Map(tracker.onsets);
  const events: AlertEvent[] = [];
  for (const entry of entries) {
    const id = entry.sessionId;
    if (!id) continue;
    const fresh = !tracker.seeded || !tracker.known.has(id);
    known.add(id);
    const quiet = fresh || !entry.open || (context.focused && id === context.selectedId);
    const sequence = entry.latestResponseSequence,
      previous = tracker.lastSequence.get(id);
    if (sequence !== undefined) {
      if (
        entry.attention === 'response' &&
        (previous === undefined || sequence > previous) &&
        !quiet
      )
        events.push({ key: `${id}:r:${sequence}`, sessionId: id, kind: 'reply' });
      if (previous === undefined || sequence > previous) lastSequence.set(id, sequence);
    }
    if (entry.attention === 'approval') {
      approving.add(id);
      if (!tracker.approving.has(id)) {
        const n = (onsets.get(id) ?? 0) + 1;
        onsets.set(id, n);
        if (!quiet) events.push({ key: `${id}:a:${n}`, sessionId: id, kind: 'approval' });
      }
    }
  }
  return { events, tracker: { seeded: true, known, lastSequence, approving, onsets } };
}
