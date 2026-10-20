// Encodes a recording as an H.264 MP4. Usage: node assemble.mjs <guide|install>
// When audio/<video>.json exists (from narrate.mjs), each scene's clip starts just after that scene starts;
// otherwise the audio track is silent.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const [video] = process.argv.slice(2);
const timeline = JSON.parse(readFileSync(`out/${video}.timeline.json`, 'utf8'));
const total = timeline.end - timeline.trimStart;
const name = `out/gloss-${video}.mp4`;
const clips = existsSync(`audio/${video}.json`)
  ? JSON.parse(readFileSync(`audio/${video}.json`, 'utf8')).clips
  : [];

const inputs = ['-i', `out/${video}.webm`];
const filters = [`anullsrc=r=48000:cl=stereo,atrim=0:${timeline.end.toFixed(3)}[base]`];
const mixed = ['[base]'];
timeline.scenes.forEach((scene, i) => {
  const clip = clips[i];
  if (!clip?.file) return;
  inputs.push('-i', clip.file);
  const n = inputs.filter((x) => x === '-i').length - 1;
  // Placed on the untrimmed timeline: the output's -ss trims video and audio together.
  const delay = Math.round((scene.start + 0.4) * 1000);
  filters.push(
    `[${n}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${delay}|${delay}[a${n}]`,
  );
  mixed.push(`[a${n}]`);
});
filters.push(
  `${mixed.join('')}amix=inputs=${mixed.length}:normalize=0:duration=first,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`,
);

execFileSync(
  'ffmpeg',
  [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    ...inputs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '0:v',
    '-map',
    '[aout]',
    '-ss',
    timeline.trimStart.toFixed(3),
    '-t',
    total.toFixed(3),
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '21',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '30',
    '-vf',
    'scale=1920:1080:flags=lanczos',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-ar',
    '48000',
    '-movflags',
    '+faststart',
    name,
  ],
  { stdio: 'inherit' },
);
const probe = execFileSync('ffprobe', [
  '-v',
  'error',
  '-show_entries',
  'format=duration,size',
  '-of',
  'csv=p=0',
  name,
])
  .toString()
  .trim();
console.log(
  'wrote',
  name,
  probe,
  clips.length ? `with ${clips.filter((c) => c.file).length} narration clips` : 'silent',
);
