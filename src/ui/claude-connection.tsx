import { useEffect, useRef, useState } from 'react';
import type { ChannelStatus } from '../agents/claude/channel-types.js';
import type { ChannelSetup } from '../runtime/claude-channel-setup.js';
import type { PeerSetting } from '../runtime/claude-peer-setting.js';
import { changeClaudeRegistration, type SessionClient } from './session-client.js';
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
  'setup-required': 'Not connected',
  connecting: 'Connecting',
  connected: 'Connected',
  disconnected: 'Disconnected',
  unsupported: 'Unsupported',
};
/** Copies `text`; when the clipboard is unavailable, selects the field so the user can copy it by hand. */
async function copy(text: string, field: HTMLTextAreaElement | null) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    field?.select();
  }
}
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
  const field = useRef<HTMLTextAreaElement>(null);
  const load = async (next: () => Promise<ChannelSetup>, fallback: string) => {
    setBusy(true);
    setError('');
    try {
      setSetup(await next());
    } catch (error) {
      setError(errorMessage(error, fallback));
    } finally {
      setBusy(false);
    }
  };
  const prepare = () => load(() => client.prepareClaudeChannel(), 'Setup unavailable');
  const register = () =>
    load(async () => {
      await changeClaudeRegistration('register');
      return client.prepareClaudeChannel();
    }, 'Registration failed');
  const registration = setup?.kind === 'registration-required' ? setup.registration : undefined;
  return (
    <details className="claude-connection" dir="ltr">
      <summary>Connect this session to Gloss · {labels[status.state]}</summary>
      <p>
        {status.reason ??
          (status.state === 'connected'
            ? 'A ready channel is verified for this exact session.'
            : 'No ready channel is verified for this exact session.')}{' '}
        Discovery in the sidebar alone does not enable sending.
      </p>
      <p>
        Files and images are sent as local references, subject to Claude’s normal permissions. A
        missing confirmation does not mean approval is pending.
      </p>
      {setup?.kind !== 'command' && (
        <button
          type="button"
          disabled={busy || status.state === 'unsupported'}
          onClick={() => void prepare()}
        >
          {busy ? 'Preparing…' : setup ? 'Check again' : 'Show connect command'}
        </button>
      )}
      {registration?.state === 'unregistered' && (
        <>
          <p>
            To connect sessions that weren't opened in Gloss, Gloss registers itself once with
            Claude Code as a connection server named <code>gloss</code>. This doesn't change
            existing sessions and doesn't send anything on its own.
          </p>
          <button type="button" disabled={busy} onClick={() => void register()}>
            Register
          </button>
        </>
      )}
      {registration?.state === 'stale' && (
        <>
          <p>
            The Claude connection needs updating: it points at <code>{registration.found}</code>.
          </p>
          <button type="button" disabled={busy} onClick={() => void register()}>
            Update
          </button>
        </>
      )}
      {registration?.state === 'conflict' && (
        <p role="alert">
          The name <code>gloss</code> is already used by another server in Claude:{' '}
          <code>{registration.found}</code>. Remove or rename it in Claude, then try again.
        </p>
      )}
      {registration?.state === 'unavailable' && <p role="alert">{registration.reason}</p>}
      {setup?.kind === 'command' && (
        <>
          <ol>
            <li>
              Close Claude in the terminal where it's running (<code>/exit</code> or Ctrl+C twice).
            </li>
            <li>
              In the same terminal, from <code>{setup.folder}</code>, run:
            </li>
            <li>
              Claude will ask for approval to load a development channel. Choose Yes. You'll be
              asked this every time you open the session this way.
            </li>
          </ol>
          <textarea
            ref={field}
            aria-label="Claude connect command"
            readOnly
            value={setup.command}
            rows={2}
          />
          <button type="button" onClick={() => void copy(setup.command, field.current)}>
            Copy
          </button>
          <button type="button" onClick={() => void copy(setup.cdCommand, field.current)}>
            Copy with cd
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}

export function PeerExplanation({ client }: { client: SessionClient }) {
  const [open, setOpen] = useState(false);
  const [setting, setSetting] = useState<PeerSetting | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    // A late answer must not land after the panel closed or the session changed.
    const controller = new AbortController();
    client.claudePeerSetting(controller.signal).then(
      (next) => {
        if (!controller.signal.aborted) setSetting(next);
      },
      () => {
        if (!controller.signal.aborted) setError('Could not read Claude’s setting.');
      },
    );
    return () => controller.abort();
  }, [client, open]);
  const allow = async () => {
    setBusy(true);
    setError('');
    try {
      setSetting(await client.allowClaudePeers());
    } catch (error) {
      setError(errorMessage(error, 'Could not change the setting.'));
    } finally {
      setBusy(false);
    }
  };
  const canAllow =
    !!setting && !setting.forcedBy && setting.user !== 'accept' && setting.user !== 'unreadable';
  return (
    <details
      className="peer-explanation"
      dir="ltr"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>How to allow</summary>
      <p>
        <b>Send without restarting the session.</b> Gloss sends your message to Claude as if it came
        from another Claude session of yours.
      </p>
      <p>
        <b>To allow it (once):</b> in that Claude session type <code>/config</code>, choose{' '}
        <b>Messages from your other sessions</b>, and set it to <b>accept</b>. Or press{' '}
        <b>Allow for all sessions</b> and Gloss will save the setting for you.
      </p>
      {setting?.forcedBy && (
        <p role="alert">
          {setting.forced ? (
            <>
              <code>crossSessionInbound</code> is set to {setting.forced} by your {setting.forcedBy}
              , so Gloss can’t allow it here.
            </>
          ) : (
            'Your organization manages Claude’s settings, so Gloss can’t change this here.'
          )}
        </p>
      )}
      {setting?.user === 'unreadable' && (
        <p role="alert">
          Gloss can’t read Claude’s settings.json safely, so it won’t change it. Use /config
          instead.
        </p>
      )}
      {canAllow && (
        <button type="button" disabled={busy} onClick={() => void allow()}>
          Allow for all sessions
        </button>
      )}
      <p>
        <b>What changes in this mode:</b> Claude sees your message as a request from a teammate, not
        as something you typed. It does the work as usual, but won't change settings, permissions or
        CLAUDE.md because of this message, and it adds about 100 tokens of explanation to every
        message.
      </p>
      <p>
        <b>For a full connection:</b> close the session and run the command in "Connect this session
        to Gloss".
      </p>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
