export interface SummarySource {
  kind: 'coding' | 'discussion';
  messageId: string;
  contentHash: string;
}
export interface SummaryKey extends SummarySource {
  sessionId: string;
  language: string;
  model: string;
  promptVersion: string;
}
export interface ResponseSummary {
  source: SummarySource;
  text: string;
}
export const summaryCacheKey = (key: SummaryKey): string =>
  JSON.stringify([
    key.sessionId,
    key.kind,
    key.messageId,
    key.contentHash,
    key.language,
    key.model,
    key.promptVersion,
  ]);
