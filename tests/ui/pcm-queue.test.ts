import { describe, expect, it } from 'vitest';
import { CONNECTING_BUFFER_BYTES, PendingFrames } from '../../src/ui/pcm-queue.js';
import { SAMPLE_RATE } from '../../src/core/dictation-contracts.js';

const frame = (n: number, bytes = 4) => new Uint8Array(bytes).fill(n).buffer;
describe('PendingFrames', () => {
  it('holds about five seconds of 16-bit PCM by default', () => { expect(CONNECTING_BUFFER_BYTES).toBe(5 * SAMPLE_RATE * 2); });
  it('flushes queued frames in order and empties', () => {
    const q = new PendingFrames(100); q.push(frame(1)); q.push(frame(2)); q.push(frame(3));
    const sent: number[] = []; q.flush(b => sent.push(new Uint8Array(b)[0]!));
    expect(sent).toEqual([1, 2, 3]); const again: number[] = []; q.flush(b => again.push(1)); expect(again).toEqual([]);
  });
  it('drops the oldest frames past the bound so the queue joins the live stream without a gap', () => {
    const q = new PendingFrames(8); for (let i = 1; i <= 4; i++) q.push(frame(i));
    const sent: number[] = []; q.flush(b => sent.push(new Uint8Array(b)[0]!)); expect(sent).toEqual([3, 4]);
  });
  it('clear discards everything', () => {
    const q = new PendingFrames(100); q.push(frame(1)); q.clear();
    const sent: number[] = []; q.flush(b => sent.push(1)); expect(sent).toEqual([]);
  });
});
