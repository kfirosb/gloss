import type { Target } from '../../core/contracts.js';

export type ChannelKey = { panelSessionId: string; nativeSessionId: string; generation: string; requestId: string };
export type ChannelRecord = {
  schemaVersion: 1; target: Target; transcriptPath: string;
  claudePid: number; claudeStartedAt: string;
  channelPid: number; channelStartedAt: string;
  generation: string; port: number; token: string;
};
export type ChannelReply = { key: ChannelKey; text: string; sequence: number; timestamp: string };
export type ChannelStatus = { state: 'setup-required' | 'connecting' | 'connected' | 'disconnected' | 'unsupported'; reason?: string };
