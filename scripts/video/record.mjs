// Records one video. Usage: node record.mjs <guide|install>
// Starts a fresh demo server, drives the real Gloss UI in headless Chromium with Playwright's recorder,
// and writes out/<video>.webm plus a timeline of when each scene started. Captions are burned in; there is no
// narration, so a scene stays on screen long enough to read its caption or to finish its actions.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { videos } from './script.mjs';
import { Director, installOverlays, sleep, wait } from './lib.mjs';

const [video] = process.argv.slice(2);
const spec = videos[video];
if (!spec) throw new Error('Usage: node record.mjs <guide|install>');
// With narration (audio/<video>.json from narrate.mjs), each scene also lasts as long as its clip plus a short pause.
const narration = existsSync(`audio/${video}.json`)
  ? JSON.parse(readFileSync(`audio/${video}.json`, 'utf8')).clips
  : [];
const readingTime = (caption) => caption.split(/\s+/).filter(Boolean).length * 0.42 + 2;
mkdirSync('out', { recursive: true });

const server = spawn('node', ['demo-server.mjs', String(spec.port), '4199', spec.scenario], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve) =>
  server.stdout.on('data', (d) => d.toString().includes('on http') && resolve()),
);
process.on('exit', () => server.kill());
const base = `http://127.0.0.1:${spec.port}`;
const ctl = (op, body) =>
  fetch(`${base}/__demo/${op}`, { method: 'POST', body: JSON.stringify(body) }).then((r) =>
    r.json(),
  );
if (spec.scenario === 'install')
  await ctl('set-search-hits', {
    hits: [
      { path: '/Users/dana/Projects/webshop', name: 'webshop', git: true },
      { path: '/Users/dana/Projects/infra', name: 'infra', git: true },
      { path: '/Users/dana/Documents/web-notes', name: 'web-notes', git: false },
    ],
  });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  recordVideo: { dir: 'out/raw', size: { width: 1920, height: 1080 } },
  locale: 'en-US',
  timezoneId: 'Asia/Jerusalem',
});
// Behave like the desktop window: focused, with the alert bridge present (sounds are not recorded).
await context.addInitScript(() => {
  document.hasFocus = () => true;
  window.languageAssistant = { pickFolder: async () => null, setAttentionCount() {}, alert() {} };
});
const videoStart = Date.now();
const page = await context.newPage();
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.goto(`${base}/#capability=test`);
await page.getByRole('navigation', { name: 'Sessions' }).waitFor();
await sleep(800);
await installOverlays(page);
await page.mouse.move(1500, 700);
const d = new Director(page, 'en');

const timeline = [];
for (const [index, scene] of spec.scenes.entries()) {
  const spoken = narration[index]?.seconds ?? 0;
  // With narration a scene ends shortly after its line (or its actions, if they run longer). Without it, scenes
  // keep their minimum and a reading-time estimate for the caption.
  const target = narration.length
    ? spoken + 0.35
    : Math.max(scene.min, scene.caption ? readingTime(scene.caption) : 0);
  const start = Date.now();
  await d.caption(scene.caption);
  try {
    await scene.run(d, page, ctl);
  } catch (error) {
    console.error(`scene ${scene.id} failed:`, error.message);
    await page.screenshot({ path: `out/${video}-${scene.id}-failed.png` });
    throw error;
  }
  const elapsed = (Date.now() - start) / 1000;
  if (elapsed < target) await wait((target - elapsed) * 1000);
  const actual = (Date.now() - start) / 1000;
  timeline.push({ id: scene.id, start: (start - videoStart) / 1000, duration: actual });
  console.log(
    scene.id.padEnd(12),
    `at ${((start - videoStart) / 1000).toFixed(1)}s`,
    `held ${actual.toFixed(1)}s`,
    elapsed > target ? `(actions ran ${elapsed.toFixed(1)}s, longer than planned)` : '',
  );
}
await d.caption('');
await sleep(1000);
const end = (Date.now() - videoStart) / 1000;
const raw = await page.video().path();
await context.close();
await browser.close();
server.kill();
renameSync(raw, `out/${video}.webm`);
writeFileSync(
  `out/${video}.timeline.json`,
  JSON.stringify({ trimStart: timeline[0].start, end, scenes: timeline }, null, 2),
);
console.log('wrote', `out/${video}.webm`, `(${(end - timeline[0].start).toFixed(1)}s after trim)`);
