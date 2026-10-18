import { useEffect, useState } from 'react';
import { isDeliveryTransport, type DeliveryRoute } from '../core/contracts.js';
import { recordOf } from '../core/json-record.js';
import { PeerExplanation } from './claude-connection.js';
import type { SessionClient } from './session-client.js';

/** How often the composer re-reads the route, in milliseconds: a terminal can close or a channel connect at any time. */
const ROUTE_POLL_MS = 2000;
const ROUTE_LABELS = { tmux: 'Terminal', channel: 'Channel', peer: 'Peer — limited' } as const;
const UNKNOWN_ROUTE: DeliveryRoute = {
  transport: null,
  reason: 'Gloss couldn’t check how to reach this session; it will check again.',
};
export function readDeliveryRoute(value: unknown): DeliveryRoute | undefined {
  const record = recordOf(value);
  if (isDeliveryTransport(record?.transport)) return { transport: record.transport };
  if (record?.transport === null && typeof record.reason === 'string')
    return { transport: null, reason: record.reason };
  return undefined;
}
export function useDeliveryRoute(
  client: SessionClient,
  enabled: boolean,
): DeliveryRoute | undefined {
  const [route, setRoute] = useState<DeliveryRoute | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next =
          readDeliveryRoute(await client.claudeRoute(controller.signal)) ?? UNKNOWN_ROUTE;
        if (!controller.signal.aborted) setRoute(next);
      } catch {
        if (!controller.signal.aborted) setRoute(UNKNOWN_ROUTE);
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), ROUTE_POLL_MS);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, enabled]);
  return route;
}
export function RouteLine({
  client,
  route,
}: {
  client: SessionClient;
  route: DeliveryRoute | undefined;
}) {
  if (!route) return <small className="route-line">Checking how to reach Claude…</small>;
  if (route.transport === null)
    return (
      <small className="route-line" role="note">
        {route.reason}
      </small>
    );
  return (
    <details className="route-line" dir="ltr">
      <summary>{ROUTE_LABELS[route.transport]}</summary>
      {route.transport === 'tmux' && (
        <p>
          Gloss types your message into this session’s terminal, as if you typed it there. If a
          dialog is open, Gloss shows you the terminal instead and sends nothing. Text you left
          unsent there is set aside with Ctrl+S, and Claude puts it back after the message goes in.
        </p>
      )}
      {route.transport === 'channel' && (
        <p>
          Gloss hands your message to the Gloss connection this session was started with. Claude
          reads it as a message from you.
        </p>
      )}
      {route.transport === 'peer' && <PeerExplanation client={client} />}
    </details>
  );
}
