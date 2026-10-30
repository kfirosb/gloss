import { useEffect, useState } from 'react';
import type { CatalogEntry } from '../core/session-catalog.js';
import { hostPlatform, type HostPlatform } from './host-platform.js';
import { readMigratedKey } from './display-preferences.js';

/** The macOS system sounds; the desktop shell plays only these (see desktop/attention-alert.mjs). */
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
/** The freedesktop sound theme names the Linux shell plays; kept equal to the desktop module's list by a test. */
export const FREEDESKTOP_ALERT_SOUNDS = [
  'bell',
  'complete',
  'message',
  'dialog-information',
  'dialog-warning',
  'window-attention',
  'service-login',
] as const satisfies readonly string[];
export const alertSoundsFor = (platform: HostPlatform): readonly string[] =>
  platform === 'darwin' ? ALERT_SOUNDS : FREEDESKTOP_ALERT_SOUNDS;
export const defaultSoundName = (platform: HostPlatform) =>
  platform === 'darwin' ? 'Glass' : 'message';
export interface AlertSettings {
  version: 1;
  message: boolean;
  sound: boolean;
  soundName: string;
}
const key = 'gloss:alerts:v1';
const legacyKey = 'language-assistant:alerts:v1';
const defaults = (platform: HostPlatform): AlertSettings => ({
  version: 1,
  message: true,
  sound: true,
  soundName: defaultSoundName(platform),
});
function validated(value: unknown, platform: HostPlatform): AlertSettings {
  if (!value || typeof value !== 'object' || (value as AlertSettings).version !== 1)
    return defaults(platform);
  const v = value as Partial<AlertSettings>;
  return {
    version: 1,
    message: v.message !== false,
    sound: v.sound !== false,
    soundName: alertSoundsFor(platform).includes(v.soundName as string)
      ? (v.soundName as string)
      : defaultSoundName(platform),
  };
}
export function readAlertSettings(
  storage?: Storage,
  platform: HostPlatform = hostPlatform(),
): AlertSettings {
  try {
    const target = storage ?? globalThis.localStorage;
    return validated(
      JSON.parse((target && readMigratedKey(target, key, legacyKey)) ?? 'null'),
      platform,
    );
  } catch {
    return defaults(platform);
  }
}
export function writeAlertSettings(
  value: AlertSettings,
  storage?: Storage,
  platform: HostPlatform = hostPlatform(),
): void {
  try {
    (storage ?? globalThis.localStorage)?.setItem(key, JSON.stringify(validated(value, platform)));
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
      current = validated(update(current ?? value), hostPlatform());
      writeAlertSettings(current);
      for (const listener of listeners) listener(current);
    },
  ];
}

export interface AlertEvent {
  key: string;
  sessionId: string;
  kind: 'reply' | 'approval' | 'question';
}
export interface AlertTracker {
  seeded: boolean;
  known: ReadonlySet<string>;
  lastSequence: ReadonlyMap<string, number>;
  approving: ReadonlySet<string>;
  /** Sessions whose terminal was waiting on a question in the previous snapshot. */
  asking: ReadonlySet<string>;
  /** Onset counts per `<sessionId>:<a|q>`, so every onset key is unique. */
  onsets: ReadonlyMap<string, number>;
}
export const emptyTracker: AlertTracker = {
  seeded: false,
  known: new Set(),
  lastSequence: new Map(),
  approving: new Set(),
  asking: new Set(),
  onsets: new Map(),
};
/** New replies, approval onsets and question onsets since the previous snapshot. The first snapshot and sessions first seen in this one only seed state; the selected session is suppressed while the window is focused, but its state still advances so it never alerts later. */
export function diffAlerts(
  tracker: AlertTracker,
  entries: readonly CatalogEntry[],
  context: { focused: boolean; selectedId: string },
): { events: AlertEvent[]; tracker: AlertTracker } {
  const known = new Set(tracker.known),
    lastSequence = new Map(tracker.lastSequence),
    approving = new Set<string>(),
    asking = new Set<string>(),
    onsets = new Map(tracker.onsets);
  const events: AlertEvent[] = [];
  // A terminal-blocking state alerts once when it begins, never while it lasts.
  const onset = (
    id: string,
    kind: 'approval' | 'question',
    now: Set<string>,
    before: ReadonlySet<string>,
    quiet: boolean,
  ) => {
    now.add(id);
    if (before.has(id)) return;
    const counter = `${id}:${kind === 'approval' ? 'a' : 'q'}`;
    const n = (onsets.get(counter) ?? 0) + 1;
    onsets.set(counter, n);
    if (!quiet) events.push({ key: `${counter}:${n}`, sessionId: id, kind });
  };
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
    if (entry.attention === 'approval') onset(id, 'approval', approving, tracker.approving, quiet);
    if (entry.attention === 'question') onset(id, 'question', asking, tracker.asking, quiet);
  }
  return { events, tracker: { seeded: true, known, lastSequence, approving, asking, onsets } };
}
