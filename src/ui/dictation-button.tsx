import { useEffect, useState } from 'react';
import type { DictationLanguage } from '../core/dictation-contracts.js';
import { dictationLabel } from './dictation-state.js';
import type { Dictation } from './use-dictation.js';

/** How often the recording clock repaints. */
const ELAPSED_TICK_MS = 1000;
/** How often the level meter samples the hook's latest input level. */
const LEVEL_METER_INTERVAL_MS = 250;
/** Speech RMS sits well below 1; this gain spreads normal speaking levels across the meter (clamped at full). */
const LEVEL_GAIN = 4;
const elapsed = (startedAt: number | undefined, now: number) => { const s = Math.max(0, Math.floor((now - (startedAt ?? now)) / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
/** Polls the hook's level ref while mounted (only during recording), so the meter repaints without re-rendering the workspace. */
function DictationLevel({ read }: { read(): number }) {
  const [level, setLevel] = useState(read);
  useEffect(() => { const id = window.setInterval(() => setLevel(read()), LEVEL_METER_INTERVAL_MS); return () => window.clearInterval(id); }, [read]);
  return <span className="dictation-level" style={{ ['--level' as string]: Math.min(1, level * LEVEL_GAIN) }} />;
}
export function DictationButton({ dictation, language }: { dictation: Dictation; language: DictationLanguage }) {
  const { state } = dictation; const label = dictationLabel(state, language);
  // Re-render once per ELAPSED_TICK_MS while recording so the clock advances; nothing ticks in any other phase.
  const [, setTick] = useState(0);
  useEffect(() => { if (state.phase !== 'recording') return; const id = window.setInterval(() => setTick(t => t + 1), ELAPSED_TICK_MS); return () => window.clearInterval(id); }, [state.phase]);
  const disabled = state.phase === 'unavailable' || state.phase === 'finishing';
  return <>
    <button type="button" className={'dictation dictation-' + state.phase} title={label.title} aria-label={label.title} aria-pressed={state.phase === 'recording'} disabled={disabled} onClick={() => dictation.press()}>
      <span aria-hidden="true" className="dictation-icon">{state.phase === 'recording' ? '●' : state.phase === 'downloading' || state.phase === 'starting' || state.phase === 'finishing' ? '◌' : '🎤'}</span>
      {state.phase === 'downloading' && <span className="dictation-progress">{label.progress}</span>}
      {state.phase === 'recording' && <><span className="dictation-elapsed">{elapsed(state.startedAt, Date.now())}</span><DictationLevel read={dictation.readLevel} /></>}
    </button>
    {state.phase === 'finishing' && <span className="dictation-status" aria-hidden="true">…</span>}
    {state.phase === 'error' && <span role="alert" className="dictation-status">{state.message} <button type="button" onClick={() => dictation.press()}>Retry</button></span>}
    {state.notice && <span role="status" className="dictation-status">{state.notice} <button type="button" onClick={() => dictation.dismissNotice()} aria-label="Dismiss notice">×</button></span>}
  </>;
}
