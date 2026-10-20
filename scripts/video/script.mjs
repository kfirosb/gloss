// Scenes for both videos. Each scene: a caption, a minimum on-screen time, and `run(d, page, ctl)` performed at the
// scene start. `d` is the Director (lib.mjs), `ctl` posts to the demo server's /__demo endpoints.
import { sleep, wait } from './lib.mjs';
import {
  sessions,
  snapshots,
  checkoutScreen,
  onboardingScreen,
  ts,
  codexCaps,
  claudeCaps,
  languageSettings,
  shop,
  infra,
} from './demo-data.mjs';

const titleCard = (d, subtitle) =>
  d.card(`<div class="logo">{{logo}}</div><h1>Gloss</h1><h2>${subtitle}</h2>`);
const endCard = (d) =>
  d.card(
    `<div class="logo">{{logo}}</div><h1>Gloss</h1><h2>Open source · macOS and Linux · everything stays on your computer</h2><div class="pill">brew install --cask kfirosb/tap/gloss</div><p>github.com/kfirosb/gloss</p>`,
  );
const dialog = (page, text) => page.locator('dialog[open]').filter({ hasText: text }).first();
const folderRow = (page, name) => page.getByRole('button', { name: new RegExp('^' + name + ', ') });
const composer = (page) => page.getByRole('textbox', { name: 'Discuss with language assistant' });
const view = (page, name) =>
  page.getByRole('radiogroup', { name: 'Live Conversation view' }).getByRole('radio', { name });
const session = (id) => sessions.find((s) => s.id === id);
const B = '\x1b[1m',
  D = '\x1b[2m',
  R = '\x1b[0m',
  G = '\x1b[32m';

export const videos = {
  guide: {
    scenario: 'guide',
    port: 4198,
    scenes: [
      {
        id: 'title',
        min: 4,
        caption: '',
        voice:
          'This is Gloss. The same Claude Code and Codex agents, with a more convenient interface, in the language that suits you.',
        run: (d) =>
          titleCard(d, 'The same agent. A more convenient interface.<br>In your language.'),
      },
      {
        id: 'arrive',
        min: 9,
        caption:
          'Open Gloss and it finds every Claude Code and Codex session open on your computer, automatically. Nothing to set up.',
        run: async (d, page, ctl) => {
          await d.hideCard();
          await sleep(900);
          for (const id of [
            'terraform',
            'checkout',
            'carttests',
            'login',
            'payments',
            'onboarding',
          ]) {
            await ctl('add-session', {
              session: session(id),
              snapshot: snapshots[id],
              screen: id === 'checkout' ? checkoutScreen : undefined,
            });
            await sleep(700);
          }
          await d.click(page.getByRole('tab', { name: /Terraform modules/ }), { settle: 800 });
        },
      },
      {
        id: 'parallel',
        min: 10,
        caption:
          'Two projects, three worktrees, six agents, side by side. A worktree is not limited to one task: here main runs two agents on two tasks at once.',
        run: async (d, page) => {
          await d.hover(page.getByRole('button', { name: /^Collapse shop-api/ }), 900);
          await d.click(folderRow(page, 'main'), { settle: 500 });
          await d.hover(page.getByRole('tab', { name: /Checkout race/ }), 600);
          await d.hover(page.getByRole('tab', { name: /Cart API tests/ }), 700);
          await d.hover(folderRow(page, 'login-redirect'), 600);
          await d.hover(folderRow(page, 'payments-retry'), 700);
          await d.hover(folderRow(page, 'infra'), 700);
          await d.hover(folderRow(page, 'mobile-app'), 700);
        },
      },
      {
        id: 'badges',
        min: 7,
        caption:
          'Red means an agent needs you: an approval, or an answer you have not read yet. Spinners show who is still working.',
        run: async (d, page) => {
          await d.hover(folderRow(page, 'payments-retry').getByRole('img').last(), 1000);
          await d.hover(folderRow(page, 'login-redirect').getByRole('img').last(), 1000);
          await d.hover(folderRow(page, 'infra').getByRole('img').first(), 900);
        },
      },
      {
        id: 'checkout',
        min: 8,
        caption:
          'Claude just finished a fix on main. Instead of copying its reply into another agent to translate it, Gloss does it for you, for every reply.',
        run: async (d, page) => {
          await d.click(page.getByRole('tab', { name: /Checkout race/ }), { settle: 900 });
          await d.hover(page.getByText('Coding agent · translated').first(), 500);
          await d.moveTo(page.getByRole('region', { name: 'Live Hebrew conversation' }), 900);
        },
      },
      {
        id: 'languages',
        min: 7,
        caption:
          'You write in your own language, and the agent receives the language you choose, English by default. Each session can have its own setting.',
        run: async (d, page) => {
          await d.click(page.getByRole('button', { name: /^Session languages/ }), { settle: 700 });
          const menu = page.getByRole('dialog', { name: 'Languages for this session' });
          await d.hover(menu.getByText('I write in').first(), 700);
          await d.hover(menu.getByText('Send to the agent in').first(), 900);
          await d.hover(menu.getByText('Show agent replies in').first(), 700);
          await page.keyboard.press('Escape');
        },
      },
      {
        id: 'split',
        min: 8,
        caption:
          'Split view: the real terminal on the left, the translated conversation on the right.',
        run: async (d, page) => {
          await d.click(view(page, 'Split'), { settle: 1200 });
          await d.hover(page.locator('.pane-live .live-terminal .xterm').first(), 1200);
          await d.hover(page.getByRole('region', { name: 'Live Hebrew conversation' }), 800);
        },
      },
      {
        id: 'write',
        min: 15,
        caption:
          'Write in your language. Gloss types it into the terminal as concise English, the language this agent works in. Only your click sends it.',
        run: async (d, page, ctl) => {
          await d.type(composer(page), 'תוסיף גם בדיקה שאותו לקוח שולח שני תשלומים בבת אחת');
          await sleep(500);
          await d.click(
            page.getByRole('button', { name: 'Send to Terminal in English', exact: true }),
            {
              settle: 600,
            },
          );
          await d.hover(page.locator('.pane-live .live-terminal .xterm').first(), 300);
          // Real time: the demo server is still typing the English line into the terminal.
          await wait(1900);
          await ctl('terminal-write', {
            launchId: 'L-checkout',
            text:
              `${G}●${R} ${B}Write${R}(src/checkout/reserve.double-submit.test.ts)\r\n` +
              `${G}●${R} ${B}Bash${R}(npm test -- checkout) ${D}31 passed${R}\r\n` +
              `${G}●${R} Added rejects a double submit from the same customer next to the concurrent test. Both pass,\r\n` +
              `  and the full checkout suite is green: 31 tests.\r\n\r\n${B}>${R} `,
          });
          await sleep(900);
          await ctl('agent-reply', { id: 'checkout' });
        },
      },
      {
        id: 'reply',
        min: 7,
        caption:
          'Claude answers in the terminal, and the same answer shows up in Hebrew next to it.',
        run: async (d, page) => {
          await sleep(600);
          await d.hover(page.getByText('31 tests').first(), 1200);
          await d.hover(page.getByText('31 בדיקות').first(), 1200);
        },
      },
      {
        id: 'terminal',
        min: 9,
        caption:
          'Switch between the full terminal and the translated conversation whenever you like. Approvals and prompts stay in the terminal.',
        run: async (d, page) => {
          await d.click(view(page, 'Terminal'), { settle: 2600 });
          await d.click(view(page, 'Translated'), { settle: 1500 });
        },
      },
      {
        id: 'activity',
        min: 6,
        caption:
          'Activity shows what the agent is doing: its tool calls, its subagents, and background commands with their output.',
        run: async (d, page) => {
          await d.click(view(page, 'Activity'), { settle: 900 });
          await d.hover(page.getByText('Edit').first(), 700);
          await d.click(page.getByText(/finished subagent/).first(), { settle: 800 });
          await d.hover(page.getByText('Run the checkout test suite').first(), 900);
          await d.hover(page.getByText('Review every caller of reserveStock').first(), 900);
        },
      },
      {
        id: 'notify',
        min: 6,
        caption:
          'When an agent finishes in another session, a notification pops up with a sound. One click takes you there.',
        run: async (d, page, ctl) => {
          await ctl('agent-reply', { id: 'terraform' });
          const banner = page.getByRole('status').filter({ hasText: 'New reply' }).first();
          await banner.waitFor();
          await d.hover(banner, 300);
          await wait(1800); // real time, so the banner can be read
          await d.click(banner.getByRole('button', { name: 'Open' }), { settle: 300 });
          await page.getByText('מודול הרשת מוכן').first().waitFor();
          await d.hover(page.getByText('מודול הרשת מוכן').first(), 900);
        },
      },
      {
        id: 'files',
        min: 8,
        caption:
          'Pick any file to read. A long spec? Shorten it with a TL;DR, or translate it into the language you read comfortably.',
        run: async (d, page) => {
          await d.click(page.getByRole('button', { name: 'Files', exact: true }), { settle: 600 });
          await d.click(page.getByRole('button', { name: 'Move files to the right' }), {
            settle: 500,
          });
          await d.click(page.getByRole('button', { name: 'Open folder docs', exact: true }), {
            settle: 500,
          });
          await d.click(
            page.getByRole('button', { name: 'Preview migration-plan.md', exact: true }),
            { settle: 700 },
          );
          const preview = page.getByRole('dialog', { name: 'File preview' });
          await d.hover(
            preview.getByRole('heading', { name: 'Terraform module migration plan' }),
            500,
          );
          await d.click(preview.getByRole('button', { name: 'TL;DR', exact: true }), {
            settle: 200,
          });
          await preview.getByLabel('File summary').waitFor();
          await d.hover(preview.getByLabel('File summary'), 200);
          await wait(1300); // real time, so the summary can be read
          await d.click(preview.getByRole('button', { name: 'Translate', exact: true }), {
            settle: 200,
          });
          await preview.getByLabel('File translation').waitFor();
          await d.hover(preview.getByLabel('File translation'), 200);
          await wait(1400);
          await d.click(preview.getByRole('button', { name: 'Close file preview' }), {
            settle: 300,
          });
          await d.click(page.getByRole('button', { name: 'Close files' }), { settle: 300 });
        },
      },
      {
        id: 'new',
        min: 13,
        caption:
          'Need another agent? Open a new session from here: Claude, Codex or a plain terminal, in any folder or a fresh worktree. Gloss starts it and connects it.',
        run: async (d, page, ctl) => {
          await d.click(page.getByRole('button', { name: 'New session' }), { settle: 900 });
          const dlg = dialog(page, 'New session');
          await d.hover(dlg.getByRole('radio', { name: 'Claude' }), 500);
          await d.hover(dlg.getByRole('radio', { name: 'Codex' }), 500);
          await d.hover(dlg.getByRole('radio', { name: 'Terminal' }), 500);
          await d.hover(dlg.getByText('Folder', { exact: true }), 600);
          await d.click(dlg.getByRole('button', { name: 'Open session' }), { settle: 1500 });
          await d.hover(page.getByRole('tab', { name: /Starting…/ }), 1200);
          const id = 'cart';
          await ctl('launch-connected', {
            launchId: 'L1',
            session: {
              ...session('terraform'),
              id,
              target: { agent: 'claude', sessionRef: id, projectId: infra.main },
              sessionTitle: 'Database module',
              launchId: 'L1',
              launchState: 'running',
              activity: 'idle',
            },
            snapshot: {
              ...snapshots.terraform,
              id,
              target: { agent: 'claude', sessionRef: id, projectId: infra.main },
              capabilities: claudeCaps,
              codingState: 'idle',
              codingMessages: [],
            },
            screen: `${B}\x1b[36m✳ Claude Code${R} ${D}v2.1.300 · ~/Projects/infra · main${R}\r\n\r\n${B}>${R} `,
          });
          await sleep(1200);
        },
      },
      {
        id: 'move',
        min: 13,
        caption:
          'A Claude session you started in your own terminal? Move it into Gloss with all its history, and keep working on it from here.',
        run: async (d, page, ctl) => {
          await ctl('terminal-write', { launchId: 'L-onboarding', text: onboardingScreen });
          await d.click(folderRow(page, 'mobile-app'), { settle: 1000 });
          await d.click(page.getByText(/Connect this session to Gloss/).first(), { settle: 900 });
          const connect = page.locator('.claude-connection');
          await d.click(connect.getByRole('button', { name: 'Move to Gloss', exact: true }), {
            settle: 900,
          });
          const popover = connect.getByRole('dialog', { name: 'Move to Gloss' });
          await d.hover(popover.getByText(/Claude in the other terminal will close/), 1200);
          await d.click(popover.getByRole('button', { name: 'Move', exact: true }), {
            settle: 1200,
            native: true,
          });
          await d.hover(page.getByText('This session now runs in Gloss.').first(), 1200);
        },
      },
      {
        id: 'assistant',
        min: 18,
        caption:
          'And when you want to think first: the Language Assistant discusses the task with you in Hebrew, then prepares a sharper instruction that you review before it goes to the agent.',
        run: async (d, page) => {
          await d.click(folderRow(page, 'login-redirect'), { settle: 1000 });
          await d.type(composer(page), 'תוסיף בדיקה למקרה ש-next ריק ותריץ שוב את הבדיקות');
          await sleep(300);
          await d.click(page.getByRole('button', { name: 'Discuss first', exact: true }), {
            settle: 1500,
          });
          await d.hover(page.getByText('Language assistant · Hebrew reply').first(), 900);
          await d.click(page.getByRole('button', { name: 'Add to answer', exact: true }).last(), {
            settle: 500,
          });
          await d.click(page.getByRole('button', { name: 'Prepare instruction', exact: true }), {
            settle: 1200,
          });
          await dialog(page, 'Review instruction').waitFor();
          await d.hover(
            dialog(page, 'Review instruction').getByText('Review and edit in Hebrew'),
            1500,
          );
          await d.click(
            dialog(page, 'Review instruction').getByRole('button', { name: /^Send to Terminal/ }),
            { settle: 1500 },
          );
        },
      },
      {
        id: 'end',
        min: 6,
        caption: '',
        voice:
          'Gloss is open source, runs on the accounts you already have, and everything stays on your computer. The link is in the description.',
        run: async (d, page) => {
          await page.keyboard.press('Escape');
          await sleep(300);
          await endCard(d);
        },
      },
    ],
  },

  install: {
    scenario: 'install',
    port: 4197,
    scenes: [
      {
        id: 'title',
        min: 4,
        caption: '',
        voice: 'Here is how to install Gloss and run your first session.',
        run: (d) => titleCard(d, 'Install and first session'),
      },
      {
        id: 'requirements',
        min: 8,
        caption:
          'You need macOS 13 or newer, or Linux, with Codex CLI or Claude Code installed and signed in, plus ripgrep for file search.',
        run: (d) =>
          d.card(
            `<h2>What you need</h2><ul><li>macOS 13 or newer (Apple Silicon or Intel), or Linux x64 / arm64</li><li>Codex CLI and/or Claude Code, installed and signed in</li><li>ripgrep for file search: brew install ripgrep</li></ul>`,
          ),
      },
      {
        id: 'brew',
        min: 12,
        caption:
          'With Homebrew, one command installs the build for your chip. Later versions arrive with brew upgrade.',
        run: (d) =>
          d.terminal('Terminal', [
            { typed: true, text: 'brew install --cask kfirosb/tap/gloss' },
            {
              text: '==> Downloading https://github.com/kfirosb/gloss/releases/download/v0.19.0/Gloss-0.19.0-arm64.dmg',
              cls: 'c',
            },
            { text: '==> Installing Cask gloss', cls: 'c' },
            { text: "==> Moving App 'Gloss.app' to '/Applications/Gloss.app'", cls: 'c' },
            { text: '🍺  gloss was successfully installed!', cls: 'ok', gap: 900 },
            { typed: true, text: 'brew upgrade --cask gloss   # later, for new versions' },
          ]),
      },
      {
        id: 'dmg',
        min: 10,
        caption:
          'Or download the DMG from GitHub Releases and drag Gloss into Applications. Releases are signed and notarized. On Linux, install the deb or run the AppImage.',
        run: (d) =>
          d.card(
            `<h2>Or by hand</h2><div class="row"><div class="tile"><b>1 · GitHub Releases</b><span>Gloss-0.19.0-arm64.dmg<br>Gloss-0.19.0-x64.dmg</span></div><div class="tile"><b>2 · Drag into Applications</b><span>Signed and notarized. No warnings.</span></div><div class="tile"><b>Linux</b><span>sudo apt install ./Gloss-0.19.0-amd64.deb<br>or the AppImage</span></div></div>`,
          ),
      },
      {
        id: 'connect',
        min: 10,
        caption:
          'On first launch Gloss is empty. Connect a folder: search by name or paste a path. Git repositories and plain folders both work.',
        run: async (d, page) => {
          await d.hideCard();
          await sleep(600);
          await d.click(page.getByRole('button', { name: 'Connect folder' }), { settle: 700 });
          await d.type(page.getByLabel('Search folders'), 'web', 90);
          await sleep(900);
          await d.click(dialog(page, 'Connect a folder').getByRole('option', { name: /webshop/ }), {
            settle: 1000,
          });
          await d.hover(page.getByRole('button', { name: /^Collapse webshop/ }), 800);
        },
      },
      {
        id: 'codex',
        min: 14,
        caption:
          'Start Codex in your terminal as usual and ask something. Within a few seconds the session appears in Gloss, and every finished reply arrives translated.',
        run: async (d, page, ctl) => {
          await d.terminal('Terminal — webshop', [
            { typed: true, text: 'cd ~/Projects/webshop && codex' },
            {
              text: 'OpenAI Codex (v0.158.0)   model: gpt-5-codex   directory: ~/Projects/webshop',
              cls: 'c',
              gap: 700,
            },
            { typed: true, prompt: '› ', text: 'What does this repo do? Keep it short.' },
          ]);
          await sleep(600);
          const project = '/Users/dana/Projects/webshop';
          const first = {
            id: 'first',
            target: { agent: 'codex', sessionRef: 'first', projectId: project },
            canonicalRoot: project,
            projectName: 'webshop',
            projectKey: project + '/.git',
            branch: 'main',
            worktreePath: project,
            sessionTitle: 'What does this repo do?',
            activity: 'working',
            open: true,
            enabled: true,
          };
          await ctl('add-session', {
            session: first,
            snapshot: {
              id: 'first',
              target: first.target,
              codingState: 'working',
              capabilities: codexCaps,
              language: 'he',
              languageSettings,
              languageSessionId: 'lang-first',
              languageModel: 'default',
              sourceRevision: 1,
              deliveries: [],
              discussion: [],
              codingMessages: [
                {
                  sourceId: 'f1',
                  revision: 1,
                  role: 'user',
                  text: 'What does this repo do? Keep it short.',
                  complete: true,
                  timestamp: ts(0),
                },
              ],
            },
          });
          await d.hideCard();
          await sleep(1200);
          await d.click(page.getByRole('tab', { name: /What does this repo do/ }), {
            settle: 1200,
          });
          await ctl('push-message', {
            id: 'first',
            activity: 'idle',
            message: {
              sourceId: 'f2',
              revision: 2,
              role: 'assistant',
              text: 'webshop is a small Next.js storefront: a product catalog, a cart, and checkout backed by a Node API with Postgres. Tests run with Vitest and Playwright.',
              complete: true,
              timestamp: ts(0),
              translatedText:
                'webshop היא חנות קטנה ב‑Next.js: קטלוג מוצרים, עגלה ו‑checkout שמאחוריהם API ב‑Node עם Postgres. הבדיקות רצות עם Vitest ו‑Playwright.',
              translationStatus: 'complete',
            },
          });
          await sleep(900);
          await d.hover(page.getByText('Coding agent · translated').first(), 1200);
        },
      },
      {
        id: 'write',
        min: 15,
        caption:
          'Write in Hebrew. Discuss first and Prepare instruction turn it into a concise English instruction that you review before sending.',
        run: async (d, page) => {
          await d.type(
            composer(page),
            'תוסיף אימות לשדה האימייל בטופס ההרשמה, עם הודעת שגיאה ברורה',
          );
          await sleep(300);
          await d.click(page.getByRole('button', { name: 'Discuss first', exact: true }), {
            settle: 1200,
          });
          await d.click(page.getByRole('button', { name: 'Add to answer', exact: true }).last(), {
            settle: 500,
          });
          await d.click(page.getByRole('button', { name: 'Prepare instruction', exact: true }), {
            settle: 1000,
          });
          await dialog(page, 'Review instruction').waitFor();
          await d.hover(
            dialog(page, 'Review instruction').getByText('Review and edit in Hebrew'),
            800,
          );
        },
      },
      {
        id: 'sent',
        min: 10,
        caption: 'Send to Terminal delivers it. Codex works, and the answer comes back in Hebrew.',
        run: async (d, page, ctl) => {
          await d.click(
            dialog(page, 'Review instruction').getByRole('button', { name: /^Send to Terminal/ }),
            { settle: 1500 },
          );
          await ctl('agent-reply', { id: 'first' });
          await sleep(1200);
          await d.hover(page.getByText('SignUpForm').first(), 1200);
        },
      },
      {
        id: 'claude',
        min: 12,
        caption:
          'For Claude Code, open a new session from the plus button and pick Claude. Gloss starts it in the background and connects it. The first time, follow the setup and consent steps the app shows.',
        run: async (d, page) => {
          await d.click(page.getByRole('button', { name: 'New session' }), { settle: 900 });
          const dlg = dialog(page, 'New session');
          await d.hover(dlg.getByRole('radio', { name: 'Claude' }), 900);
          await d.hover(dlg.getByText('Claude opens in the background'), 1000);
          await d.hover(dlg.getByRole('button', { name: 'Open session' }), 900);
        },
      },
      {
        id: 'settings',
        min: 11,
        caption:
          'In Settings you pick the languages: what you write in, what the agent receives, and what replies are shown in. Translation can be switched off per session.',
        run: async (d, page) => {
          await page.keyboard.press('Escape');
          await sleep(400);
          await d.click(page.getByRole('button', { name: 'Settings', exact: true }), {
            settle: 900,
          });
          const dlg = dialog(page, 'Settings');
          await d.hover(dlg.getByText('Languages', { exact: true }).first(), 900);
          await d.hover(dlg.getByText('I write in').first(), 800);
          await d.hover(dlg.getByText('Show agent replies in').first(), 800);
        },
      },
      {
        id: 'end',
        min: 6,
        caption: '',
        voice: 'That is it. The links are in the description.',
        run: async (d, page) => {
          await page.keyboard.press('Escape');
          await sleep(300);
          await endCard(d);
        },
      },
    ],
  },
};
