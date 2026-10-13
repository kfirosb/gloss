import { describe, expect, it } from 'vitest';
import { createSegmenter, rms } from '../../src/core/dictation-segmenter.js';
import { FRAME_SAMPLES } from '../../src/core/dictation-contracts.js';

/** One 100 ms frame at a given amplitude (0..1); speech frames are a square-ish tone, silence is near-zero noise. */
const frame = (amplitude: number, seed = 1): Int16Array => {
  const out = new Int16Array(FRAME_SAMPLES); let x = seed;
  for (let i = 0; i < out.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; const noise = (x / 0x7fffffff) * 2 - 1; out[i] = Math.round(32767 * amplitude * (i % 32 < 16 ? 1 : -1) * (0.8 + 0.2 * noise)); }
  return out;
};
const speech = (ms: number) => Array.from({ length: ms / 100 }, (_, i) => frame(0.3, i + 7));
const silence = (ms: number) => Array.from({ length: ms / 100 }, (_, i) => frame(0.001, i + 99));
const hum = (ms: number) => Array.from({ length: ms / 100 }, (_, i) => frame(0.004, i + 3));
const feed = (segmenter: ReturnType<typeof createSegmenter>, frames: Int16Array[]) => frames.flatMap(f => segmenter.push(f));
const ms = (samples: Int16Array) => samples.length / 16;

describe('rms', () => {
  it('is 0 for silence and near the amplitude for a tone', () => {
    expect(rms(new Int16Array(FRAME_SAMPLES))).toBe(0);
    expect(rms(frame(0.3))).toBeGreaterThan(0.2); expect(rms(frame(0.3))).toBeLessThan(0.4);
  });
});

describe('createSegmenter', () => {
  it('emits one segment after 1 s of speech followed by a 600 ms pause, keeping 200 ms trailing silence', () => {
    const s = createSegmenter();
    expect(feed(s, [...silence(300), ...speech(1500), ...silence(500)])).toEqual([]);
    const out = feed(s, silence(100));
    expect(out).toHaveLength(1);
    expect(ms(out[0]!)).toBe(300 + 1500 + 200);
  });
  it('trims leading silence to 300 ms', () => {
    const s = createSegmenter();
    const out = feed(s, [...silence(2000), ...speech(1200), ...silence(800)]);
    expect(out).toHaveLength(1); expect(ms(out[0]!)).toBe(300 + 1200 + 200);
  });
  it('merges a piece shorter than 1 s of speech into the next segment', () => {
    const s = createSegmenter();
    expect(feed(s, [...speech(500), ...silence(900)])).toEqual([]);
    const out = feed(s, [...speech(1200), ...silence(800)]);
    expect(out).toHaveLength(1); expect(ms(out[0]!)).toBe(500 + 200 + 1200 + 200);
  });
  it('discards pure silence and short speech with no follow-up on stop', () => {
    const s = createSegmenter();
    expect(feed(s, silence(5000))).toEqual([]); expect(s.stop()).toBeNull();
    const t = createSegmenter();
    expect(feed(t, [...speech(200), ...silence(900)])).toEqual([]); expect(t.stop()).toBeNull();
  });
  it('flushes at least 300 ms of speech on stop', () => {
    const s = createSegmenter();
    feed(s, [...speech(400)]);
    const last = s.stop(); expect(last).not.toBeNull(); expect(ms(last!)).toBe(400);
  });
  it('caps a segment at 8 s, cutting at the quietest frame of the last 3 s', () => {
    const s = createSegmenter();
    const frames = [...speech(6_500), frame(0.05, 1), ...speech(1_400)]; // quiet dip at 6.5 s, inside the last 3 s window
    const out = feed(s, frames);
    expect(out).toHaveLength(1); expect(ms(out[0]!)).toBe(6_500);
    const rest = s.stop(); expect(rest).not.toBeNull(); expect(ms(rest!)).toBe(100 + 1_400);
  });
  it('falls back to a hard cut at 8 s when the last 3 s are uniformly loud', () => {
    const s = createSegmenter();
    const out = feed(s, speech(8_100));
    expect(out).toHaveLength(1); expect(ms(out[0]!)).toBe(8_000);
  });
  it('does not treat a constant background hum as speech', () => {
    const s = createSegmenter();
    expect(feed(s, hum(6000))).toEqual([]); expect(s.stop()).toBeNull();
    const out = feed(s, [...speech(1200), ...hum(900)]);
    expect(out).toHaveLength(1);
  });
  it('adapts the floor downward when the room gets quieter', () => {
    const s = createSegmenter();
    feed(s, [...hum(300), ...silence(3000)]);
    const out = feed(s, [...speech(1200), ...silence(900)]);
    expect(out).toHaveLength(1);
  });
});
