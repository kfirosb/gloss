import { useState } from 'react';
import type { TerminalEntry } from '../core/session-contracts.js';
import { TerminalView } from './terminal-view.js';

/** The full-workspace view of one terminal: a status line and the live attachment. */
export function TerminalWorkspace({
  terminal,
  originTitle,
  agentLabel,
  notice,
  onShrink,
  onEnd,
  onSendOutput,
}: {
  terminal: TerminalEntry;
  originTitle?: string | undefined;
  agentLabel?: string | undefined;
  notice?: string | undefined;
  onShrink(): void;
  onEnd(): void;
  onSendOutput?(text: string): void;
}) {
  const [selection, setSelection] = useState('');
  const folderName = terminal.folder.split('/').filter(Boolean).at(-1) ?? terminal.folder;
  return (
    <div className="terminal-workspace" dir="ltr">
      <div className="session-header">
        <b>
          {terminal.projectName} / {folderName}
        </b>
        <span className="pill shell">Terminal</span>
        <span>
          {terminal.busy ? 'Running' : 'At the prompt'}
          {originTitle ? ` · last run from ${originTitle}` : ''}
        </span>
        {notice && <span role="status">{notice}</span>}
        <span className="launch-terminal">
          {onSendOutput && agentLabel && (
            <button
              type="button"
              disabled={!selection.trim()}
              onClick={() => onSendOutput(selection)}
            >
              Send output to {agentLabel}
            </button>
          )}
          <button type="button" onClick={onShrink}>
            Shrink to popup
          </button>
          <button type="button" onClick={onEnd}>
            End terminal
          </button>
        </span>
      </div>
      <div className="terminal-workspace-host">
        <TerminalView launchId={terminal.launchId} onSelection={setSelection} />
      </div>
    </div>
  );
}
