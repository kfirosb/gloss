import { useEffect, useId, useState } from 'react';
import { PanelDialog } from './composer-dialogs.js';
import { sessionRequest } from './session-client.js';
import { LANGUAGE_FIELDS, SUPPORTED_LANGUAGES, languageName, type LanguageOverride, type LanguageSettings } from '../core/language-settings.js';

declare global { interface Window { languageAssistant?: { pickFolder(): Promise<string | null> } } }
const labels = { write: 'I write in', send: 'Send to the agent in', reply: 'Show agent replies in', assist: 'Language Assistant speaks' } as const;
type FolderOption = { key: string; name: string };

export function NewSessionDialog({ open, folders, defaultFolder, onClose, onLaunched }: { open: boolean; folders: FolderOption[]; defaultFolder?: string | undefined; onClose(): void; onLaunched(panelSessionId: string | undefined, launchId?: string): void }) {
  const id = useId(); const [agent, setAgent] = useState<'claude' | 'codex'>('claude'); const [folder, setFolder] = useState(defaultFolder ?? '');
  const [extraFolders, setExtraFolders] = useState<FolderOption[]>([]);
  const [defaults, setDefaults] = useState<LanguageSettings | null>(null); const [langs, setLangs] = useState<LanguageSettings | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return; let active = true; setError(''); setAgent('claude'); setFolder(defaultFolder ?? folders[0]?.key ?? '');
    sessionRequest<LanguageSettings>('/api/settings/language').then(d => { if (active) { setDefaults(d); setLangs(d); } }, () => { if (active) { setDefaults(null); setLangs(null); } });
    return () => { active = false; };
  }, [open]);
  const pick = async () => {
    setError('');
    try {
      const chosen = await window.languageAssistant?.pickFolder(); if (!chosen) return;
      const { folder: real } = await sessionRequest<{ folder: string }>('/api/launch-folders', { method: 'POST', body: JSON.stringify({ folder: chosen }) });
      setExtraFolders(v => v.some(f => f.key === real) ? v : [...v, { key: real, name: real.split('/').filter(Boolean).at(-1) ?? real }]); setFolder(real);
    } catch (e) { setError(e instanceof Error ? e.message : 'Folder unavailable'); }
  };
  const launch = async () => {
    setBusy(true); setError('');
    try {
      // Only fields that differ from the defaults travel; the server applies them to the new session.
      const languageOverride: LanguageOverride = defaults && langs ? Object.fromEntries(LANGUAGE_FIELDS.filter(f => langs[f] !== defaults[f]).map(f => [f, langs[f]])) : {};
      const record = await sessionRequest<{ id?: string; panelSessionId?: string }>('/api/launches', { method: 'POST', body: JSON.stringify({ agent, folder, ...(Object.keys(languageOverride).length ? { languageOverride } : {}) }) });
      onLaunched(record.panelSessionId, record.id); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not open session'); } finally { setBusy(false); }
  };
  const all = [...new Map([...folders, ...extraFolders].map(folder => [folder.key, folder])).values()];
  return <PanelDialog title="New session" open={open} close={onClose}><div className="review-body new-session" dir="ltr">
    <label htmlFor={id + 'folder'}>Folder</label>
    <div className="new-session-folder">{all.length > 0 && <select id={id + 'folder'} value={folder} onChange={e => setFolder(e.target.value)}>{all.map(f => <option key={f.key} value={f.key}>{f.name} — {f.key}</option>)}</select>}{window.languageAssistant && <button type="button" onClick={() => void pick()}>Choose…</button>}</div>
    {all.length === 0 && <p className="review-hint">{window.languageAssistant ? 'No project folders yet. Choose one to start.' : 'No project folders yet. Start Claude or Codex in a project from your terminal once, or choose a folder in the Language Assistant app.'}</p>}
    <fieldset><legend>Agent</legend><label><input type="radio" name={id + 'agent'} checked={agent === 'claude'} onChange={() => setAgent('claude')} /> Claude</label><label><input type="radio" name={id + 'agent'} checked={agent === 'codex'} onChange={() => setAgent('codex')} /> Codex</label></fieldset>
    {langs && <fieldset><legend>Languages · from your defaults</legend>{LANGUAGE_FIELDS.map(f => <div className="language-field" key={f}><label htmlFor={id + f}>{labels[f]}</label><select id={id + f} value={langs[f]} onChange={e => setLangs({ ...langs, [f]: e.target.value })}>{SUPPORTED_LANGUAGES.map(c => <option key={c} value={c}>{languageName(c)}</option>)}</select></div>)}</fieldset>}
    <p className="review-hint">{agent === 'claude' ? 'Claude opens in the background. If it asks for approval, use Show terminal.' : 'Codex opens in the background. If it asks for approval, use Show terminal.'}</p>
    {error && <p role="alert">{error}</p>}
  </div><div className="review-actions"><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={busy || !folder} onClick={() => void launch()}>{busy ? 'Opening…' : 'Open session'}</button></div></PanelDialog>;
}
