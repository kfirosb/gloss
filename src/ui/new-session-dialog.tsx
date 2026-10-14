import { useEffect, useId, useState } from 'react';
import { PanelDialog } from './composer-dialogs.js';
import { sessionRequest } from './session-client.js';
import { LANGUAGE_FIELDS, SUPPORTED_LANGUAGES, languageName, type LanguageOverride, type LanguageSettings } from '../core/language-settings.js';
import { CLAUDE_SETUP_PROMPT, CODEX_SETUP_PROMPT, type LaunchAgent } from '../core/session-contracts.js';

declare global { interface Window { languageAssistant?: { pickFolder(): Promise<string | null>; setAttentionCount?(count: number): void; alert?(payload: { sound?: string; bounce: boolean }): void } } }
const labels = { write: 'I write in', send: 'Send to the agent in', reply: 'Show agent replies in', assist: 'Language Assistant speaks' } as const;
const defaultPrompt = (agent: LaunchAgent) => agent === 'claude' ? CLAUDE_SETUP_PROMPT : agent === 'codex' ? CODEX_SETUP_PROMPT : '';
const agentLabel = (agent: LaunchAgent) => agent === 'claude' ? 'Claude' : 'Codex';
type FolderOption = { key: string; name: string };
export interface LaunchedInfo { agent: LaunchAgent; folder: string; title?: string }

export function NewSessionDialog({ open, folders, defaultFolder, onClose, onLaunched }: { open: boolean; folders: FolderOption[]; defaultFolder?: string | undefined; onClose(): void; onLaunched(panelSessionId: string | undefined, launchId: string | undefined, launched: LaunchedInfo): void }) {
  const id = useId(); const [agent, setAgentState] = useState<LaunchAgent>('claude'); const [folder, setFolder] = useState(defaultFolder ?? '');
  const [prompt, setPrompt] = useState(CLAUDE_SETUP_PROMPT);
  const [extraFolders, setExtraFolders] = useState<FolderOption[]>([]);
  const [defaults, setDefaults] = useState<LanguageSettings | null>(null); const [langs, setLangs] = useState<LanguageSettings | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  // Switching agent swaps the default message only while the field still holds the other agent's default.
  const setAgent = (next: LaunchAgent) => { setPrompt(p => p === defaultPrompt(agent) || !p.trim() ? defaultPrompt(next) : p); setAgentState(next); };
  useEffect(() => {
    if (!open) return; let active = true; setError(''); setAgentState('claude'); setPrompt(CLAUDE_SETUP_PROMPT); setFolder(defaultFolder ?? folders[0]?.key ?? '');
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
  const shell = agent === 'shell'; const promptMissing = !shell && !prompt.trim();
  const launch = async () => {
    setBusy(true); setError('');
    try {
      // Only fields that differ from the defaults travel; the server applies them to the new session.
      const languageOverride: LanguageOverride = defaults && langs ? Object.fromEntries(LANGUAGE_FIELDS.filter(f => langs[f] !== defaults[f]).map(f => [f, langs[f]])) : {};
      const body = shell ? { agent, folder } : { agent, folder, ...(prompt.trim() !== defaultPrompt(agent) ? { prompt: prompt.trim() } : {}), ...(Object.keys(languageOverride).length ? { languageOverride } : {}) };
      const record = await sessionRequest<{ id?: string; panelSessionId?: string; title?: string }>('/api/launches', { method: 'POST', body: JSON.stringify(body) });
      onLaunched(record.panelSessionId, record.id, { agent, folder, ...(record.title ? { title: record.title } : {}) }); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : shell ? 'Could not open terminal' : 'Could not open session'); } finally { setBusy(false); }
  };
  const all = [...new Map([...folders, ...extraFolders].map(folder => [folder.key, folder])).values()];
  return <PanelDialog title="New session" open={open} close={onClose}><div className="review-body new-session" dir="ltr">
    <label htmlFor={id + 'folder'}>Folder</label>
    <div className="new-session-folder">{all.length > 0 && <select id={id + 'folder'} value={folder} onChange={e => setFolder(e.target.value)}>{all.map(f => <option key={f.key} value={f.key}>{f.name} — {f.key}</option>)}</select>}{window.languageAssistant && <button type="button" onClick={() => void pick()}>Choose…</button>}</div>
    {all.length === 0 && <p className="review-hint">{window.languageAssistant ? 'No project folders yet. Choose one to start.' : 'No project folders yet. Start Claude or Codex in a project from your terminal once, or choose a folder in the Gloss app.'}</p>}
    <fieldset><legend>Agent</legend><label><input type="radio" name={id + 'agent'} checked={agent === 'claude'} onChange={() => setAgent('claude')} /> Claude</label><label><input type="radio" name={id + 'agent'} checked={agent === 'codex'} onChange={() => setAgent('codex')} /> Codex</label><label><input type="radio" name={id + 'agent'} checked={shell} onChange={() => setAgent('shell')} /> Terminal</label></fieldset>
    {!shell && <><label htmlFor={id + 'prompt'}>First message</label>
      <textarea id={id + 'prompt'} className="first-message" value={prompt} maxLength={4000} onChange={e => setPrompt(e.target.value)} />
      <p className="review-hint">{promptMissing ? 'A first message is required: it is what lets Gloss connect to the session' : `Sent to ${agentLabel(agent)} as its first prompt, in English, the moment the session starts. It does not appear in Live Conversation.`}</p></>}
    {!shell && langs && <fieldset><legend>Languages · from your defaults</legend>{LANGUAGE_FIELDS.map(f => <div className="language-field" key={f}><label htmlFor={id + f}>{labels[f]}</label><select id={id + f} value={langs[f]} onChange={e => setLangs({ ...langs, [f]: e.target.value })}>{SUPPORTED_LANGUAGES.map(c => <option key={c} value={c}>{languageName(c)}</option>)}</select></div>)}</fieldset>}
    <p className="review-hint">{shell ? 'Opens a shell in this folder. Nothing is launched inside it.' : `${agentLabel(agent)} opens in the background. If it asks for approval, use Show terminal.`}</p>
    {error && <p role="alert">{error}</p>}
  </div><div className="review-actions"><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={busy || !folder || promptMissing} onClick={() => void launch()}>{busy ? 'Opening…' : shell ? 'Open terminal' : 'Open session'}</button></div></PanelDialog>;
}
