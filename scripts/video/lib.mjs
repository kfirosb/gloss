// Recording helpers: in-page overlays (captions, cards, terminal), a visible cursor, and paced interactions.
/** Wall-clock wait, for holding a scene to its narration. */
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** All on-screen pacing (cursor moves, hovers, settles, typing, scene pauses) is scaled by PACE. */
export const PACE = Number(process.env.VIDEO_PACE ?? 0.6);
export const sleep = (ms) => wait(ms * PACE);

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><g fill="currentColor"><path d="M250 500 A250 250 0 0 1 750 500 L610 500 A110 110 0 0 0 390 500 Z"/><path d="M537 93 L945 500 L537 500 Z"/><g transform="rotate(180 500 500)"><path d="M250 500 A250 250 0 0 1 750 500 L610 500 A110 110 0 0 0 390 500 Z"/><path d="M537 93 L945 500 L537 500 Z"/></g></g></svg>`;

const OVERLAY_CSS = `
#demo-cursor,#demo-cap,#demo-card{margin:0;padding:0;border:0;background:transparent;overflow:visible;inset:auto;width:auto;height:auto;color:inherit}
#demo-cursor::backdrop,#demo-cap::backdrop,#demo-card::backdrop{display:none;background:transparent}
#demo-cursor:popover-open,#demo-cap:popover-open{display:block}
#demo-cap:popover-open{display:flex}
#demo-card:popover-open{display:flex}
#demo-cursor{position:fixed;left:0;top:0;width:26px;height:36px;transition:none;z-index:2147483647;pointer-events:none;transform:translate(-3px,-2px);filter:drop-shadow(0 2px 3px rgba(0,0,0,.6));transition:scale .12s}
#demo-cursor.down{scale:.82}
#demo-cap{position:fixed;left:0;right:0;bottom:0;top:auto;width:100%;box-sizing:border-box;z-index:2147483000;display:flex;justify-content:center;padding:0 160px 34px;pointer-events:none;opacity:0;transition:opacity .25s}
#demo-cap.on{opacity:1}
#demo-cap span{display:inline-block;background:rgba(10,12,16,.86);color:#fff;font:500 30px/1.4 -apple-system,"SF Pro Text","Helvetica Neue",Arial,sans-serif;padding:14px 26px;border-radius:14px;max-width:1500px;text-align:center;letter-spacing:.1px;box-shadow:0 6px 30px rgba(0,0,0,.45)}
#demo-cap[dir=rtl] span{font-family:-apple-system,"SF Hebrew","Helvetica Neue",Arial,sans-serif}
#demo-card{position:fixed;inset:0;width:100%;height:100%;z-index:2147482000;background:#15171c;color:#f3f4f6;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .45s;pointer-events:none;font-family:-apple-system,"SF Pro Display","SF Hebrew","Helvetica Neue",Arial,sans-serif}
#demo-card.on{opacity:1}
#demo-card .inner{display:flex;flex-direction:column;align-items:center;gap:26px;max-width:1300px;text-align:center;padding:0 80px}
#demo-card .logo{width:150px;height:150px;color:#fff;background:#2b6fde;border-radius:38px;display:flex;align-items:center;justify-content:center;box-shadow:0 20px 60px rgba(43,111,222,.35)}
#demo-card .logo svg{width:104px;height:104px}
#demo-card h1{font-size:84px;font-weight:700;margin:0;letter-spacing:-1.5px}
#demo-card h2{font-size:40px;font-weight:500;margin:0;color:#c9cdd6;line-height:1.35}
#demo-card p{font-size:30px;color:#9aa0ab;margin:0;line-height:1.5}
#demo-card .pill{font:500 30px/1 ui-monospace,SFMono-Regular,Menlo,monospace;background:#23262e;border:1px solid #363a45;padding:18px 28px;border-radius:14px;color:#e8eaf0}
#demo-card ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:18px;font-size:34px;color:#e2e5eb;text-align:start}
#demo-card ul li{display:flex;gap:18px;align-items:center}
#demo-card ul li::before{content:"";width:14px;height:14px;border-radius:50%;background:#2b6fde;flex:none}
#demo-card .term{width:1180px;background:#0d0f13;border:1px solid #2a2e37;border-radius:16px;box-shadow:0 30px 80px rgba(0,0,0,.6);overflow:hidden;text-align:start}
#demo-card .term .bar{height:44px;background:#1b1e25;display:flex;align-items:center;gap:10px;padding:0 18px;border-bottom:1px solid #2a2e37}
#demo-card .term .bar i{width:14px;height:14px;border-radius:50%;display:block}
#demo-card .term pre{margin:0;padding:28px 32px;font:400 28px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:#d7dae0;min-height:260px;white-space:pre-wrap;direction:ltr}
#demo-card .term .p{color:#7cc5ff}
#demo-card .term .c{color:#9aa0ab}
#demo-card .term .ok{color:#7ee787}
#demo-card .term .cur{display:inline-block;width:14px;height:28px;background:#d7dae0;vertical-align:-4px;animation:blink 1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
#demo-card .row{display:flex;gap:40px;align-items:stretch}
#demo-card .tile{background:#1d2027;border:1px solid #2e323c;border-radius:20px;padding:34px 40px;min-width:420px;display:flex;flex-direction:column;gap:14px;text-align:start}
#demo-card .tile b{font-size:34px;color:#fff}
#demo-card .tile span{font-size:26px;color:#aeb4c0;line-height:1.45}
`;

export async function installOverlays(page) {
  await page.evaluate(
    ({ css, logo }) => {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
      const cursor = document.createElement('div');
      cursor.id = 'demo-cursor';
      cursor.setAttribute('popover', 'manual');
      cursor.innerHTML =
        '<svg viewBox="0 0 26 36" width="26" height="36"><path d="M2 2 L2 28 L8.5 22 L13 33 L18 31 L13.5 20.5 L22 20 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      document.body.appendChild(cursor);
      let pos = { x: 1500, y: 700 };
      const place = (x, y) => {
        pos = { x, y };
        cursor.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
      };
      place(pos.x, pos.y);
      document.addEventListener('mousedown', () => cursor.classList.add('down'), true);
      document.addEventListener('mouseup', () => cursor.classList.remove('down'), true);
      const cap = document.createElement('div');
      cap.id = 'demo-cap';
      cap.setAttribute('popover', 'manual');
      cap.innerHTML = '<span></span>';
      document.body.appendChild(cap);
      const card = document.createElement('div');
      card.id = 'demo-card';
      card.setAttribute('popover', 'manual');
      card.innerHTML = '<div class="inner"></div>';
      document.body.appendChild(card);
      const layers = [card, cap, cursor];
      const raise = () => {
        for (const el of layers) {
          try {
            el.hidePopover();
          } catch {}
          try {
            el.showPopover();
          } catch {}
        }
      };
      raise();
      window.__demo = {
        logo,
        raise,
        moveCursor(x, y, ms) {
          const from = { ...pos };
          const t0 = performance.now();
          return new Promise((resolve) => {
            const step = (now) => {
              const k = Math.min(1, (now - t0) / ms);
              const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
              place(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
              if (k < 1) requestAnimationFrame(step);
              else resolve();
            };
            requestAnimationFrame(step);
          });
        },
        caption(text, dir) {
          if (!text) return cap.classList.remove('on');
          cap.querySelector('span').textContent = text;
          cap.setAttribute('dir', dir);
          cap.classList.add('on');
        },
        card(html, dir) {
          if (!html) return card.classList.remove('on');
          card.setAttribute('dir', dir);
          card.querySelector('.inner').innerHTML = html.replaceAll('{{logo}}', logo);
          card.classList.add('on');
        },
      };
    },
    { css: OVERLAY_CSS, logo: LOGO },
  );
}

export class Director {
  constructor(page, lang) {
    this.page = page;
    this.lang = lang;
    this.dir = lang === 'he' ? 'rtl' : 'ltr';
  }
  caption(text) {
    return this.page.evaluate(({ t, d }) => window.__demo.caption(t, d), { t: text, d: this.dir });
  }
  card(html) {
    return this.page.evaluate(({ h, d }) => window.__demo.card(h, d), { h: html, d: this.dir });
  }
  async hideCard() {
    await this.card('');
    await sleep(500);
  }
  /** Moves the visible cursor to the element over ~`ms`, then returns its center. */
  async moveTo(locator, ms = 600) {
    ms *= PACE;
    const box = await locator.first().boundingBox();
    if (!box) throw new Error('No box for ' + locator);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const steps = Math.max(8, Math.round(ms / 16));
    await Promise.all([
      this.page.evaluate(({ x, y, ms }) => window.__demo.moveCursor(x, y, ms), { x, y, ms }),
      this.page.mouse.move(x, y, { steps }),
    ]);
    return { x, y };
  }
  async click(locator, { settle = 350, native = false } = {}) {
    await this.moveTo(locator);
    if (native) {
      // Some controls lose the click when the press and release are separate events; use Playwright's own click.
      await locator.first().click();
      await sleep(Math.min(settle, 200));
      await this.page.evaluate(() => window.__demo.raise());
      if (settle > 200) await sleep(settle - 200);
      return;
    }
    await sleep(120);
    await this.page.mouse.down();
    await sleep(90);
    await this.page.mouse.up();
    await sleep(Math.min(settle, 200));
    await this.page.evaluate(() => window.__demo.raise());
    if (settle > 200) await sleep(settle - 200);
  }
  async hover(locator, dwell = 700) {
    await this.moveTo(locator);
    await sleep(dwell);
  }
  async type(locator, text, delay = 38) {
    await this.click(locator, { settle: 150 });
    await this.page.keyboard.type(text, { delay: delay * PACE });
  }
  /** Types into a mock terminal card line by line. `lines`: [{ text, cls, typed }] */
  async terminal(title, lines, { charDelay = 45, lineGap = 350 } = {}) {
    const html = `<div class="term"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span style="color:#9aa0ab;font-size:20px;margin-inline-start:12px">${title}</span></div><pre id="demo-term"></pre></div>`;
    await this.card(html);
    await sleep(500);
    for (const line of lines) {
      if (line.typed) {
        await this.page.evaluate((p) => {
          const pre = document.getElementById('demo-term');
          pre.innerHTML += `<span class="p">${p}</span><span id="demo-typed"></span><span class="cur"></span>`;
        }, line.prompt ?? '$ ');
        for (const ch of line.text) {
          await this.page.evaluate((c) => {
            document.getElementById('demo-typed').textContent += c;
          }, ch);
          await sleep(charDelay);
        }
        await sleep(450);
        await this.page.evaluate(() => {
          document.getElementById('demo-typed').removeAttribute('id');
          document.querySelector('#demo-term .cur')?.remove();
          document.getElementById('demo-term').innerHTML += '\n';
        });
      } else {
        await this.page.evaluate(
          ({ t, c }) => {
            document.getElementById('demo-term').innerHTML +=
              `<span class="${c ?? ''}">${t}</span>\n`;
          },
          { t: line.text, c: line.cls },
        );
        await sleep(line.gap ?? lineGap);
      }
    }
  }
}
