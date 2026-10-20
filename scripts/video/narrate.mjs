// Generates one narration clip per scene with ElevenLabs and measures it.
// Usage: ELEVENLABS_API_KEY=... node narrate.mjs <guide|install> [voiceId]
// A scene is narrated with its `voice` text when it has one, otherwise with its caption; scenes with neither are silent.
// Clips are cached by text and voice, so re-running after a caption change only pays for the changed scenes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { videos } from './script.mjs';

const [video, voiceArg] = process.argv.slice(2);
const key = process.env.ELEVENLABS_API_KEY;
if (!videos[video] || !key)
  throw new Error('Usage: ELEVENLABS_API_KEY=... node narrate.mjs <guide|install> [voiceId]');
const voice = voiceArg ?? 'cjVigY5qzO86Huf0OWal'; // Eric: smooth, trustworthy, American
const model = 'eleven_multilingual_v2';
const speed = Number(process.env.VOICE_SPEED ?? 1.1); // ElevenLabs accepts 0.7 to 1.2
mkdirSync('audio', { recursive: true });

const clips = [];
const missing = [];
let previous = '';
for (const [i, scene] of videos[video].scenes.entries()) {
  const text = scene.voice ?? scene.caption;
  if (!text) {
    clips.push({ id: scene.id, file: null, seconds: 0 });
    continue;
  }
  const hash = createHash('sha256')
    .update(`${voice}\n${model}\n${speed}\n${text}`)
    .digest('hex')
    .slice(0, 12);
  const file = `audio/${video}-${hash}.mp3`;
  if (!existsSync(file)) {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({
          text,
          model_id: model,
          previous_text: previous || undefined,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.15,
            use_speaker_boost: true,
            speed,
          },
        }),
      },
    );
    if (!response.ok) {
      const detail = await response.text();
      if (!/quota_exceeded/.test(detail))
        throw new Error(`ElevenLabs ${response.status}: ${detail}`);
      // Out of credits: keep the timing right with an estimate and leave the line silent until it can be generated.
      const seconds = text.split(/\s+/).length / 3.6; // a quick read of the caption, so no dead air
      missing.push(scene.id);
      clips.push({ id: scene.id, file: null, seconds, missing: true });
      console.log(scene.id.padEnd(12), seconds.toFixed(2) + 's (estimated, quota exceeded)');
      continue;
    }
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  }
  previous = text;
  const seconds = Number(
    execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      file,
    ])
      .toString()
      .trim(),
  );
  clips.push({ id: scene.id, file, seconds });
  console.log(scene.id.padEnd(12), seconds.toFixed(2) + 's');
}
writeFileSync(`audio/${video}.json`, JSON.stringify({ voice, model, speed, clips }, null, 2));
if (missing.length)
  console.log(`MISSING ${missing.length} line(s), no ElevenLabs credits: ${missing.join(', ')}`);
console.log('total narration', clips.reduce((a, c) => a + c.seconds, 0).toFixed(1) + 's');
