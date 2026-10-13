import { useEffect, useState } from 'react';
import { dictationLabel } from './dictation-state.js';
import type { Dictation } from './use-dictation.js';

const elapsed = (startedAt: number | undefined, now: number) => { const s = Math.max(0, Math.floor((now - (startedAt ?? now)) / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
/** Polls the hook's level ref while mounted (only during recording), so the meter repaints without re-rendering the workspace. */
function DictationLevel({ read }: { read(): number }) {
  const [level, setLevel] = useState(read);
  useEffect(() => { const id = window.setInterval(() => setLevel(read()), 250); return () => window.clearInterval(id); }, [read]);
  return <span className="dictation-level" style={{ ['--level' as string]: Math.min(1, level * 4) }} />;
}
export function DictationButton({ dictation, language, now = Date.now() }: { dictation: Dictation; language: 'he' | 'en'; now?: number }) {
  const { state } = dictation; const label = dictationLabel(state, language);
  const disabled = state.phase === 'unavailable' || state.phase === 'finishing';
  return <>
    <button type="button" className={'dictation dictation-' + state.phase} title={label.title} aria-label={label.title} aria-pressed={state.phase === 'recording'} disabled={disabled} onClick={() => dictation.press()}>
      <span aria-hidden="true" className="dictation-icon">{state.phase === 'recording' ? '●' : state.phase === 'downloading' || state.phase === 'starting' || state.phase === 'finishing' ? '◌' : '🎤'}</span>
      {state.phase === 'downloading' && <span className="dictation-progress">{label.progress}</span>}
      {state.phase === 'recording' && <><span className="dictation-elapsed">{elapsed(state.startedAt, now)}</span><DictationLevel read={dictation.readLevel} /></>}
    </button>
    {state.phase === 'finishing' && <span className="dictation-status" aria-hidden="true">…</span>}
    {state.phase === 'error' && <span role="alert" className="dictation-status">{state.message} <button type="button" onClick={() => dictation.press()}>Retry</button></span>}
    {state.notice && <span role="status" className="dictation-status">{state.notice} <button type="button" onClick={() => dictation.dismissNotice()} aria-label="Dismiss notice">×</button></span>}
  </>;
}
