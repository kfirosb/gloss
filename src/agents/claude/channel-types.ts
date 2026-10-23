import type { Target } from '../../core/contracts.js';

/** Native channel message bound; an adapter limit, independent of the product composer limit. */
export const CHANNEL_MAX_TEXT_CHARS = 160_000;

export type ChannelKey = {
  panelSessionId: string;
  nativeSessionId: string;
  generation: string;
  requestId: string;
};
export type ChannelRecord = {
  schemaVersion: 1;
  target: Target;
  transcriptPath: string;
  claudePid: number;
  claudeStartedAt: string;
  channelPid: number;
  channelStartedAt: string;
  generation: string;
  port: number;
  token: string;
  /**
   * The path the helper opened its ledger by. Helpers before 0.23 never wrote it and always used the old data
   * folder's ledger; Gloss keeps that folder's ledger link while any such helper lives.
   */
  ledgerPath?: string;
};
export type ChannelReply = { key: ChannelKey; text: string; sequence: number; timestamp: string };
export type ChannelStatus = {
  state: 'setup-required' | 'connecting' | 'connected' | 'disconnected' | 'unsupported';
  reason?: string;
};
