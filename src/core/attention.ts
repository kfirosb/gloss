import type { AgentMessage, CodingState } from './contracts.js';

/** What a session needs from the user. Red on every surface means one of the two non-none values. */
export type Attention = 'none' | 'response' | 'approval';

/** Revision of the newest completed native assistant message; undefined when there is none. Claude channel replies (`channel:` sourceIds) are skipped: their revisions are global SQLite sequences while native revisions are transcript byte offsets, so the two are not comparable, and the native final message carries the answer since app 0.3.4. Translation state is irrelevant: the agent stopped when the English text completed. */
export function latestResponseSequence(messages: readonly AgentMessage[]): number | undefined {
  let latest: number | undefined;
  for (const message of messages) {
    if (
      message.role !== 'assistant' ||
      message.complete !== true ||
      message.sourceId.startsWith('channel:')
    )
      continue;
    if (latest === undefined || message.revision > latest) latest = message.revision;
  }
  return latest;
}

/** Approval wins because the terminal is blocked. A response counts until the user has seen that sequence. A closed or disconnected session is never waiting for a response. */
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
  const latest = entry.latestResponseSequence;
  if (latest !== undefined && (seen === undefined || latest > seen)) return 'response';
  return 'none';
}
