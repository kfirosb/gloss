import { useEffect, useState } from 'react';
import type { ChannelStatus } from '../agents/claude/channel-types.js';
import type { ChannelSetup } from '../runtime/claude-channel-setup.js';
import type { SessionClient } from './session-client.js';
import { errorMessage } from './error-message.js';

export function useClaudeConnection(client: SessionClient, enabled: boolean) {
  const [status, setStatus] = useState<ChannelStatus>({
    state: 'connecting',
    reason: 'Checking channel readiness…',
  });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await client.claudeChannelStatus(controller.signal);
        if (!controller.signal.aborted) setStatus(next);
      } catch {
        if (!controller.signal.aborted)
          setStatus({
            state: 'disconnected',
            reason: 'Channel status unavailable; sending is disabled until verified.',
          });
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, enabled]);
  return status;
}
const labels = {
  'setup-required': 'Channel setup required',
  connecting: 'Connecting',
  connected: 'Channel connected',
  disconnected: 'Disconnected',
  unsupported: 'Unsupported',
};
export function ClaudeConnection({
  client,
  status,
}: {
  client: SessionClient;
  status: ChannelStatus;
}) {
  const [setup, setSetup] = useState<ChannelSetup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const prepare = async () => {
    setBusy(true);
    setError('');
    setSetup(null);
    try {
      setSetup(await client.prepareClaudeChannel());
    } catch (error) {
      setError(errorMessage(error, 'Setup unavailable'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="claude-connection" dir="ltr">
      <summary>Experimental · {labels[status.state]}</summary>
      <p>
        {status.reason ??
          (status.state === 'connected'
            ? 'A ready channel is verified for this exact session.'
            : 'No ready channel is verified for this exact session.')}{' '}
        Discovery in the sidebar alone does not enable sending.
      </p>
      <p>
        Stop the existing Claude process normally before resuming it with the command below. Claude
        requires experimental consent at each launch. Setup never restarts your session.
      </p>
      <p>
        Files and images are sent as local references, subject to Claude’s normal permissions. A
        missing confirmation does not mean approval is pending.
      </p>
      <button
        type="button"
        disabled={busy || status.state === 'unsupported'}
        onClick={() => void prepare()}
      >
        {busy ? 'Preparing…' : 'Prepare setup command'}
      </button>
      {setup && (
        <>
          <p>{setup.instructions}</p>
          <textarea aria-label="Claude setup command" readOnly value={setup.command} rows={4} />
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
