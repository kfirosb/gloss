import { FRAME_SAMPLES, SAMPLE_RATE } from '../core/dictation-contracts.js';

/** Name the capture processor registers under and the page instantiates. */
export const PCM_PROCESSOR_NAME = 'pcm-capture';
/** Linear-interpolation resampler; good enough for speech going into whisper. */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate; const length = Math.floor(input.length / ratio); const out = new Float32Array(length);
  for (let i = 0; i < length; i++) { const pos = i * ratio; const j = Math.floor(pos); const frac = pos - j; const a = input[j] ?? 0; const b = input[j + 1] ?? a; out[i] = a + (b - a) * frac; }
  return out;
}
export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) { const v = Math.max(-1, Math.min(1, input[i]!)); out[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767); }
  return out;
}
/** Runs inside the AudioWorklet global scope: resamples to SAMPLE_RATE, accumulates FRAME_SAMPLES frames and posts them with a level reading.
 * The worklet cannot import modules, so the constants are written into the source and the helpers are bound to explicit names
 * (a minifier may rename the function declarations themselves). */
export const PCM_WORKLET_SOURCE = `
const SAMPLE_RATE = ${SAMPLE_RATE};
const FRAME = ${FRAME_SAMPLES};
const resample = ${resample.toString()};
const floatToInt16 = ${floatToInt16.toString()};
class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.pending = new Float32Array(0); }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]; if (!channel) return true;
    const mono = resample(channel, sampleRate, SAMPLE_RATE);
    const merged = new Float32Array(this.pending.length + mono.length); merged.set(this.pending); merged.set(mono, this.pending.length);
    let offset = 0;
    while (merged.length - offset >= FRAME) {
      const slice = merged.subarray(offset, offset + FRAME); offset += FRAME;
      let sum = 0; for (let i = 0; i < slice.length; i++) sum += slice[i] * slice[i];
      const pcm = floatToInt16(slice);
      this.port.postMessage({ pcm, level: Math.sqrt(sum / slice.length) }, [pcm.buffer]);
    }
    this.pending = merged.slice(offset);
    return true;
  }
}
registerProcessor('${PCM_PROCESSOR_NAME}', PcmCapture);
`;
let url: string | undefined;
export function workletUrl(): string { return url ??= URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: 'text/javascript' })); }
