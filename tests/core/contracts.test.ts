import { expect, it } from 'vitest';
import {
  canSendWhileWorking,
  isAwaitingEvidence,
  isDeliveryTransport,
  isDeliveryUnresolved,
  sendGate,
} from '../../src/core/contracts.js';

it('lets peer sends through while working only for agents that queue peer messages', () => {
  expect(canSendWhileWorking({ sendWhileBusy: false, peerSendWhileBusy: true }, 'peer')).toBe(true);
  expect(canSendWhileWorking({ sendWhileBusy: false, channelSendWhileBusy: true }, 'peer')).toBe(
    false,
  );
  expect(canSendWhileWorking({ sendWhileBusy: false, peerSendWhileBusy: true }, 'channel')).toBe(
    false,
  );
});

it('gates sends by coding state and route: a terminal send waits for dialogs, channel and peer do not', () => {
  const claude = {
    sendWhileBusy: false,
    channelSendWhileBusy: true,
    peerSendWhileBusy: true,
    tmuxSendWhileBusy: true,
  };
  const cases = [
    ['idle', 'tmux', 'send'],
    ['working', 'tmux', 'send'],
    ['dialog-open', 'tmux', 'hold'],
    ['approval-required', 'tmux', 'hold'],
    ['disconnected', 'tmux', 'block'],
    ['dialog-open', 'channel', 'send'],
    ['dialog-open', 'peer', 'send'],
    ['approval-required', 'channel', 'block'],
    ['approval-required', 'peer', 'block'],
    ['working', 'channel', 'send'],
    ['disconnected', 'peer', 'block'],
  ] as const;
  for (const [state, transport, gate] of cases)
    expect(sendGate(state, claude, transport), `${state} ${transport}`).toBe(gate);
  expect(sendGate('working', { sendWhileBusy: false }, 'tmux')).toBe('hold');
  expect(sendGate('working', { sendWhileBusy: false })).toBe('block');
  expect(sendGate('working', { sendWhileBusy: true })).toBe('send');
  expect(canSendWhileWorking({ sendWhileBusy: false, tmuxSendWhileBusy: true }, 'tmux')).toBe(true);
});
it('treats a held delivery as unresolved but with no native evidence to look for', () => {
  expect(isDeliveryUnresolved({ state: 'held' })).toBe(true);
  expect(isAwaitingEvidence({ state: 'held' })).toBe(false);
  for (const state of ['sending', 'queued', 'unconfirmed'] as const) {
    expect(isDeliveryUnresolved({ state })).toBe(true);
    expect(isAwaitingEvidence({ state })).toBe(true);
  }
  for (const state of ['sent', 'failed'] as const) {
    expect(isDeliveryUnresolved({ state })).toBe(false);
    expect(isAwaitingEvidence({ state })).toBe(false);
  }
  expect(isDeliveryTransport('tmux')).toBe(true);
  expect(isDeliveryTransport('socket')).toBe(false);
  expect(isDeliveryTransport(undefined)).toBe(false);
});
