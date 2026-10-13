#!/usr/bin/env node
// Explicit, disposable account-backed verification. Never targets the user's panel.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, realpath, symlink, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { inspectSse, readOptionalWal } from './claude-channel-privacy.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [operation = 'help', inputRoot, mode = 'ordinary', argument] = process.argv.slice(2);
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const cleanEnvironment = () => {
  const env = { ...process.env, PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', DISABLE_AUTOUPDATER: '1' };
  for (const key of Object.keys(env)) if (/SUPERSET|^CLAUDECODE$|^CLAUDE_CODE_MESSAGING_|^CLAUDE_(CODE_)?SESSION_ID$|^CODEX_(THREAD|SESSION)_ID$|^ANTHROPIC_|^OPENAI_|^CLAUDE_CODE_USE_/.test(key) || /superset/i.test(env[key] ?? '')) delete env[key];
  return env;
};
const loadModule = (root, name) => import(pathToFileURL(join(root, 'dist/server', name + '.js')).href);
const fingerprint = async path => {
  try { return createHash('sha256').update(await readFile(path)).digest('hex'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

async function prepare() {
  const root = await realpath(await mkdtemp('/tmp/la-channel-e2e.'));
  await save(join(root, 'package.json'), { type: 'module' });
  await symlink(join(repo, 'node_modules'), join(root, 'node_modules'));
  // The actual source build pipeline, with ONLY output destinations changed.
  execFileSync(join(repo, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.server.json', '--outDir', join(root, 'dist/server')], { cwd: repo, stdio: 'inherit' });
  execFileSync(join(repo, 'node_modules/.bin/vite'), ['build', '--outDir', join(root, 'dist/ui')], { cwd: repo, stdio: 'inherit' });
  const stateDir = join(root, 'state'); await mkdir(stateDir, { mode: 0o700 });
  const claudePath = await realpath(join(homedir(), '.local/bin/claude'));
  const config = { root, stateDir, claudePath, targets: [], settings: {} };
  for (const path of [join(homedir(), '.claude/settings.json'), join(homedir(), '.claude/settings.local.json')]) config.settings[path] = await fingerprint(path);
  const cliPath = join(root, 'channel wrapper.mjs');
  await writeFile(cliPath, `import {startClaudeChannel} from ${JSON.stringify(pathToFileURL(join(root, 'dist/server/agents/claude/channel-server.js')).href)};\nawait startClaudeChannel({stateDir:${JSON.stringify(stateDir)}});\n`, { mode: 0o600 });
  const { createClaudeChannelSetup } = await loadModule(root, 'runtime/claude-channel-setup');
  const setup = createClaudeChannelSetup({ stateDir, cliPath, claudePath });
  for (const kind of ['ordinary', 'bypass']) {
    const projectId = join(root, kind, "same project's name"); await mkdir(projectId, { recursive: true });
    const target = { agent: 'claude', projectId, sessionRef: randomUUID() };
    const fresh = await setup.createChannelSetup(undefined, projectId);
    const resume = await setup.createChannelSetup(target);
    assert(fresh.command.startsWith('cd ' + quote(projectId) + ' && '));
    assert(resume.command.includes("'--resume' " + quote(target.sessionRef)));
    assert(!/--strict-mcp-config|--setting-sources/.test(fresh.command + resume.command));
    const isolation = ['--setting-sources', '', '--strict-mcp-config', '--tools', '', '--disable-slash-commands', '--model', 'haiku', '--name', 'channel-e2e', ...(kind === 'bypass' ? ['--dangerously-skip-permissions'] : [])].map(quote).join(' ');
    const prompt = quote('Reply with READY only. Do not use tools.');
    config.targets.push({ kind, target, generatedNew: fresh.command, generatedResume: resume.command,
      launch: fresh.command.slice(0, -prompt.length) + isolation + ' --session-id ' + quote(target.sessionRef) + ' ' + prompt,
      resume: resume.command + ' ' + isolation });
  }
  await save(join(root, 'config.json'), config);
  console.log(JSON.stringify({ root, versions: { node: process.version, sqlite: process.versions.sqlite, platform: process.platform, arch: process.arch,
    claude: execFileSync(claudePath, ['--version'], { env: cleanEnvironment(), encoding: 'utf8' }).trim() }, stagedBuild: true }));
}

async function context() {
  assert(inputRoot && /^\/private\/tmp\/la-channel-e2e\.[^/]+$/.test(await realpath(inputRoot)), 'Expected a private probe root');
  const config = await read(join(inputRoot, 'config.json'));
  assert.equal(await realpath(inputRoot), config.root);
  const selected = config.targets.find(item => item.kind === mode); assert(selected);
  return { ...config, selected };
}

async function serve(config) {
  // Strip inherited integration state BEFORE discovery, auth, or translation workers.
  const env = cleanEnvironment();
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  process.chdir(config.root);
  const [{ createApplication, SqliteStore }, { createClaudeAdapter }, { ClaudeLanguageBackend }, { startServer }, { createClaudeChannelSetup }] = await Promise.all([
    loadModule(config.root, 'runtime/application'), loadModule(config.root, 'agents/claude/index'), loadModule(config.root, 'language/claude'),
    loadModule(config.root, 'runtime/http-server'), loadModule(config.root, 'runtime/claude-channel-setup'),
  ]);
  const real = createClaudeAdapter({ stateDir: config.stateDir, executable: config.claudePath });
  const permitted = target => config.targets.some(item => item.target.projectId === target.projectId && item.target.sessionRef === target.sessionRef && target.agent === 'claude');
  const scoped = { ...real,
    async discoverOpen(signal) { const result = await real.discoverOpen(signal); return { ...result, candidates: result.candidates.filter(item => permitted(item.target)) }; },
    async discover(project) { return (await real.discover(project)).filter(permitted); },
    async attach(target, ...args) { assert(permitted(target), 'Out-of-scope attachment'); return real.attach(target, ...args); },
  };
  const application = createApplication({ store: new SqliteStore(join(config.stateDir, 'panel.db')), agents: [scoped],
    languageBackends: { claude: new ClaudeLanguageBackend({ executable: config.claudePath }) },
    attachmentRoot: join(config.stateDir, 'attachments'), channelSetup: createClaudeChannelSetup({ stateDir: config.stateDir, claudePath: config.claudePath, cliPath: join(config.root, 'channel wrapper.mjs') }) });
  await application.restore();
  const server = await startServer(application);
  await save(join(config.root, 'browser.json'), { url: server.url, pid: process.pid });
  console.log(JSON.stringify({ ready: true, browserPointer: join(config.root, 'browser.json'), supersetEnvironmentAbsent: !Object.keys(process.env).some(key => /SUPERSET/.test(key)), path: process.env.PATH }));
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await server.close(); await application.close(); process.exit(0); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
}

async function api(config, path, body, method) {
  const { url } = await read(join(config.root, 'browser.json')); const parsed = new URL(url);
  const response = await fetch(new URL(path, url), { method: method ?? (body ? 'POST' : 'GET'), headers: { authorization: 'Bearer ' + new URLSearchParams(parsed.hash.slice(1)).get('capability'), 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(180000) });
  const value = await response.json();
  assert(response.ok, JSON.stringify({ status: response.status, value })); return value;
}
async function panel(config) {
  const sessions = await api(config, '/api/sessions');
  assert(sessions.every(session => config.targets.some(item => item.target.sessionRef === session.target.sessionRef && item.target.projectId === session.target.projectId)), 'Catalog isolation');
  const session = sessions.find(session => session.target.sessionRef === config.selected.target.sessionRef); assert(session, 'Disposable session not yet discovered'); return session;
}
async function record(config) {
  const { createChannelRegistry } = await loadModule(config.root, 'agents/claude/channel-registry');
  const value = await createChannelRegistry({ registryDir: join(config.stateDir, 'claude-channels') }).resolveChannel(config.selected.target);
  assert(value, 'No exact live process/registry/transcript/ready binding'); return value;
}
async function evidence(config) {
  const session = await panel(config); const snapshot = await api(config, `/api/sessions/${session.id}/snapshot`);
  const channel = await record(config);
  const transcript = (await readFile(channel.transcriptPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const inbound = transcript.filter(row => row.type === 'user' && row.origin?.kind === 'channel' && row.origin?.server === 'language-assistant');
  const db = new DatabaseSync(join(config.stateDir, 'claude-channel-ledger.db'), { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000');
  let requests;
  try { requests = db.prepare(`SELECT q.request_id, q.generation, q.text, r.text AS reply FROM requests q LEFT JOIN replies r ON r.request_row_id=q.id WHERE q.native_session_id=?`).all(session.target.sessionRef); }
  finally { db.close(); }
  const wire = JSON.stringify(snapshot);
  const { url: browserURL } = await read(join(config.root, 'browser.json'));
  const eventURL = new URL(`/api/sessions/${session.id}/events`, browserURL);
  const eventResponse = await fetch(eventURL, { headers: { authorization: 'Bearer ' + new URLSearchParams(new URL(browserURL).hash.slice(1)).get('capability') }, signal: AbortSignal.timeout(10000) });
  assert(eventResponse.ok);
  const secrets = [];
  for (const name of await readdir(join(config.stateDir, 'claude-channels'))) {
    if (name.endsWith('.json')) secrets.push((await read(join(config.stateDir, 'claude-channels', name))).token);
  }
  const sseCoverage = await inspectSse(eventResponse, secrets, { expectedSessionId: session.id });
  const dbBytes = await readFile(join(config.stateDir, 'panel.db'));
  const wal = await readOptionalWal(join(config.stateDir, 'panel.db-wal'));
  const result = { mode, nativeSessionId: session.target.sessionRef, panelSessionId: session.id, generation: channel.generation, identityReadyVerified: true,
    state: snapshot.snapshot.codingState, deliveries: snapshot.snapshot.deliveries.map(d => ({ id: d.id, state: d.state, transport: d.transport })),
    inboundCount: inbound.length, requests: requests.map(row => ({ requestId: row.request_id, generation: row.generation, english: JSON.parse(row.text), reply: row.reply === null ? null : JSON.parse(row.reply),
      nativeCount: inbound.filter(message => JSON.stringify(message.message?.content).includes(row.request_id)).length,
      displayCount: snapshot.snapshot.codingMessages.filter(message => message.sourceId === `channel:${row.generation}:${row.request_id}`).length })),
    codingMessages: snapshot.snapshot.codingMessages,
    credentialsAbsentSnapshotAndDB: secrets.every(secret => typeof secret === 'string' && !wire.includes(secret) && !dbBytes.includes(Buffer.from(secret)) && !wal.includes(Buffer.from(secret))),
    sseCoverage,
    credentialsAbsentSSEAndTranscript: secrets.every(secret => !JSON.stringify(transcript).includes(secret)),
    settingsUnchanged: (await Promise.all(Object.entries(config.settings).map(async ([path, hash]) => (await fingerprint(path)) === hash))).every(Boolean) };
  assert(result.credentialsAbsentSnapshotAndDB); assert(result.credentialsAbsentSSEAndTranscript); assert(result.settingsUnchanged);
  for (const request of result.requests) {
    assert.equal(request.nativeCount, 1, 'Exactly one native receipt per emitted request');
    assert.equal(request.displayCount, request.reply === null ? 0 : 1, 'Exactly one channel reply display');
  }
  await save(join(config.root, `evidence-${mode}.json`), result); console.log(JSON.stringify(result, null, 2));
}

if (operation === 'help') console.log('prepare | serve ROOT | launch ROOT ordinary|bypass [resume|reference] | status ROOT MODE | send ROOT MODE REQUEST_ID | evidence ROOT MODE | boundaries ROOT MODE | setup ROOT MODE | duplicate ROOT MODE ORIGINAL_COMPOSER_ID | reference ROOT ordinary | action ROOT MODE PRIVATE_ACTION.json');
else if (operation === 'prepare') await prepare();
else {
  const config = await context();
  if (operation === 'serve') await serve(config);
  else if (operation === 'launch') {
    let command = (argument === 'resume' || argument === 'reference' ? config.selected.resume : config.selected.launch) + (mode === 'ordinary' ? " --permission-mode 'default'" : '');
    if (argument === 'reference') { assert.equal(mode, 'ordinary'); command = command.replace("'--tools' ''", "'--tools' 'Read'"); }
    await save(join(config.root, `actual-launch-${mode}.json`), { command, environmentOverrides: { ENABLE_TOOL_SEARCH: 'false', DISABLE_AUTOUPDATER: '1' }, path: cleanEnvironment().PATH,
      supersetAbsent: !Object.entries(cleanEnvironment()).some(([key, value]) => /superset/i.test(key + '=' + value)) });
    // With all built-ins disabled there is no ToolSearch. Load the sole explicit
    // MCP server's reply tool upfront. This is disposable-harness isolation only.
    const child = spawn('/bin/zsh', ['-f', '-c', command], { env: { ...cleanEnvironment(), ENABLE_TOOL_SEARCH: 'false' }, stdio: 'inherit' });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  } else if (operation === 'evidence') await evidence(config);
  else if (operation === 'status') {
    const session = await panel(config); const snapshot = await api(config, `/api/sessions/${session.id}/snapshot`);
    console.log(JSON.stringify({ target: session.target, panelId: session.id, state: snapshot.snapshot.codingState, channel: await api(config, `/api/sessions/${session.id}/claude-channel`), deliveries: snapshot.snapshot.deliveries, messages: snapshot.snapshot.codingMessages.length }));
  } else if (operation === 'send') {
    assert(argument && /^[a-zA-Z0-9-]+$/.test(argument)); const session = await panel(config);
    console.log(JSON.stringify(await api(config, `/api/sessions/${session.id}/actions`, { type: 'send-composer', requestId: argument, text: `השב דרך כלי התשובה של הערוץ עם המילים שלום עולם והסמן ${argument}. אל תשתמש בכלים אחרים.`, transport: 'channel' })));
  } else if (operation === 'setup') {
    const session = await panel(config); const setup = await api(config, `/api/sessions/${session.id}/claude-channel`, {});
    assert.equal(setup.command, config.selected.generatedResume); console.log(JSON.stringify(setup));
  } else if (operation === 'action') {
    assert(argument && /^[a-zA-Z0-9-]+\.json$/.test(argument));
    const session = await panel(config);
    console.log(JSON.stringify(await api(config, `/api/sessions/${session.id}/actions`, await read(join(config.root, argument)))));
  } else if (operation === 'reference') {
    assert.equal(mode, 'ordinary');
    const session = await panel(config);
    const file = await api(config, `/api/sessions/${session.id}/files/reference`, { relativePath: 'reference.txt' });
    console.log(JSON.stringify(await api(config, `/api/sessions/${session.id}/actions`, { type: 'send-composer', requestId: 'REFERENCE-LIVE',
      text: 'קרא רק את הקובץ המצורף באמצעות Read והשב באמצעות כלי התשובה של הערוץ עם תוכן הקובץ והסמן REFERENCE-LIVE. אל תשתמש בכלים אחרים.', attachmentIds: [file.id], transport: 'channel' })));
  } else if (operation === 'duplicate') {
    const session = await panel(config); const channel = await record(config);
    const snapshot = await api(config, `/api/sessions/${session.id}/snapshot`);
    const delivery = snapshot.snapshot.deliveries.find(d => d.draftId === `composer-${argument}`); assert(delivery);
    const action = { type: 'send-composer', requestId: argument, text: 'This duplicate must not be translated or sent', transport: 'channel' };
    const clicks = await Promise.all([api(config, `/api/sessions/${session.id}/actions`, action), api(config, `/api/sessions/${session.id}/actions`, action)]);
    assert(clicks.every(value => value.snapshot.deliveries.filter(d => d.id === delivery.id).length === 1));
    const response = await fetch(`http://127.0.0.1:${channel.port}/messages`, { method: 'POST', headers: { authorization: 'Bearer ' + channel.token, 'content-type': 'application/json' },
      body: JSON.stringify({ key: { panelSessionId: session.id, nativeSessionId: session.target.sessionRef, generation: delivery.channelGeneration, requestId: delivery.id }, text: delivery.englishText }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).status, 'already-claimed');
    console.log(JSON.stringify({ duplicateClicks: 2, channelDuplicateStatus: 200, requestId: delivery.id }));
  } else if (operation === 'boundaries') {
    const channel = await record(config); const session = await panel(config);
    const url = `http://127.0.0.1:${channel.port}/messages`;
    const body = { key: { panelSessionId: session.id, nativeSessionId: session.target.sessionRef, generation: channel.generation, requestId: 'rejected-boundary' }, text: 'Must never arrive' };
    const post = (token, value, headers = {}) => fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });
    const badAuth = (await post('invalid', body)).status;
    const wrongGeneration = (await post(channel.token, { ...body, key: { ...body.key, generation: randomUUID() } })).status;
    const browserOrigin = (await post(channel.token, body, { origin: 'http://127.0.0.1' })).status;
    assert.equal(badAuth, 401); assert.equal(wrongGeneration, 409); assert.equal(browserOrigin, 403);
    console.log(JSON.stringify({ badAuth, wrongGeneration, browserOrigin }));
  } else throw new Error('Unknown operation');
}
