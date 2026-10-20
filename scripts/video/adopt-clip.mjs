// Moves the newest ElevenLabs web download into the narration cache for one scene, so narrate.mjs uses it.
// Usage: node adopt-clip.mjs <guide|install> <sceneId>   (voice, model and speed must match narrate.mjs defaults)
import { createHash } from 'node:crypto';
import { readdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { videos } from './script.mjs';

const [video, id] = process.argv.slice(2);
const scene = videos[video].scenes.find((s) => s.id === id);
const text = scene.voice ?? scene.caption;
const voice = 'cjVigY5qzO86Huf0OWal';
const model = 'eleven_multilingual_v2';
const speed = Number(process.env.VOICE_SPEED ?? 1.1);
const hash = createHash('sha256')
  .update(`${voice}\n${model}\n${speed}\n${text}`)
  .digest('hex')
  .slice(0, 12);
const downloads = join(homedir(), 'Downloads');
const newest = readdirSync(downloads)
  .filter((f) => f.startsWith('ElevenLabs_') && f.endsWith('.mp3'))
  .map((f) => ({ f, t: statSync(join(downloads, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0];
if (!newest || Date.now() - newest.t > 120_000)
  throw new Error('No ElevenLabs download in the last two minutes');
renameSync(join(downloads, newest.f), `audio/${video}-${hash}.mp3`);
console.log(id, '->', `audio/${video}-${hash}.mp3`);
