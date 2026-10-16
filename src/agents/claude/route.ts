import type { DeliveryRoute } from '../../core/contracts.js';

/** What the adapter found for one session; user tmux (spec 1.2) is added by plan 3. */
export interface ClaudeRouteInput {
  entrypoint?: string | undefined;
  /** A live Gloss launch whose pane still runs this session's Claude. */
  glossTerminal: boolean;
  /** A verified gloss or legacy language-assistant channel for this exact session and panel. */
  channel: boolean;
  /** The session has a messaging socket Gloss can write to. */
  peer: boolean;
}
export const DESKTOP_REASON = 'Claude Desktop sessions can’t receive messages from Gloss.';
export const NO_ROUTE_REASON =
  'Gloss can’t reach this session yet. Use “Connect this session to Gloss”.';
export const SESSION_GONE_REASON = 'This Claude session has ended or can’t be found.';
/** Spec section 1: exactly one route per send, in this order. */
export function selectClaudeRoute(input: ClaudeRouteInput): DeliveryRoute {
  if (input.entrypoint === 'claude-desktop') return { transport: null, reason: DESKTOP_REASON };
  if (input.glossTerminal) return { transport: 'tmux' };
  if (input.channel) return { transport: 'channel' };
  if (input.peer) return { transport: 'peer' };
  return { transport: null, reason: NO_ROUTE_REASON };
}
