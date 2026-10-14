import { expect, it } from 'vitest';
// @ts-expect-error untyped desktop module
import { createAlertHandler } from '../../desktop/attention-alert.mjs';

function harness(focused: boolean) {
  const calls: string[] = [];
  const handler = createAlertHandler({ playSound: (p: string) => calls.push('sound ' + p), bounce: () => calls.push('bounce'), isFocused: () => focused });
  return { calls, handler };
}

it('plays a whitelisted system sound and bounces only when unfocused', () => {
  const away = harness(false); away.handler.handle({ sound: 'Glass', bounce: true });
  expect(away.calls).toEqual(['sound /System/Library/Sounds/Glass.aiff', 'bounce']);
  const front = harness(true); front.handler.handle({ sound: 'Ping', bounce: true });
  expect(front.calls).toEqual(['sound /System/Library/Sounds/Ping.aiff']);
});

it('ignores unknown sounds and junk payloads', () => {
  const h = harness(false);
  h.handler.handle({ sound: '../../../etc/passwd', bounce: false });
  h.handler.handle({ sound: 'glass', bounce: false });
  h.handler.handle(null); h.handler.handle('Glass'); h.handler.handle({ bounce: 'yes' });
  expect(h.calls).toEqual([]);
  h.handler.handle({ bounce: true });
  expect(h.calls).toEqual(['bounce']);
});
