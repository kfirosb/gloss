// Demo API for the guide videos. Serves every /api route from invented data with real, long-lived SSE streams
// and a WebSocket terminal, proxies everything else to the vite dev server, and takes scene control messages on
// /__demo/<op>. Usage: node demo-server.mjs <port> <vitePort> <scenario: guide|install>
import http from 'node:http';
import { WebSocketServer } from 'ws';
import {
  folders as guideFolders,
  worktreesByKey,
  languageSettings,
  ts,
  demoFiles,
} from './demo-data.mjs';

const [port, vitePort, scenario] = [
  Number(process.argv[2] ?? 4198),
  Number(process.argv[3] ?? 4199),
  process.argv[4] ?? 'guide',
];
const clone = (v) => JSON.parse(JSON.stringify(v));

const state = {
  sessions: [],
  folders: scenario === 'guide' ? clone(guideFolders) : [],
  snapshots: {},
  sequences: {},
  catalogSequence: 1,
  launches: [],
  starting: [], // catalog entries for launches that have no session yet
  terminals: [],
  screens: {}, // launchId -> text already shown in the terminal
  moves: {}, // sessionId -> ClaudeMoveStatus
  channels: {}, // sessionId -> channel state
  searchHits: [],
  workspaces: {},
};

const usage = () => ({
  claude: {
    provider: 'claude',
    observedAt: Date.now(),
    fiveHour: { usedFraction: 0.31, resetsAt: Date.now() + 3 * 3600_000 },
    sevenDay: { usedFraction: 0.44, resetsAt: Date.now() + 4 * 86400_000 },
  },
  codex: {
    provider: 'codex',
    observedAt: Date.now(),
    fiveHour: { usedFraction: 0.12, resetsAt: Date.now() + 2 * 3600_000 },
    sevenDay: { usedFraction: 0.27, resetsAt: Date.now() + 5 * 86400_000 },
  },
});
const entryFor = (s) => ({
  key: s.id,
  sessionId: s.id,
  target: s.target,
  projectKey: s.projectKey,
  projectName: s.projectName,
  sessionTitle: s.sessionTitle,
  worktreePath: s.worktreePath,
  branch: s.branch,
  open: s.open,
  activity: s.activity,
  availability: 'available',
  ...(s.latestResponseSequence ? { latestResponseSequence: s.latestResponseSequence } : {}),
  ...(s.launchId ? { launchId: s.launchId, launchState: s.launchState ?? 'running' } : {}),
  attention: s.activity === 'approval-required' ? 'approval' : (s.attention ?? 'none'),
});
const catalog = () => ({
  epoch: 'demo',
  sequence: state.catalogSequence,
  discovery: { state: 'healthy' },
  terminals: state.terminals,
  entries: [...state.sessions.map(entryFor), ...state.starting],
  usage: usage(),
});

// Streams
const catalogClients = new Set();
const sessionClients = new Map(); // id -> Set(res)
const terminalSockets = new Map(); // launchId -> Set(ws)
const sse = (res, payload) => res.write('data: ' + JSON.stringify(payload) + '\n\n');
function openStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  res.write(':ok\n\n');
  const ping = setInterval(() => res.write(':ping\n\n'), 15000);
  req.on('close', () => clearInterval(ping));
}
function publishCatalog() {
  state.catalogSequence++;
  for (const res of catalogClients) sse(res, catalog());
}
const sessionFrame = (id) => ({
  sessionId: id,
  sequence: state.sequences[id],
  snapshot: state.snapshots[id],
});
function publishSession(id) {
  state.sequences[id]++;
  for (const res of sessionClients.get(id) ?? []) sse(res, sessionFrame(id));
}
function terminalWrite(launchId, text) {
  state.screens[launchId] = (state.screens[launchId] ?? '') + text;
  for (const ws of terminalSockets.get(launchId) ?? []) ws.send(text);
}
function setSessionActivity(id, activity, patch = {}) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  Object.assign(s, { activity, ...patch });
  publishCatalog();
}

// Scripted language assistant replies, prepared instructions and agent answers, per session.
const scripted = {
  login: {
    discussReply:
      'הבנתי. ההוראה תבקש להוסיף בדיקה למקרה ש‑`next` ריק (שצריך להפנות ל‑`/`), ואז להריץ שוב את חבילת ה‑auth. רוצים שאכין אותה?',
    localizedText: 'תוסיף בדיקה למקרה ש‑next ריק ומפנה ל‑/, ותריץ שוב את חבילת ה‑auth.',
    englishText:
      'Add a test for an empty `next` value (it should redirect to `/`), then rerun the auth suite.',
    agentReply: {
      text: 'Added `redirects to / when next is empty` to `login.test.ts`. The auth suite passes: 49 tests.',
      translatedText:
        'הוספתי את הבדיקה `redirects to / when next is empty` ל‑`login.test.ts`. חבילת ה‑auth עוברת: 49 בדיקות.',
    },
  },
  checkout: {
    composerEnglish: 'Also add a test where the same customer sends two checkouts at once.',
    agentReply: {
      text: 'Added `rejects a double submit from the same customer` next to the concurrent test. Both pass, and the full checkout suite is green: 31 tests.',
      translatedText:
        'הוספתי את הבדיקה `rejects a double submit from the same customer` ליד בדיקת המקביליות. שתיהן עוברות, וכל חבילת ה‑checkout ירוקה: 31 בדיקות.',
    },
  },
  terraform: {
    agentReply: {
      text: 'The network module is done: 64 resources moved with `moved` blocks, and `terraform plan` in staging shows no changes. The plan is in `docs/migration-plan.md` and the plan report in `docs/plan-report.html`.',
      translatedText:
        'מודול הרשת מוכן: 64 משאבים הועברו עם בלוקי `moved`, ו‑`terraform plan` ב‑staging לא מראה שינויים. התוכנית ב‑`docs/migration-plan.md` ודוח ה‑plan ב‑`docs/plan-report.html`.',
    },
  },
  first: {
    discussReply:
      'ההוראה תבקש מ‑Codex להוסיף אימות לשדה האימייל בטופס ההרשמה ולהחזיר הודעת שגיאה ברורה. רוצים שאכין אותה?',
    localizedText: 'תוסיף אימות לשדה האימייל בטופס ההרשמה, עם הודעת שגיאה ברורה.',
    englishText:
      'Add validation to the email field of the sign-up form and show a clear error message.',
    agentReply: {
      text: 'Done. `SignUpForm` now validates the email with a simple RFC-style check and shows "Enter a valid email address" under the field. Added two tests.',
      translatedText:
        'סיימתי. `SignUpForm` מאמת עכשיו את האימייל בבדיקה פשוטה בסגנון RFC ומציג "Enter a valid email address" מתחת לשדה. נוספו שתי בדיקות.',
    },
  },
};

function handleAction(id, action) {
  const snap = state.snapshots[id];
  const session = state.sessions.find((s) => s.id === id);
  const script = scripted[id] ?? scripted.first;
  let extra = {};
  switch (action.type) {
    case 'discuss': {
      snap.discussion.push({
        id: 'u' + Date.now(),
        role: 'user',
        text: action.text,
        complete: true,
      });
      snap.discussion.push({
        id: 'a' + Date.now(),
        role: 'assistant',
        text: script.discussReply,
        complete: true,
      });
      break;
    }
    case 'prepare': {
      snap.currentDraft = {
        id: 'draft-' + id,
        revision: 1,
        target: snap.target,
        sourceRevision: snap.sourceRevision,
        language: 'he',
        localizedText: script.localizedText,
        englishText: script.englishText,
        selectedDiscussion: action.indices,
      };
      extra = { review: snap.currentDraft };
      break;
    }
    case 'send-review': {
      snap.deliveries = [
        {
          id: 'r-' + Date.now(),
          draftId: action.draftId,
          revision: action.revision,
          target: snap.target,
          state: 'sent',
          englishText: script.englishText,
          transport: snap.target.agent === 'claude' ? 'tmux' : 'tmux',
        },
      ];
      delete snap.currentDraft;
      const rev = snap.codingMessages.length + 1;
      snap.codingMessages.push({
        sourceId: 'sent-' + rev,
        revision: rev,
        role: 'user',
        text: script.englishText,
        complete: true,
        timestamp: ts(0),
      });
      snap.codingState = 'working';
      setSessionActivity(id, 'working');
      break;
    }
    case 'send-composer': {
      // The real server translates the Hebrew; the demo uses the scripted English and types it into the terminal.
      const english = script.composerEnglish ?? action.text;
      snap.deliveries = [
        {
          id: 'c-' + Date.now(),
          draftId: 'composer-' + action.requestId,
          revision: 1,
          target: snap.target,
          state: 'sent',
          englishText: english,
          transport: 'tmux',
        },
      ];
      if (session?.launchId) typeIntoTerminal(session.launchId, english);
      break;
    }
    case 'reset-instruction':
    case 'discard':
      delete snap.currentDraft;
      break;
    default:
      break;
  }
  state.sequences[id]++;
  for (const res of sessionClients.get(id) ?? []) sse(res, sessionFrame(id));
  return { sessionId: id, sequence: state.sequences[id], snapshot: snap, ...extra };
}
function typeIntoTerminal(launchId, text) {
  let i = 0;
  const tick = () => {
    if (i < text.length) {
      terminalWrite(launchId, text[i++]);
      setTimeout(tick, 18);
    } else terminalWrite(launchId, '\r\n');
  };
  setTimeout(tick, 250);
}

// Scene control operations
const ops = {
  'set-search-hits': ({ hits }) => {
    state.searchHits = hits;
  },
  'add-session': ({ session, snapshot, screen }) => {
    state.sessions.push(session);
    state.snapshots[session.id] = snapshot;
    state.sequences[session.id] = 1;
    if (screen && session.launchId) state.screens[session.launchId] = screen;
    publishCatalog();
  },
  'set-activity': ({ id, activity, patch }) => setSessionActivity(id, activity, patch),
  'set-move': ({ id, status }) => {
    state.moves[id] = status;
  },
  'set-channel': ({ id, channel }) => {
    state.channels[id] = channel;
  },
  'terminal-write': ({ launchId, text }) => terminalWrite(launchId, text),
  'push-message': ({ id, message, activity }) => {
    const snap = state.snapshots[id];
    const existing = snap.codingMessages.findIndex((m) => m.sourceId === message.sourceId);
    if (existing >= 0) snap.codingMessages[existing] = message;
    else snap.codingMessages.push(message);
    if (activity) snap.codingState = activity;
    snap.sourceRevision = message.revision;
    publishSession(id);
    if (activity)
      setSessionActivity(
        id,
        activity,
        message.role === 'assistant' && message.complete
          ? { latestResponseSequence: message.revision, attention: 'response' }
          : {},
      );
  },
  'agent-reply': ({ id }) => {
    const snap = state.snapshots[id];
    const script = scripted[id] ?? scripted.first;
    const rev = snap.codingMessages.length + 1;
    const message = {
      sourceId: 'reply-' + rev,
      revision: rev,
      role: 'assistant',
      text: script.agentReply.text,
      complete: true,
      timestamp: ts(0),
      translatedText: script.agentReply.translatedText,
      translationStatus: 'complete',
    };
    ops['push-message']({ id, message, activity: 'idle' });
  },
  'launch-connected': ({ launchId, session, snapshot, screen }) => {
    state.starting = state.starting.filter((e) => e.launchId !== launchId);
    ops['add-session']({ session, snapshot, screen });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const json = (body, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const body = async () => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString();
    return text ? JSON.parse(text) : {};
  };
  try {
    if (p.startsWith('/__demo/')) {
      const op = ops[p.slice('/__demo/'.length)];
      if (!op) return json({ error: 'unknown op' }, 404);
      op(await body());
      return json({ ok: true });
    }
    if (!p.startsWith('/api/')) return proxy(req, res);
    if (p === '/api/session-catalog') return json(catalog());
    if (p === '/api/session-catalog/events') {
      openStream(req, res);
      sse(res, catalog());
      catalogClients.add(res);
      req.on('close', () => catalogClients.delete(res));
      return;
    }
    if (p === '/api/snapshot') {
      const first = state.sessions[0]?.id;
      return json({
        sequence: 1,
        snapshot: first
          ? state.snapshots[first]
          : {
              id: '',
              codingState: 'idle',
              codingMessages: [],
              discussion: [],
              deliveries: [],
              language: 'he',
              languageSessionId: '',
              languageModel: 'default',
              sourceRevision: 0,
            },
      });
    }
    if (p === '/api/session-catalog/seen') return json({ ok: true });
    if (p === '/api/usage/refresh') return json(usage());
    if (p === '/api/about')
      return json({
        name: 'language-assistant',
        version: '0.19.0',
        platform: 'darwin',
        arch: 'arm64',
      });
    if (p === '/api/folders') {
      if (req.method === 'GET') return json(state.folders);
      if (req.method === 'POST') {
        const { path } = await body();
        const name = path.split('/').pop();
        const folder = {
          path,
          projectKey: path + '/.git',
          projectName: name,
          branch: 'main',
          missing: false,
          kind: 'main',
          createdByApp: false,
          connectedAt: Date.now(),
        };
        state.folders.push(folder);
        return json(folder);
      }
      return json({});
    }
    if (p === '/api/folders/search') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return json({
        hits: state.searchHits.filter((h) => h.name.toLowerCase().includes(q)),
        timedOut: false,
        unavailable: false,
      });
    }
    if (p.startsWith('/api/projects/') && p.endsWith('/worktrees')) {
      const key = decodeURIComponent(p.split('/')[3]);
      return json({
        hasCommits: true,
        worktrees: worktreesByKey[key] ?? [
          {
            path: key.replace(/\/\.git$/, ''),
            branch: 'main',
            main: true,
            detached: false,
            locked: false,
            prunable: false,
          },
        ],
      });
    }
    if (p === '/api/settings/sidebar')
      return json(
        req.method === 'PUT'
          ? await body()
          : { order: [], hidden: [], collapsed: [], worktreeLocation: {} },
      );
    if (p === '/api/settings/language')
      return json(req.method === 'PUT' ? await body() : languageSettings);
    if (p === '/api/settings/launch')
      return json({ extraArgs: { claude: [], codex: [] }, popup: 'ask', terminalView: 'popup' });
    if (p === '/api/dictation')
      return json({ available: true, model: { present: true }, engine: 'ready' });
    if (p === '/api/claude/registration') return json({ state: 'registered', scope: 'user' });
    if (p === '/api/launches' && req.method === 'POST') {
      const b = await body();
      const launch = {
        id: 'L' + (state.launches.length + 1),
        ...b,
        panePid: 500 + state.launches.length,
        state: 'starting',
        createdAt: Date.now(),
      };
      state.launches.push(launch);
      const folderPath = Object.values(b).find(
        (v) => typeof v === 'string' && state.folders.some((f) => f.path === v),
      );
      const folder = state.folders.find((f) => f.path === folderPath) ?? state.folders[0];
      state.starting.push({
        key: 'launch:' + launch.id,
        target: {
          agent: b.agent === 'codex' ? 'codex' : 'claude',
          sessionRef: '',
          projectId: folder.path,
        },
        projectKey: folder.projectKey,
        projectName: folder.projectName,
        worktreePath: folder.path,
        branch: folder.branch,
        open: true,
        activity: 'connecting',
        availability: 'available',
        launchId: launch.id,
        launchState: 'starting',
      });
      publishCatalog();
      return json(launch);
    }
    if (p.startsWith('/api/launches/') && p.endsWith('/terminal-ticket'))
      return json({ ticket: 'demo', expiresAt: Date.now() + 60_000 });
    if (p === '/api/sessions' && req.method === 'GET')
      return json(
        state.sessions.map(
          ({ activity, open, latestResponseSequence, attention, launchState, ...r }) => r,
        ),
      );
    const id = decodeURIComponent(p.split('/')[3] ?? '');
    const snap = state.snapshots[id];
    const session = state.sessions.find((s) => s.id === id);
    if (snap) {
      const tail = p.split('/').slice(4).join('/');
      if (tail === 'workspace') {
        const w = (state.workspaces[id] ??= {
          sessionId: id,
          revision: 0,
          data: {
            composer: '',
            attachmentIds: [],
            selectedDiscussion: [],
            review: null,
            composerAttempt: null,
            layout: {
              mode: 'split',
              order: ['live', 'assistant', 'composer'],
              liveSize: 50,
              discussionSize: 60,
            },
          },
        });
        if (req.method === 'PUT') {
          const b = await body();
          if (b.expectedRevision !== w.revision)
            return json({ code: 'workspace-conflict', current: w }, 409);
          w.revision++;
          w.data = b.data;
        }
        return json(w);
      }
      if (tail === 'snapshot') return json(sessionFrame(id));
      if (tail === 'events') {
        openStream(req, res);
        sse(res, sessionFrame(id));
        if (!sessionClients.has(id)) sessionClients.set(id, new Set());
        sessionClients.get(id).add(res);
        req.on('close', () => sessionClients.get(id)?.delete(res));
        return;
      }
      const outside = snap.target.agent === 'claude' && !session?.launchId;
      if (tail === 'claude-route')
        return json(
          outside
            ? { transport: null, reason: 'Gloss can’t reach this session yet.' }
            : { transport: 'tmux' },
        );
      if (tail === 'claude-channel')
        return json({ state: state.channels[id] ?? (outside ? 'setup-required' : 'connected') });
      if (tail === 'claude-move') {
        if (req.method === 'POST') {
          const request = await body();
          if (request.action === 'move') state.moves[id] = { state: 'in-gloss' };
          return json(state.moves[id] ?? { state: 'in-gloss' });
        }
        return json(
          state.moves[id] ??
            (outside
              ? { state: 'ready', process: { pid: 4242, procStart: 'Mon Oct 20 09:12:00 2026' } }
              : { state: 'in-gloss' }),
        );
      }
      if (tail === 'claude-peer') return json({ state: 'accept' });
      if (tail === 'language') {
        const override = req.method === 'PUT' ? await body() : req.method === 'DELETE' ? {} : {};
        return json({
          defaults: languageSettings,
          override,
          effective: { ...languageSettings, ...override },
        });
      }
      if (tail.startsWith('files/')) {
        const project = demoFiles[snap.target.projectId.split('/').pop()] ?? {
          tree: { '': [] },
          files: {},
          review: {},
        };
        const path = url.searchParams.get('path') ?? '';
        if (tail === 'files/browse') {
          if (process.env.DEMO_DEBUG)
            console.error('[demo] browse', id, JSON.stringify(path), snap.target.projectId);
          return json({ entries: project.tree[path] ?? [], limited: false });
        }
        if (tail === 'files/preview') {
          const text = project.files[path] ?? '';
          return json({
            name: path.split('/').pop(),
            relativePath: path,
            state: 'text',
            text,
            size: text.length,
            version: 'v1',
          });
        }
        if (tail === 'files/review-status') {
          const r = project.review[path];
          return json({ summary: false, translation: false, available: Boolean(r) });
        }
        if (tail === 'files/review') {
          const b = await body();
          await new Promise((r) => setTimeout(r, 350)); // the summary is generated by a model
          return json({ path: b.path, mode: b.mode, text: project.review[b.path]?.[b.mode] ?? '' });
        }
        if (tail === 'files/search' || tail === 'files/find') {
          const q = (url.searchParams.get('q') ?? '').toLowerCase();
          const entries = Object.keys(project.files)
            .filter((f) => f.toLowerCase().includes(q))
            .map((f) => ({ name: f.split('/').pop(), relativePath: f }));
          return json(tail === 'files/search' ? entries : { entries, limited: false });
        }
      }
      if (tail === 'actions') return json(handleAction(id, await body()));
      if (tail.startsWith('activity/')) {
        openStream(req, res);
        return;
      }
      if (tail === 'skills' || tail === 'mcp' || tail.startsWith('inventory'))
        return json({ entries: [] });
    }
    console.log('[demo] unmocked', req.method, p);
    return json({ error: 'not in demo' }, 404);
  } catch (error) {
    console.log('[demo] error', p, error);
    return json({ error: String(error) }, 500);
  }
});
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const m = /^\/api\/launches\/([^/]+)\/terminal$/.exec(url.pathname);
  if (!m) return socket.destroy();
  const launchId = decodeURIComponent(m[1]);
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (!terminalSockets.has(launchId)) terminalSockets.set(launchId, new Set());
    terminalSockets.get(launchId).add(ws);
    ws.send(state.screens[launchId] ?? '');
    ws.on('close', () => terminalSockets.get(launchId)?.delete(ws));
    ws.on('message', () => {}); // keystrokes and resizes are accepted and ignored
  });
});
function proxy(req, res) {
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: vitePort,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: '127.0.0.1:' + vitePort },
    },
    (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (e) => {
    res.writeHead(502);
    res.end(String(e));
  });
  req.pipe(upstream);
}
server.listen(port, '127.0.0.1', () => console.log(`demo ${scenario} on http://127.0.0.1:${port}`));
