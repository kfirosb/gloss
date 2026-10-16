import { useState } from 'react';
import type { CatalogEntry } from '../core/session-catalog.js';
import type { Target } from '../core/contracts.js';
import { agentName } from './session-navigation.js';
export function SessionMetadata({ entry }: { entry: CatalogEntry }) {
  return (
    <>
      <strong>{entry.projectName}</strong>
      <div>Project: {entry.target.projectId}</div>
      <div>Worktree: {entry.worktreePath ?? entry.target.projectId}</div>
      {entry.branch && <div>Branch: {entry.branch}</div>}
      <div>
        {agentName(entry)} session: {entry.target.sessionRef}
      </div>
      {entry.reason && <div>{entry.reason}</div>}
    </>
  );
}
export function SessionConnectionControls({
  selected,
  onRegister,
  busy,
}: {
  selected: CatalogEntry | undefined;
  onRegister(target: Target): Promise<void>;
  busy: boolean;
}) {
  const [details, setDetails] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  async function register(target: Target) {
    setPending(true);
    setError('');
    try {
      await onRegister(target);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed');
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <div className="session-picker-foot">
        <button aria-expanded={details} onClick={() => setDetails(!details)}>
          Session details
        </button>
      </div>
      {details && selected && (
        <div className="session-details">
          <SessionMetadata entry={selected} />
          {selected.sessionId && selected.activity === 'disconnected' && (
            <button disabled={busy || pending} onClick={() => void register(selected.target)}>
              Reconnect same target
            </button>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
