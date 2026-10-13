import { SAMPLE_RATE } from '../../core/dictation-contracts.js';
/** 16-bit mono PCM WAV, the only format whisper-server accepts without ffmpeg. */
export function encodeWav(samples: Int16Array, sampleRate = SAMPLE_RATE): Buffer {
  const data = samples.length * 2; const out = Buffer.alloc(44 + data);
  out.write('RIFF', 0, 'ascii'); out.writeUInt32LE(36 + data, 4); out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii'); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24); out.writeUInt32LE(sampleRate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii'); out.writeUInt32LE(data, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i]!, 44 + i * 2);
  return out;
}
