import {
  TRANSCRIPT_EVIDENCE_PREFIX,
  sameTarget,
  type AgentMessage,
  type Delivery,
  type Target,
  type WrittenText,
} from './contracts.js';

/**
 * The text the user wrote for each transcript user message that exactly one settled composer delivery names, keyed by
 * the message's `sourceId`. Only native evidence counts: a terminal send's confirmed transcript record id, or the
 * request id a peer message carries. Text is never compared, and any ambiguity (a delivery naming several messages,
 * several deliveries naming one message) leaves the message unmatched, because a wrong original is worse than none.
 * No translation is involved: the text is the composer draft the user sent.
 */
export function writtenOriginals(
  messages: readonly AgentMessage[],
  deliveries: readonly Delivery[],
  target: Target | undefined,
): Map<string, WrittenText> {
  const originals = new Map<string, WrittenText>();
  if (!target) return originals;
  const bySourceId = new Map<string, AgentMessage>();
  const byClientId = new Map<string, AgentMessage[]>();
  for (const message of messages) {
    if (message.role !== 'user') continue;
    bySourceId.set(message.sourceId, message);
    if (message.clientId === undefined) continue;
    byClientId.set(message.clientId, [...(byClientId.get(message.clientId) ?? []), message]);
  }
  const named = (delivery: Delivery): AgentMessage[] => {
    if (delivery.transport === 'tmux') {
      const evidence = delivery.nativeMessageId;
      if (!evidence?.startsWith(TRANSCRIPT_EVIDENCE_PREFIX)) return [];
      const message = bySourceId.get(evidence.slice(TRANSCRIPT_EVIDENCE_PREFIX.length));
      return message ? [message] : [];
    }
    if (delivery.transport === 'peer') {
      const ids = new Set([delivery.id, delivery.nativeMessageId]);
      return [...ids].flatMap((id) => (id === undefined ? [] : (byClientId.get(id) ?? [])));
    }
    // Channel messages are not transcript user messages, and Codex's accepted ids differ from its queue receipts.
    return [];
  };
  const claims = new Map<string, WrittenText[]>();
  for (const delivery of deliveries) {
    const written = delivery.written;
    if (
      delivery.state !== 'sent' ||
      !written?.text.trim() ||
      written.text === delivery.englishText ||
      !sameTarget(delivery.target, target)
    )
      continue;
    const messagesNamed = named(delivery);
    const [message] = messagesNamed;
    if (messagesNamed.length !== 1 || !message) continue;
    claims.set(message.sourceId, [...(claims.get(message.sourceId) ?? []), written]);
  }
  for (const [sourceId, [written, ...others]] of claims)
    if (written && !others.length) originals.set(sourceId, written);
  return originals;
}
