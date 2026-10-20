# Guide video pipeline

Produces the videos in [`docs/media`](../../docs/media) from the real UI, with no real sessions or private data on screen. The videos carry captions and an ElevenLabs narration.

How it works:

- `demo-server.mjs` answers every `/api` route from invented projects, worktrees and conversations (`demo-data.mjs`), keeps real server-sent event streams and a WebSocket terminal open, proxies everything else to the vite dev server, and takes scene control messages on `/__demo/<op>` (add a discovered session, push an agent reply, write to the terminal, and so on).
- `script.mjs` lists the scenes of each video: the caption, a minimum on-screen time, and the clicks and typing performed at the scene start.
- `record.mjs` drives the UI in headless Chromium with Playwright's video recorder at 1920×1080, overlaying captions, title cards and a visible cursor (`lib.mjs`), and writes a timeline of scene start times.
- `narrate.mjs` turns each scene's caption (or its `voice` line) into a clip with the ElevenLabs API and records the clip lengths; `record.mjs` then holds each scene until its clip ends.
- `assemble.mjs` places the clips at their scene start times and encodes the MP4 with ffmpeg; without narration the audio track is silent.

Requirements: `ffmpeg` on the `PATH`, `ELEVENLABS_API_KEY` in the environment for narration, and the repository's dev dependencies (`npm ci`, which includes Playwright and its Chromium).

```sh
npm run dev -- --host 127.0.0.1 --port 4199 --strictPort   # in another terminal
cd scripts/video
for v in guide install; do node narrate.mjs $v && node record.mjs $v && node assemble.mjs $v; done
```

Outputs land in `scripts/video/out/` as `gloss-guide.mp4` and `gloss-install.mp4`; copy them to `docs/media/`. A failed scene leaves a screenshot in `out/` named after the scene.

`narrate.mjs` takes a voice id as its second argument (default: Eric). Clips are cached in `audio/` by text and voice, so after editing one caption only that line is generated again.

If the API key's own credit limit is used up, generate the missing lines on elevenlabs.io instead (Text to Speech, voice Eric, Multilingual v2, speed 1.10, stability 0.50, similarity 0.75, style 0.15, speaker boost on), download each one, and file it right after the download with `node adopt-clip.mjs guide <sceneId>`; `narrate.mjs` then finds it in the cache.
