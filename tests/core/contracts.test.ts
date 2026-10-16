import { expect, it } from 'vitest';
import { canSendWhileWorking } from '../../src/core/contracts.js';

it('lets peer sends through while working only for agents that queue peer messages', () => {
  expect(canSendWhileWorking({ sendWhileBusy: false, peerSendWhileBusy: true }, 'peer')).toBe(true);
  expect(canSendWhileWorking({ sendWhileBusy: false, channelSendWhileBusy: true }, 'peer')).toBe(
    false,
  );
  expect(canSendWhileWorking({ sendWhileBusy: false, peerSendWhileBusy: true }, 'channel')).toBe(
    false,
  );
});
