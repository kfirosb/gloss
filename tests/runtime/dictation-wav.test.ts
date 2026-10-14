import { expect, it } from 'vitest';
import { encodeWav, WAV_HEADER_BYTES } from '../../src/runtime/dictation/wav.js';
it('writes a canonical 16-bit mono PCM header', () => {
  const wav = encodeWav(Int16Array.from([1, -1, 32767]), 16000);
  expect(wav.length).toBe(WAV_HEADER_BYTES + 6);
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF'); expect(wav.readUInt32LE(4)).toBe(36 + 6);
  expect(wav.toString('ascii', 8, 12)).toBe('WAVE'); expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
  expect(wav.readUInt32LE(16)).toBe(16); expect(wav.readUInt16LE(20)).toBe(1); expect(wav.readUInt16LE(22)).toBe(1);
  expect(wav.readUInt32LE(24)).toBe(16000); expect(wav.readUInt32LE(28)).toBe(32000); expect(wav.readUInt16LE(32)).toBe(2); expect(wav.readUInt16LE(34)).toBe(16);
  expect(wav.toString('ascii', 36, 40)).toBe('data'); expect(wav.readUInt32LE(40)).toBe(6);
  expect(wav.readInt16LE(44)).toBe(1); expect(wav.readInt16LE(46)).toBe(-1); expect(wav.readInt16LE(48)).toBe(32767);
});
