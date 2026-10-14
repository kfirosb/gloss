import { expect, it } from 'vitest';
import { FRAME_SAMPLES, SAMPLE_RATE } from '../../src/core/dictation-contracts.js';
import { floatToInt16, PCM_PROCESSOR_NAME, PCM_WORKLET_SOURCE, resample } from '../../src/ui/pcm-worklet.js';
it('returns the input untouched at the target rate and halves a double-rate ramp by interpolation', () => {
  const same = new Float32Array([0.1, 0.2]); expect(resample(same, SAMPLE_RATE, SAMPLE_RATE)).toBe(same);
  const ramp = Float32Array.from({ length: 32 }, (_, i) => i / 32);
  const out = resample(ramp, 2 * SAMPLE_RATE, SAMPLE_RATE); expect(out.length).toBe(16);
  expect(out[0]).toBeCloseTo(0); expect(out[1]).toBeCloseTo(2 / 32, 5); expect(out[15]).toBeCloseTo(30 / 32, 5);
});
it('converts floats to clamped 16-bit samples', () => {
  expect(Array.from(floatToInt16(new Float32Array([0, 1, -1, 2, -2, 0.5])))).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
});
it('ships a worklet that registers the capture processor and posts FRAME_SAMPLES-sample frames at SAMPLE_RATE', () => {
  expect(PCM_WORKLET_SOURCE).toContain(`registerProcessor('${PCM_PROCESSOR_NAME}'`); expect(PCM_WORKLET_SOURCE).toContain(`const FRAME = ${FRAME_SAMPLES};`); expect(PCM_WORKLET_SOURCE).toContain(`const SAMPLE_RATE = ${SAMPLE_RATE};`);
});
it('runs self-contained in a worklet-like scope and frames resampled audio', () => {
  const posted: { pcm: Int16Array; level: number }[] = []; let Processor: any;
  class Base { port = { postMessage: (m: { pcm: Int16Array; level: number }) => posted.push(m) }; }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', PCM_WORKLET_SOURCE)(Base, (_: string, p: unknown) => { Processor = p; }, 48000);
  const node = new Processor(); const block = new Float32Array(128).fill(0.5);
  for (let i = 0; i < 40; i++) node.process([[block]]); // 5120 samples at 48 kHz -> 1706 at 16 kHz -> one frame
  expect(posted).toHaveLength(1); expect(posted[0]!.pcm.length).toBe(FRAME_SAMPLES); expect(posted[0]!.pcm[0]).toBe(16384); expect(posted[0]!.level).toBeCloseTo(0.5, 5);
});
