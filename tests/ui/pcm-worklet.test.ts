import { expect, it } from 'vitest';
import { floatToInt16, PCM_WORKLET_SOURCE, resampleTo16k } from '../../src/ui/pcm-worklet.js';
it('returns the input untouched at 16 kHz and halves a 32 kHz ramp by interpolation', () => {
  const same = new Float32Array([0.1, 0.2]); expect(resampleTo16k(same, 16000)).toBe(same);
  const ramp = Float32Array.from({ length: 32 }, (_, i) => i / 32);
  const out = resampleTo16k(ramp, 32000); expect(out.length).toBe(16);
  expect(out[0]).toBeCloseTo(0); expect(out[1]).toBeCloseTo(2 / 32, 5); expect(out[15]).toBeCloseTo(30 / 32, 5);
});
it('converts floats to clamped 16-bit samples', () => {
  expect(Array.from(floatToInt16(new Float32Array([0, 1, -1, 2, -2, 0.5])))).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
});
it('ships a worklet that registers pcm-capture and posts 1600-sample frames', () => {
  expect(PCM_WORKLET_SOURCE).toContain("registerProcessor('pcm-capture'"); expect(PCM_WORKLET_SOURCE).toContain('1600');
});
it('runs self-contained in a worklet-like scope and frames resampled audio', () => {
  const posted: { pcm: Int16Array; level: number }[] = []; let Processor: any;
  class Base { port = { postMessage: (m: { pcm: Int16Array; level: number }) => posted.push(m) }; }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', PCM_WORKLET_SOURCE)(Base, (_: string, p: unknown) => { Processor = p; }, 48000);
  const node = new Processor(); const block = new Float32Array(128).fill(0.5);
  for (let i = 0; i < 40; i++) node.process([[block]]); // 5120 samples at 48 kHz -> 1706 at 16 kHz -> one frame
  expect(posted).toHaveLength(1); expect(posted[0]!.pcm.length).toBe(1600); expect(posted[0]!.pcm[0]).toBe(16384); expect(posted[0]!.level).toBeCloseTo(0.5, 5);
});
