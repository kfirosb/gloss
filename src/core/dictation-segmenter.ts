import { FRAME_MS } from './dictation-contracts.js';

export interface SegmenterOptions {
  pauseMs?: number; minSpeechMs?: number; stopMinSpeechMs?: number; maxSegmentMs?: number; cutWindowMs?: number;
  leadingSilenceMs?: number; trailingSilenceMs?: number; floorInitFrames?: number; speechRatio?: number; minSpeechRms?: number; maxFloor?: number;
}
export interface Segmenter {
  /** Feed one 100 ms frame; returns zero or more completed segments (16 kHz mono Int16). */
  push(frame: Int16Array): Int16Array[];
  /** Flush what remains; null when it holds too little speech to be worth transcribing. */
  stop(): Int16Array | null;
}
interface Frame { samples: Int16Array; rms: number; speech: boolean }

/** Root mean square on a 0..1 scale. */
export function rms(frame: Int16Array): number {
  if (!frame.length) return 0;
  let sum = 0; for (let i = 0; i < frame.length; i++) { const v = frame[i]! / 32768; sum += v * v; }
  return Math.sqrt(sum / frame.length);
}
const concat = (frames: Frame[]): Int16Array => {
  const out = new Int16Array(frames.reduce((n, f) => n + f.samples.length, 0)); let offset = 0;
  for (const f of frames) { out.set(f.samples, offset); offset += f.samples.length; }
  return out;
};

export function createSegmenter(options: SegmenterOptions = {}): Segmenter {
  const pause = options.pauseMs ?? 600, minSpeech = options.minSpeechMs ?? 1000, stopMin = options.stopMinSpeechMs ?? 300;
  const maxSegment = options.maxSegmentMs ?? 8_000, cutWindow = options.cutWindowMs ?? 3000;
  const leading = options.leadingSilenceMs ?? 300, trailing = options.trailingSilenceMs ?? 200;
  const floorInit = options.floorInitFrames ?? 3, ratio = options.speechRatio ?? 3, minRms = options.minSpeechRms ?? 0.01, maxFloor = options.maxFloor ?? 0.02;
  const toFrames = (ms: number) => Math.round(ms / FRAME_MS);
  let floor: number | undefined; let seen = 0;
  let carry: Frame[] = []; let buffer: Frame[] = [];
  const speechMs = (frames: Frame[]) => frames.filter(f => f.speech).length * FRAME_MS;
  const trailingSilence = (frames: Frame[]) => { let n = 0; for (let i = frames.length - 1; i >= 0 && !frames[i]!.speech; i--) n++; return n; };
  const trimTrailing = (frames: Frame[]) => frames.slice(0, frames.length - Math.max(0, trailingSilence(frames) - toFrames(trailing)));
  const classify = (samples: Int16Array): Frame => {
    const r = rms(samples); seen++;
    if (floor === undefined || seen <= floorInit) floor = Math.min(floor ?? maxFloor, r, maxFloor);
    const speech = r > Math.max(floor * ratio, minRms);
    if (!speech && seen > floorInit) floor = r < floor ? r : floor * 0.95 + r * 0.05;
    return { samples, rms: r, speech };
  };
  return {
    push(samples) {
      const frame = classify(samples); buffer.push(frame); const out: Int16Array[] = [];
      // Keep at most `leading` ms of silence in front of the first speech; a carried piece already supplies its own trailing silence.
      const keep = carry.length ? 0 : toFrames(leading);
      if (!buffer.some(f => f.speech) && buffer.length > keep) buffer.splice(0, buffer.length - keep);
      const all = () => [...carry, ...buffer];
      if (all().length >= toFrames(maxSegment)) {
        const frames = all(); const window = frames.slice(-toFrames(cutWindow));
        const sorted = window.map(f => f.rms).sort((a, b) => a - b); const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
        // Cut only at a frame clearly quieter than its neighbours; a uniformly loud window falls back to the hard boundary.
        let best = -1; let bestRms = Infinity;
        window.forEach((f, i) => { if (f.rms < median * 0.5 && f.rms < bestRms) { bestRms = f.rms; best = i; } });
        const cutAt = best >= 0 ? frames.length - window.length + best : frames.length;
        out.push(concat(frames.slice(0, cutAt))); carry = []; buffer = frames.slice(cutAt);
        return out;
      }
      if (trailingSilence(buffer) * FRAME_MS >= pause && buffer.some(f => f.speech)) {
        const kept = trimTrailing(buffer);
        if (speechMs(carry) + speechMs(kept) >= minSpeech) { out.push(concat([...carry, ...kept])); carry = []; }
        else carry = [...carry, ...kept];
        buffer = [];
      }
      return out;
    },
    stop() {
      const frames = trimTrailing([...carry, ...buffer]); carry = []; buffer = [];
      return speechMs(frames) >= stopMin ? concat(frames) : null;
    },
  };
}
