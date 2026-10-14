import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os'; import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDictationEngine, locateWhisper } from '../../src/runtime/dictation/engine.js';
import { modelsDirectory } from '../../src/runtime/dictation/services.js';
import { WAV_HEADER_BYTES } from '../../src/runtime/dictation/wav.js';
import { createModelStore } from '../../src/runtime/dictation/model.js';
import { createSegmenter } from '../../src/core/dictation-segmenter.js';
import { acceptTranscription, FRAME_SAMPLES, MODEL_FILE } from '../../src/core/dictation-contracts.js';

const binary = locateWhisper(); const modelDir = modelsDirectory(join(homedir(), '.language-assistant')); const fixture = fileURLToPath(new URL('../fixtures/dictation-he.wav', import.meta.url));
const ready = !!binary && existsSync(join(modelDir, MODEL_FILE)) && existsSync(fixture);
describe.skipIf(!ready)('dictation with the real engine', () => {
  // The fixture is a free-form Hebrew test recording about "הקלטה" (recording) and "בדיקה" (test).
  it('transcribes the Hebrew fixture (a recording-test about הקלטה and בדיקה) through the segmenter', { timeout: 120_000 }, async () => {
    const wav = readFileSync(fixture); const pcm = new Int16Array(wav.buffer, wav.byteOffset + WAV_HEADER_BYTES, (wav.length - WAV_HEADER_BYTES) / 2);
    const engine = createDictationEngine({ binary, model: createModelStore({ directory: modelDir }) });
    try {
      await engine.ensureReady(() => undefined);
      const segmenter = createSegmenter(); const segments: Int16Array[] = [];
      for (let i = 0; i + FRAME_SAMPLES <= pcm.length; i += FRAME_SAMPLES) segments.push(...segmenter.push(pcm.subarray(i, i + FRAME_SAMPLES)));
      const last = segmenter.stop(); if (last) segments.push(last);
      expect(segments.length).toBeGreaterThan(0);
      let text = '';
      for (const s of segments) { const r = await engine.transcribe(s, { language: 'he', ...(text ? { prompt: text } : {}) }); const t = acceptTranscription(r.text, r.noSpeech, 'he'); if (t) text += (text ? ' ' : '') + t; }
      expect(text).toMatch(/הקלטה/); expect(text).toMatch(/בדיקה/);
    } finally { engine.close(); }
  });
});
