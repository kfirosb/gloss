import { PanelMoveControl } from './movable-workspace.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';

export type LiveState = 'arriving' | 'translating';
const liveText = (state: LiveState) => state === 'arriving' ? 'Response arriving…' : 'Translating…';
function LivePill({ state }: { state: LiveState | undefined }) {
  if (!state) return null;
  return <span className="live-state" role="status"><span className="attn-spinner" aria-hidden="true" />{liveText(state)}</span>;
}
export function ReadingPane({ title, name, history = false, onHistory, liveState, children }: { title: string; name: string; children: ReactNode; history?: boolean; onHistory?: () => void; liveState?: LiveState | undefined }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const home = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  // Move the same DOM subtree into a native dialog: message state and scroll survive expansion.
  useEffect(() => {
    if (!content.current || !home.current || !dialog.current) return;
    if (expanded) { dialog.current.append(content.current); dialog.current.showModal(); }
    else { dialog.current.close(); home.current.append(content.current); }
  }, [expanded]);
  const restore = () => { setExpanded(false); trigger.current?.focus(); };
  return <section className={`reading-pane pane-${name}` + (liveState ? ' attn-ring' : '')} data-pane={name} {...(liveState ? { 'data-live': liveState } : {})}>
    <div className="pane-toolbar"><PanelMoveControl /><h2>{title}</h2><LivePill state={liveState} />{onHistory && <button type="button" aria-label={`History ${title}`} aria-pressed={history} onClick={onHistory}>{history ? 'Latest' : 'History'}</button>}<button ref={trigger} type="button" onClick={() => setExpanded(true)} aria-label={`Expand ${title}`}>Expand</button></div>
    <div ref={home} className="pane-home"><div ref={content} className="pane-content">{children}</div></div>
    <dialog ref={dialog} className="expanded-pane" aria-label={`${title} expanded`} onCancel={e => { e.preventDefault(); restore(); }}><div className="pane-toolbar"><h2>{title}</h2><LivePill state={liveState} />{onHistory && <button type="button" aria-label={`History ${title}`} aria-pressed={history} onClick={onHistory}>{history ? 'Latest' : 'History'}</button>}<button type="button" onClick={restore}>Restore</button></div></dialog>
  </section>;
}
