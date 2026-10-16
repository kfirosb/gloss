import { SAMPLE_RATE } from '../core/dictation-contracts.js';

/** About five seconds of 16-bit mono PCM: more than enough for a local socket to open. */
export const CONNECTING_BUFFER_BYTES = 5 * SAMPLE_RATE * 2;

/** PCM frames captured while the dictation socket is still connecting, flushed in order once it opens. Bounded: past the limit the oldest frames go, so what is flushed runs straight into the live stream. */
export class PendingFrames {
  private frames: ArrayBuffer[] = [];
  private bytes = 0;
  constructor(private readonly maxBytes = CONNECTING_BUFFER_BYTES) {}
  push(frame: ArrayBuffer): void {
    this.frames.push(frame);
    this.bytes += frame.byteLength;
    while (this.bytes > this.maxBytes && this.frames.length)
      this.bytes -= this.frames.shift()!.byteLength;
  }
  flush(send: (frame: ArrayBuffer) => void): void {
    const frames = this.frames;
    this.clear();
    for (const f of frames) send(f);
  }
  clear(): void {
    this.frames = [];
    this.bytes = 0;
  }
}
