import { useEffect, useRef, useState } from 'react';
import { PopupMenu } from './popup-menu.js';
import type { CatalogEntry } from '../core/session-catalog.js';
import { activityLabel, agentName, sessionIdentity, sessionTitle, type FolderNode } from './session-navigation.js';

// A launch still waiting for its panel has no session to select yet.
const launchPending = (entry: CatalogEntry) => !entry.sessionId && (entry.launchState === 'starting' || entry.launchState === 'unidentified');
const tabTitle = (entry: CatalogEntry) => launchPending(entry) ? (entry.launchState === 'starting' ? 'Starting…' : entry.reason ?? 'Started, not connected') : sessionTitle(entry);
const dotClass = (entry: CatalogEntry) => entry.activity === 'approval-required' ? 'approval' : entry.activity;
export function ActivityDot({ entry }: { entry: CatalogEntry }) {
 const label = activityLabel(entry);
 return <span className={'activity-dot ' + dotClass(entry)} role="img" aria-label={label} title={label} />;
}
export function SessionTabs({ folder, selectedId, onSelect, onNewSession, onEnd, onShowTerminal, onRetry, onRemove }: { folder: FolderNode | undefined; selectedId: string; onSelect(id: string): void; onNewSession?(): void; onEnd?(launchId: string): void; onShowTerminal?(launchId: string, title: string): void; onRetry?(launchId: string): void; onRemove?(entries: CatalogEntry[]): void }) {
 const list = useRef<HTMLDivElement>(null);
 const root = useRef<HTMLDivElement>(null);
 const [menu, setMenu] = useState<{ key: string; launchId: string; pending: boolean; title: string; x: number; y: number } | null>(null);
 const [savedMenu, setSavedMenu] = useState<{ entry: CatalogEntry; x: number; y: number } | null>(null);
 // A placeholder row has no session to select, so its terminal and retry live in the tab's context menu.
 const hasMenu = (entry: CatalogEntry) => !!entry.launchId && (!!onEnd || (launchPending(entry) && !!(onShowTerminal || onRetry)));
 const tabFor = (key: string) => root.current?.querySelector<HTMLElement>(`[data-session-key=${JSON.stringify(key)}]`);
 const openSavedMenu = (entry: CatalogEntry, anchor: { x: number; y: number }) => { if (!onRemove || !entry.sessionId) return; const box = root.current?.getBoundingClientRect(); setSavedMenu({ entry, x: anchor.x - (box?.left ?? 0), y: anchor.y - (box?.top ?? 0) }); };
 const openMenu = (entry: CatalogEntry, anchor: { x: number; y: number } | undefined, tab: HTMLElement) => { if (!entry.launchId || !hasMenu(entry)) return; const box = tab.parentElement?.parentElement?.getBoundingClientRect(); const at = tab.getBoundingClientRect(); setMenu({ key: entry.key, launchId: entry.launchId, pending: launchPending(entry), title: entry.sessionTitle ?? agentName(entry), x: (anchor?.x ?? at.left) - (box?.left ?? 0), y: (anchor?.y ?? at.bottom) - (box?.top ?? 0) }); };
 const open = folder?.open ?? []; const saved = folder?.saved ?? [];
 const [focusKey, setFocusKey] = useState<string | undefined>();
 const current = open.find(e => e.sessionId === selectedId)?.key ?? open[0]?.key;
 const tabbable = focusKey !== undefined && open.some(e => e.key === focusKey) ? focusKey : current;
 useEffect(() => { setFocusKey(undefined); }, [selectedId, folder?.key]);
 useEffect(() => { setMenu(null); setSavedMenu(null); }, [folder?.key]);
 useEffect(() => { if (menu && !open.some(e => e.key === menu.key && e.launchId === menu.launchId)) setMenu(null); }, [menu, open]);
 useEffect(() => { list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [selectedId, folder?.key]);
 const move = (from: number, delta: number) => { const next = open[(from + delta + open.length) % open.length]; if (!next) return; setFocusKey(next.key); list.current?.querySelector<HTMLElement>(`[data-session-key=${JSON.stringify(next.key)}]`)?.focus(); };
 const newButton = onNewSession && <button type="button" className="session-new" aria-label="New session" onClick={onNewSession}>+</button>;
 if (!folder) return <div className="session-tabs empty" dir="ltr">{newButton}</div>;
 return <div ref={root} className="session-tabs" dir="ltr">
  <div ref={list} role="tablist" aria-label={`Sessions in ${folder.name}`} className="session-tab-list">
   {open.map((entry, index) => { const selected = entry.sessionId === selectedId; const unselectable = !entry.sessionId || entry.availability === 'unavailable';
    return <button key={entry.key} role="tab" className={'session-tab' + (selected ? ' selected' : '')} aria-selected={selected} aria-disabled={unselectable || undefined} tabIndex={tabbable === entry.key ? 0 : -1} data-session-key={entry.key} data-session-id={entry.sessionId} title={sessionIdentity(entry)} aria-description={sessionIdentity(entry)}
     onFocus={() => setFocusKey(entry.key)}
     onContextMenu={e => { if (!hasMenu(entry)) return; e.preventDefault(); openMenu(entry, { x: e.clientX, y: e.clientY }, e.currentTarget); }}
     onClick={() => { if (!unselectable && entry.sessionId) onSelect(entry.sessionId); }}
     onKeyDown={e => { if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { if (hasMenu(entry)) { e.preventDefault(); openMenu(entry, undefined, e.currentTarget); } } else if (e.key === 'ArrowRight') { e.preventDefault(); move(index, 1); } else if (e.key === 'ArrowLeft') { e.preventDefault(); move(index, -1); } }}>
     <span className="session-tab-agent" role="img" aria-label={agentName(entry)}>{entry.target.agent === 'claude' ? '✳' : '◎'}</span>
     <span className="session-tab-title">{tabTitle(entry)}</span><ActivityDot entry={entry} />
    </button>; })}
  </div>
  {newButton}
  {menu && <div className="session-context" style={{ left: menu.x, top: menu.y }}><PopupMenu controlled={{ open: true, onOpenChange: v => { if (!v) setMenu(null); }, restoreFocus: () => { const key = menu.key; setMenu(null); tabFor(key)?.focus(); } }} label="Session actions" menuClassName="session-saved-menu session-context-menu" menuLabel="Session actions" items={[
   ...(menu.pending && onShowTerminal ? [{ key: 'terminal', content: 'Show terminal', onChoose: () => onShowTerminal(menu.launchId, menu.title) }] : []),
   ...(menu.pending && onRetry ? [{ key: 'retry', content: 'Retry connection', onChoose: () => onRetry(menu.launchId) }] : []),
   ...(onEnd ? [{ key: 'end', content: 'End session…', onChoose: () => onEnd(menu.launchId) }] : [])]} /></div>}
  {savedMenu && <div className="session-context" style={{ left: savedMenu.x, top: savedMenu.y }}><PopupMenu controlled={{ open: true, onOpenChange: v => { if (!v) setSavedMenu(null); }, restoreFocus: () => { const key = savedMenu.entry.key; setSavedMenu(null); (tabFor(key) ?? root.current?.querySelector<HTMLElement>('.session-saved > button'))?.focus(); } }} label="Session actions" menuClassName="session-saved-menu session-context-menu" menuLabel="Session actions" items={[
   { key: 'remove', content: 'Remove from history…', onChoose: () => onRemove?.([savedMenu.entry]) }]} /></div>}
  {!open.some(e => (e.sessionId && e.availability !== 'unavailable') || launchPending(e)) && <p className="session-tabs-empty">No open sessions in this folder.</p>}
  {saved.length > 0 && <PopupMenu className="session-saved" menuClassName="session-saved-menu" resetKey={folder.key} label={<>Saved sessions ({saved.length})</>} description={saved.some(e => e.sessionId && e.sessionId === selectedId) ? '(current session inside)' : undefined}
   items={saved.map(entry => ({ key: entry.key, disabled: !entry.sessionId, current: !!entry.sessionId && entry.sessionId === selectedId, data: { sessionKey: entry.key, sessionId: entry.sessionId }, content: <>{sessionTitle(entry)} <ActivityDot entry={entry} /></>, onChoose: () => { if (entry.sessionId) onSelect(entry.sessionId); }, ...(onRemove && entry.sessionId ? { onContext: (anchor: { x: number; y: number }) => openSavedMenu(entry, anchor) } : {}) }))} />}
 </div>;
}
