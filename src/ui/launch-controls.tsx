import { useEffect, useId, useState } from 'react';
import type { CatalogEntry } from '../core/session-catalog.js';
import type { TerminalView } from '../core/session-contracts.js';
import { sessionRequest } from './session-client.js';

export type { TerminalView } from '../core/session-contracts.js';

export type PopupMode = 'auto' | 'current-tab' | 'dot-only';
export interface LaunchSettings { extraArgs: { claude: string[]; codex: string[] }; popup: PopupMode; terminalView: TerminalView }
/** The editable form: extra arguments are plain text; the server splits them with its one quoting rule. */
export interface LaunchSettingsInput { extraArgs: { claude: string; codex: string }; popup: PopupMode; terminalView: TerminalView }
export const readLaunchSettings = () => sessionRequest<LaunchSettings>('/api/settings/launch');
export const writeLaunchSettings = (s: LaunchSettingsInput) => sessionRequest<LaunchSettings>('/api/settings/launch', { method: 'PUT', body: JSON.stringify(s) });
export const terminalTicket = (launchId: string) => sessionRequest<{ ticket: string; expiresAt: number }>(`/api/launches/${encodeURIComponent(launchId)}/terminal-ticket`, { method: 'POST', body: '{}' });
export const listLaunches = () => sessionRequest<unknown[]>('/api/launches');
export const retryLaunch = (launchId: string) => sessionRequest<unknown>(`/api/launches/${encodeURIComponent(launchId)}/identify`, { method: 'POST', body: '{}' });
export interface RunResult { launch: { id: string; title?: string; folder: string }; reused: boolean; typed: boolean }
export const runCommand = (folder: string, command: string, originSessionId?: string) => sessionRequest<RunResult>('/api/launches/run', { method: 'POST', body: JSON.stringify({ folder, command, ...(originSessionId ? { originSessionId } : {}) }) });
export const terminalTitle = (t: { title: string; projectName: string; folder: string }) => `${t.title} · ${t.projectName} / ${t.folder.split('/').filter(Boolean).at(-1) ?? t.folder}`;
export const endLaunch = (launchId: string) => sessionRequest<unknown>(`/api/launches/${encodeURIComponent(launchId)}/end`, { method: 'POST', body: '{}' });

/** Frames stay far below the server's 64 KiB cap even after JSON escaping (worst case 6 bytes per UTF-16 unit). */
export const MAX_INPUT_CHUNK = 8 * 1024;
export function chunkInput(data: string, max = MAX_INPUT_CHUNK): string[] {
  const out: string[] = [];
  for (let i = 0; i < data.length;) {
    let end = Math.min(i + max, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
    out.push(data.slice(i, end)); i = end;
  }
  return out;
}

/** One last-keystroke time for the whole page, so every auto-open path honors the same typing delay.
 * It starts at page load: nothing pops up in the first two seconds, before the user could have started typing. */
let lastKeystroke = Date.now();
export const noteKeystroke = (at = Date.now()) => { lastKeystroke = at; };
export const lastKeystrokeAt = () => lastKeystroke;
/** Records every keydown on the page (capture phase, before any handler can stop it). Mount once, at the app root. */
export function useKeystrokeTracker() {
  useEffect(() => { const k = () => noteKeystroke(); window.addEventListener('keydown', k, true); return () => window.removeEventListener('keydown', k, true); }, []);
}

export function shouldAutoOpen(entry: CatalogEntry | undefined, selectedId: string, popup: PopupMode, lastKeystrokeAt: number, now: number) {
  if (!entry?.launchId || entry.activity !== 'approval-required' || popup === 'dot-only') return false;
  if (entry.sessionId !== selectedId) return false; // 'auto' and 'current-tab' only ever open the shown session
  return now - lastKeystrokeAt >= 2000;
}
export function useAutoOpenTerminal(entry: CatalogEntry | undefined, selectedId: string, popup: PopupMode, lastKeystrokeAt: () => number, open: () => void) {
  const [handled, setHandled] = useState('');
  useEffect(() => {
    const key = `${entry?.launchId}:${entry?.activity}`;
    if (handled === key || !entry?.launchId || entry.activity !== 'approval-required') return;
    const tick = () => { if (shouldAutoOpen(entry, selectedId, popup, lastKeystrokeAt(), Date.now())) { setHandled(key); open(); } };
    tick(); const timer = setInterval(tick, 500); return () => clearInterval(timer);
  }, [entry?.launchId, entry?.activity, entry?.sessionId, selectedId, popup, handled]);
  useEffect(() => { if (entry?.activity !== 'approval-required') setHandled(''); }, [entry?.activity]);
}

/** A launch the user just started and is waiting on: opens even before it is identified, until its session is the shown one. */
export function shouldAutoOpenLaunch(entry: CatalogEntry | undefined, selectedId: string, popup: PopupMode, lastKeystrokeAt: number, now: number) {
  if (!entry?.launchId || entry.activity !== 'approval-required' || popup === 'dot-only') return false;
  if (entry.sessionId && entry.sessionId === selectedId) return false; // the per-session auto-open owns it
  return now - lastKeystrokeAt >= 2000;
}
export function useAutoOpenWaitingLaunch(entry: CatalogEntry | undefined, selectedId: string, popup: PopupMode, lastKeystrokeAt: () => number, open: (entry: CatalogEntry) => void) {
  const [handled, setHandled] = useState('');
  useEffect(() => {
    const key = `${entry?.launchId}:${entry?.activity}`;
    if (handled === key || !entry?.launchId || entry.activity !== 'approval-required') return;
    const tick = () => { if (shouldAutoOpenLaunch(entry, selectedId, popup, lastKeystrokeAt(), Date.now())) { setHandled(key); open(entry); } };
    tick(); const timer = setInterval(tick, 500); return () => clearInterval(timer);
  }, [entry?.launchId, entry?.activity, entry?.sessionId, selectedId, popup, handled]);
  useEffect(() => { if (entry?.activity !== 'approval-required') setHandled(''); }, [entry?.activity]);
}

// One shared copy so the dialog's save reaches the open workspace at once.
let current: LaunchSettings | undefined; const listeners = new Set<() => void>();
const publish = (value: LaunchSettings) => { current = value; listeners.forEach(l => l()); };
const DEFAULT_POPUP: PopupMode = 'auto';
/** Popup behavior for the session view; defaults to 'auto' when the settings cannot be read. */
export function usePopupMode(): PopupMode {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump(v => v + 1); listeners.add(l);
    if (!current) void readLaunchSettings().then(publish, () => {});
    return () => { listeners.delete(l); };
  }, []);
  return current?.popup ?? DEFAULT_POPUP;
}
const DEFAULT_TERMINAL_VIEW: TerminalView = 'popup';
/** How terminal tabs open; 'popup' until the settings are read. */
export function useTerminalView(): TerminalView {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump(v => v + 1); listeners.add(l);
    if (!current) void readLaunchSettings().then(publish, () => {});
    return () => { listeners.delete(l); };
  }, []);
  return current?.terminalView ?? DEFAULT_TERMINAL_VIEW;
}
/** Expand and Shrink save only the view; every other launch setting is sent back unchanged. */
export async function saveTerminalView(view: TerminalView) {
  const base = current ?? await readLaunchSettings();
  const saved = await writeLaunchSettings({ ...toInput(base), terminalView: view }); publish(saved);
}
export const saveLaunchSettings = async (input: LaunchSettingsInput) => { const saved = await writeLaunchSettings(input); publish(saved); return saved; };

const quote = (arg: string) => /[\s"']/.test(arg) ? (arg.includes('"') ? `'${arg}'` : `"${arg}"`) : arg;
export const toInput = (s: LaunchSettings): LaunchSettingsInput => ({ popup: s.popup, terminalView: s.terminalView, extraArgs: { claude: s.extraArgs.claude.map(quote).join(' '), codex: s.extraArgs.codex.map(quote).join(' ') } });

export function LaunchSettingsFields({ value, onChange }: { value: LaunchSettingsInput; onChange(next: LaunchSettingsInput): void }) {
  const id = useId();
  return <section className="launch-settings" aria-labelledby={id + 'h'}>
    <h3 id={id + 'h'}>Sessions</h3>
    <div className="language-field"><label htmlFor={id + 'popup'}>When a session needs approval</label>
      <select id={id + 'popup'} value={value.popup} onChange={e => onChange({ ...value, popup: e.target.value as PopupMode })}>
        <option value="auto">Open the terminal automatically</option><option value="current-tab">Only on the current tab</option><option value="dot-only">Only show the red dot</option>
      </select><small>Applies to sessions started from Gloss</small></div>
    {(['claude', 'codex'] as const).map(agent => <div className="language-field" key={agent}><label htmlFor={id + agent}>Extra {agent === 'claude' ? 'Claude' : 'Codex'} launch arguments</label>
      <input id={id + agent} type="text" dir="ltr" value={value.extraArgs[agent]} placeholder={agent === 'claude' ? '--model opus' : '--model gpt-5'} onChange={e => onChange({ ...value, extraArgs: { ...value.extraArgs, [agent]: e.target.value } })} /></div>)}
  </section>;
}
