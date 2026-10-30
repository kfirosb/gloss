import type { AgentMessage, CodingState } from './contracts.js';

/** What a session needs from the user. Red on every surface means any non-none value. */
export type Attention = 'none' | 'response' | 'approval' | 'question';

/** Messages Gloss made itself (channel replies, terminal questions) carry a namespace prefix on their sourceId. */
const SYNTHETIC_SOURCE_PREFIXES = ['channel:', 'question:'];

/** The terminal needs the user: an approval, or a question only the terminal can answer. */
export const blockedOnTerminal = (entry: {
  activity: CodingState | 'connecting' | 'unknown';
  attention?: Attention | undefined;
}): boolean => entry.activity === 'approval-required' || entry.attention === 'question';

/** Revision of the newest completed native assistant message; undefined when there is none. Synthetic messages are skipped: channel replies carry global SQLite sequences and terminal questions clock times, while native revisions are transcript byte offsets, so they are not comparable; the native final message carries a channel answer since app 0.3.4. Translation state is irrelevant: the agent stopped when the English text completed. */
export function latestResponseSequence(messages: readonly AgentMessage[]): number | undefined {
  let latest: number | undefined;
  for (const message of messages) {
    if (
      message.role !== 'assistant' ||
      message.complete !== true ||
      SYNTHETIC_SOURCE_PREFIXES.some((prefix) => message.sourceId.startsWith(prefix))
    )
      continue;
    if (latest === undefined || message.revision > latest) latest = message.revision;
  }
  return latest;
}

/** Approval wins because the terminal is blocked. An open dialog (Claude's session record says "input needed", or the screen shows its question) also blocks it until answered. A response counts until the user has seen that sequence. A closed or disconnected session is never waiting for a response. */
export function attentionFor(
  entry: {
    open: boolean;
    activity: CodingState | 'connecting' | 'unknown';
    latestResponseSequence?: number | undefined;
  },
  seen: number | undefined,
): Attention {
  if (entry.activity === 'approval-required') return 'approval';
  if (!entry.open || entry.activity === 'disconnected') return 'none';
  if (entry.activity === 'dialog-open') return 'question';
  const latest = entry.latestResponseSequence;
  if (latest !== undefined && (seen === undefined || latest > seen)) return 'response';
  return 'none';
}
