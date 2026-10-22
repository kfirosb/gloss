import { useEffect, useState } from 'react';
import { clampLayoutSize } from '../core/session-contracts.js';
import { LIVE_VIEWS, type ConversationView, type LiveView } from './live-view.js';
import { filesWindowGeometry, type FilesWindowGeometry } from './files-window-geometry.js';
import { clampSidebarWidth } from './sidebar-frame.js';
export type AssistantMode = 'full' | 'compact';
export type Theme = 'light' | 'dark' | 'auto';
export type DarkStyle = 'graphite' | 'dimmed' | 'midnight';
/** Which edge of the workspace the docked Files column sits on. */
export type FilesSide = 'left' | 'right';
export const DARK_STYLES: { value: DarkStyle; label: string }[] = [
  { value: 'graphite', label: 'Graphite' },
  { value: 'dimmed', label: 'Dimmed slate' },
  { value: 'midnight', label: 'Midnight' },
];
export interface LiveLayout {
  view: LiveView;
  conversation: ConversationView;
  split: number;
}
export const DEFAULT_LIVE_LAYOUT: LiveLayout = {
  view: 'translated',
  conversation: 'translated',
  split: 50,
};
export interface DisplayPreferences {
  version: 1;
  collapsed: boolean;
  assistantModes: Record<string, AssistantMode>;
  liveViews: Record<string, LiveLayout>;
  lastByFolder: Record<string, string>;
  tabOrder: Record<string, string[]>;
  sidebarWidth: number;
  theme: Theme;
  darkStyle: DarkStyle;
  filesSide: FilesSide;
  /** "Don't ask again" for Move to Gloss (spec 5.2) on this device: the user's click is then the confirmation. */
  moveWithoutConfirmation: boolean;
  filesWindow?: FilesWindowGeometry;
}
const maxFolders = 500;
const key = 'gloss:display:v1';
const legacyKey = 'language-assistant:display:v1';
/** Reads `key`; a value still stored under the pre-rename `legacyKey` is copied to `key` once and the legacy key is removed. */
export function readMigratedKey(storage: Storage, key: string, legacyKey: string): string | null {
  const current = storage.getItem(key);
  const legacy = storage.getItem(legacyKey);
  if (legacy === null) return current;
  if (current === null) storage.setItem(key, legacy);
  storage.removeItem(legacyKey);
  return current ?? legacy;
}
const defaults = (): DisplayPreferences => ({
  version: 1,
  collapsed: false,
  assistantModes: {},
  liveViews: {},
  lastByFolder: {},
  tabOrder: {},
  sidebarWidth: 300,
  theme: 'dark',
  darkStyle: 'graphite',
  filesSide: 'left',
  moveWithoutConfirmation: false,
});
const clampWidth = (w: unknown) =>
  typeof w === 'number' && Number.isFinite(w) ? clampSidebarWidth(w) : defaults().sidebarWidth;
const objectOf = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function liveLayout(value: unknown): LiveLayout | undefined {
  const l = objectOf(value);
  const { view, conversation, split } = l;
  if (!LIVE_VIEWS.includes(view as LiveView)) return undefined;
  if (conversation !== 'translated' && conversation !== 'original') return undefined;
  if (typeof split !== 'number' || !Number.isFinite(split)) return undefined;
  return { view: view as LiveView, conversation, split: clampLayoutSize(split) };
}
function validated(value: unknown): DisplayPreferences {
  if (!value || typeof value !== 'object' || (value as DisplayPreferences).version !== 1)
    return defaults();
  const v = value as Partial<DisplayPreferences>;
  const theme = v.theme === 'light' || v.theme === 'dark' || v.theme === 'auto' ? v.theme : 'dark';
  const darkStyle = DARK_STYLES.find((s) => s.value === v.darkStyle)?.value ?? 'graphite';
  const filesWindow = filesWindowGeometry(v.filesWindow);
  return {
    version: 1,
    collapsed: v.collapsed === true,
    sidebarWidth: clampWidth(v.sidebarWidth),
    theme,
    darkStyle,
    filesSide: v.filesSide === 'right' ? 'right' : 'left',
    moveWithoutConfirmation: v.moveWithoutConfirmation === true,
    assistantModes: Object.fromEntries(
      Object.entries(objectOf(v.assistantModes)).filter(
        ([, mode]) => mode === 'full' || mode === 'compact',
      ),
    ) as Record<string, AssistantMode>,
    liveViews: Object.fromEntries(
      Object.entries(objectOf(v.liveViews))
        .map(([id, layout]) => [id, liveLayout(layout)] as const)
        .filter((entry): entry is [string, LiveLayout] => entry[1] !== undefined)
        .slice(-maxFolders),
    ),
    lastByFolder: Object.fromEntries(
      Object.entries(objectOf(v.lastByFolder)).filter(([, id]) => typeof id === 'string'),
    ) as Record<string, string>,
    tabOrder: Object.fromEntries(
      Object.entries(objectOf(v.tabOrder))
        .filter(([, keys]) => Array.isArray(keys) && keys.every((k) => typeof k === 'string'))
        .map(([k, keys]) => [k, keys as string[]])
        .slice(-maxFolders),
    ),
    ...(filesWindow && { filesWindow }),
  };
}
export function readDisplayPreferences(storage?: Storage): DisplayPreferences {
  try {
    const target = storage ?? globalThis.localStorage;
    return validated(JSON.parse((target && readMigratedKey(target, key, legacyKey)) ?? 'null'));
  } catch {
    return defaults();
  }
}
export function writeDisplayPreferences(value: DisplayPreferences, storage?: Storage): void {
  try {
    (storage ?? globalThis.localStorage)?.setItem(key, JSON.stringify(validated(value)));
  } catch {
    /* In-memory controls remain usable. */
  }
}
// Stylesheet colors are light-dark() pairs picked by a color-scheme declared per data-theme in styles.css; the dark half
// reads the data-dark-style palette from dark-styles.css. Both must stay in CSS: the build's minifier rewrites
// light-dark() into variables that only CSS color-scheme declarations set.
export function applyTheme(
  { theme, darkStyle }: Pick<DisplayPreferences, 'theme' | 'darkStyle'>,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset.theme = theme;
  root.dataset.darkStyle = darkStyle;
}
let current: DisplayPreferences | undefined;
const listeners = new Set<(value: DisplayPreferences) => void>();
export function useDisplayPreferences(): [
  DisplayPreferences,
  (update: (current: DisplayPreferences) => DisplayPreferences) => void,
] {
  const [value, setValue] = useState(() => current ?? (current = readDisplayPreferences()));
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
      writeDisplayPreferences(current);
      for (const listener of listeners) listener(current);
    },
  ];
}
// Drops order/last-selection state for tabs and folders that no longer exist; present keys are never dropped.
export function pruneDisplayPreferences(
  prefs: DisplayPreferences,
  present: Record<string, { keys: string[]; ids: string[] }>,
): DisplayPreferences {
  const tabOrder = Object.fromEntries(
    Object.entries(prefs.tabOrder)
      .filter(([f]) => present[f])
      .map(([f, keys]) => [f, keys.filter((k) => present[f]!.keys.includes(k))]),
  );
  const lastByFolder = Object.fromEntries(
    Object.entries(prefs.lastByFolder).filter(([f, id]) => present[f]?.ids.includes(id)),
  );
  const same = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);
  return same(tabOrder, prefs.tabOrder) && same(lastByFolder, prefs.lastByFolder)
    ? prefs
    : { ...prefs, tabOrder, lastByFolder };
}
