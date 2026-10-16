import { useEffect, useId, useState } from 'react';
import type { CatalogEntry } from '../core/session-catalog.js';
import type { LaunchRecord } from '../runtime/session-launcher.js';
import type { TerminalView } from '../core/session-contracts.js';
import { sessionRequest } from './session-client.js';
import {
  defaultLaunchSettings,
  formatArgs,
  type LaunchSettings,
  type PopupMode,
} from '../core/launch-settings.js';
export type { LaunchSettings, PopupMode } from '../core/launch-settings.js';

export type { TerminalView } from '../core/session-contracts.js';

/** The editable form: extra arguments are plain text; the server splits them with its one quoting rule. */
export interface LaunchSettingsInput {
  extraArgs: { claude: string; codex: string };
  popup: PopupMode;
  terminalView: TerminalView;
}
export const readLaunchSettings = () => sessionRequest<LaunchSettings>('/api/settings/launch');
export const writeLaunchSettings = (s: LaunchSettingsInput) =>
  sessionRequest<LaunchSettings>('/api/settings/launch', {
    method: 'PUT',
    body: JSON.stringify(s),
  });
export const terminalTicket = (launchId: string) =>
  sessionRequest<{ ticket: string; expiresAt: number }>(
    `/api/launches/${encodeURIComponent(launchId)}/terminal-ticket`,
    { method: 'POST', body: '{}' },
  );
export const listLaunches = () => sessionRequest<LaunchRecord[]>('/api/launches');
export const retryLaunch = (launchId: string) =>
  sessionRequest<Record<string, never>>(`/api/launches/${encodeURIComponent(launchId)}/identify`, {
    method: 'POST',
    body: '{}',
  });
export interface RunResult {
  launch: { id: string; title?: string; folder: string };
  reused: boolean;
  typed: boolean;
}
export const runCommand = (folder: string, command: string, originSessionId?: string) =>
  sessionRequest<RunResult>('/api/launches/run', {
    method: 'POST',
    body: JSON.stringify({ folder, command, ...(originSessionId ? { originSessionId } : {}) }),
  });
export const terminalTitle = (t: { title: string; projectName: string; folder: string }) =>
  `${t.title} · ${t.projectName} / ${t.folder.split('/').filter(Boolean).at(-1) ?? t.folder}`;
export const endLaunch = (launchId: string) =>
  sessionRequest<Record<string, never>>(`/api/launches/${encodeURIComponent(launchId)}/end`, {
    method: 'POST',
    body: '{}',
  });

/** Frames stay far below the server's 64 KiB cap even after JSON escaping (worst case 6 bytes per UTF-16 unit). */
export const MAX_INPUT_CHUNK = 8 * 1024;
export function chunkInput(data: string, max = MAX_INPUT_CHUNK): string[] {
  const out: string[] = [];
  for (let i = 0; i < data.length;) {
    let end = Math.min(i + max, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
    out.push(data.slice(i, end));
    i = end;
  }
  return out;
}

/** One last-keystroke time for the whole page, so every auto-open path honors the same typing delay.
 * It starts at page load: nothing pops up in the first two seconds, before the user could have started typing. */
let lastKeystroke = Date.now();
export const noteKeystroke = (at = Date.now()) => {
  lastKeystroke = at;
};
export const lastKeystrokeAt = () => lastKeystroke;
/** Records every keydown on the page (capture phase, before any handler can stop it). Mount once, at the app root. */
export function useKeystrokeTracker() {
  useEffect(() => {
    const k = () => noteKeystroke();
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);
}

/** Auto-open waits this long after the last keystroke so it never interrupts typing. */
const AUTO_OPEN_TYPING_DELAY_MS = 2000;
const AUTO_OPEN_POLL_MS = 500;
export function shouldAutoOpen(
  entry: CatalogEntry | undefined,
  selectedId: string,
  popup: PopupMode,
  lastKeystrokeAt: number,
  now: number,
) {
  if (!entry?.launchId || entry.activity !== 'approval-required' || popup === 'dot-only')
    return false;
  if (entry.sessionId !== selectedId) return false; // 'auto' and 'current-tab' only ever open the shown session
  return now - lastKeystrokeAt >= AUTO_OPEN_TYPING_DELAY_MS;
}
type AutoOpenRule = typeof shouldAutoOpen;
/** Polls `rule` while `entry` waits for approval and calls `open` once per launch and activity. */
function useAutoOpen(
  entry: CatalogEntry | undefined,
  selectedId: string,
  popup: PopupMode,
  lastKeystrokeAt: () => number,
  rule: AutoOpenRule,
  open: (entry: CatalogEntry) => void,
) {
  const [handled, setHandled] = useState('');
  useEffect(() => {
    const key = `${entry?.launchId}:${entry?.activity}`;
    if (handled === key || !entry?.launchId || entry.activity !== 'approval-required') return;
    const tick = () => {
      if (rule(entry, selectedId, popup, lastKeystrokeAt(), Date.now())) {
        setHandled(key);
        open(entry);
      }
    };
    tick();
    const timer = setInterval(tick, AUTO_OPEN_POLL_MS);
    return () => clearInterval(timer);
  }, [entry?.launchId, entry?.activity, entry?.sessionId, selectedId, popup, handled]);
  useEffect(() => {
    if (entry?.activity !== 'approval-required') setHandled('');
  }, [entry?.activity]);
}
export function useAutoOpenTerminal(
  entry: CatalogEntry | undefined,
  selectedId: string,
  popup: PopupMode,
  lastKeystrokeAt: () => number,
  open: () => void,
) {
  useAutoOpen(entry, selectedId, popup, lastKeystrokeAt, shouldAutoOpen, () => open());
}

/** A launch the user just started and is waiting on: opens even before it is identified, until its session is the shown one. */
export function shouldAutoOpenLaunch(
  entry: CatalogEntry | undefined,
  selectedId: string,
  popup: PopupMode,
  lastKeystrokeAt: number,
  now: number,
) {
  if (!entry?.launchId || entry.activity !== 'approval-required' || popup === 'dot-only')
    return false;
  if (entry.sessionId && entry.sessionId === selectedId) return false; // the per-session auto-open owns it
  return now - lastKeystrokeAt >= AUTO_OPEN_TYPING_DELAY_MS;
}
export function useAutoOpenWaitingLaunch(
  entry: CatalogEntry | undefined,
  selectedId: string,
  popup: PopupMode,
  lastKeystrokeAt: () => number,
  open: (entry: CatalogEntry) => void,
) {
  useAutoOpen(entry, selectedId, popup, lastKeystrokeAt, shouldAutoOpenLaunch, open);
}

// One shared copy so the dialog's save reaches the open workspace at once.
let current: LaunchSettings | undefined;
const listeners = new Set<() => void>();
const publish = (value: LaunchSettings) => {
  current = value;
  listeners.forEach((l) => l());
};
/** Subscribes to the shared settings copy and triggers the first read; undefined until it arrives. */
function useLaunchSettings(): LaunchSettings | undefined {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((v) => v + 1);
    listeners.add(l);
    if (!current) void readLaunchSettings().then(publish, () => {});
    return () => {
      listeners.delete(l);
    };
  }, []);
  return current;
}
/** Popup behavior for the session view; defaults to 'auto' when the settings cannot be read. */
export const usePopupMode = (): PopupMode =>
  useLaunchSettings()?.popup ?? defaultLaunchSettings().popup;
/** How terminal tabs open; 'popup' until the settings are read. */
export const useTerminalView = (): TerminalView =>
  useLaunchSettings()?.terminalView ?? defaultLaunchSettings().terminalView;
/** Expand and Shrink save only the view; every other launch setting is sent back unchanged. Rejects when the settings cannot be read or written, so callers must catch. */
export async function saveTerminalView(view: TerminalView) {
  const base = current ?? (await readLaunchSettings());
  const saved = await writeLaunchSettings({ ...toInput(base), terminalView: view });
  publish(saved);
}
export const saveLaunchSettings = async (input: LaunchSettingsInput) => {
  const saved = await writeLaunchSettings(input);
  publish(saved);
  return saved;
};

export const toInput = (s: LaunchSettings): LaunchSettingsInput => ({
  popup: s.popup,
  terminalView: s.terminalView,
  extraArgs: { claude: formatArgs(s.extraArgs.claude), codex: formatArgs(s.extraArgs.codex) },
});

export function LaunchSettingsFields({
  value,
  onChange,
}: {
  value: LaunchSettingsInput;
  onChange(next: LaunchSettingsInput): void;
}) {
  const id = useId();
  return (
    <section className="launch-settings" aria-labelledby={id + 'h'}>
      <h3 id={id + 'h'}>Sessions</h3>
      <div className="language-field">
        <label htmlFor={id + 'popup'}>When a session needs approval</label>
        <select
          id={id + 'popup'}
          value={value.popup}
          onChange={(e) => onChange({ ...value, popup: e.target.value as PopupMode })}
        >
          <option value="auto">Open the terminal automatically</option>
          <option value="current-tab">Only on the current tab</option>
          <option value="dot-only">Only show the red dot</option>
        </select>
        <small>Applies to sessions started from Gloss</small>
      </div>
      <div className="language-field">
        <label htmlFor={id + 'view'}>Terminal tabs open as</label>
        <select
          id={id + 'view'}
          value={value.terminalView}
          onChange={(e) => onChange({ ...value, terminalView: e.target.value as TerminalView })}
        >
          <option value="popup">Popup over the conversation</option>
          <option value="workspace">Full workspace</option>
        </select>
        <small>
          Run and terminal tabs use this view. Expand and Shrink in the terminal update it.
        </small>
      </div>
      {(['claude', 'codex'] as const).map((agent) => (
        <div className="language-field" key={agent}>
          <label htmlFor={id + agent}>
            Extra {agent === 'claude' ? 'Claude' : 'Codex'} launch arguments
          </label>
          <input
            id={id + agent}
            type="text"
            dir="ltr"
            value={value.extraArgs[agent]}
            placeholder={agent === 'claude' ? '--model opus' : '--model gpt-5'}
            onChange={(e) =>
              onChange({ ...value, extraArgs: { ...value.extraArgs, [agent]: e.target.value } })
            }
          />
        </div>
      ))}
    </section>
  );
}
