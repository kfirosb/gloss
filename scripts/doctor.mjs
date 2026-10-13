#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
async function inspect(executable, args) {
  try {
    const { stdout, stderr } = await exec(executable, args, {
      timeout: 10000, maxBuffer: 1024 * 1024,
      env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
    });
    return { ok: true, text: stdout + stderr };
  } catch { return { ok: false, text: '' }; }
}
const [claudeVersion, codexVersion, supersetVersion, claudeAuth, codexAuth, queue, browser] = await Promise.all([
  inspect('claude', ['--version']), inspect('codex', ['--version']), inspect('superset', ['--version']),
  inspect('claude', ['auth', 'status']), inspect('codex', ['login', 'status']),
  inspect('codex', ['queue', '--help']), inspect('superset', ['browser', '--help']),
]);
let claudeAccount = false;
try { const a = JSON.parse(claudeAuth.text); claudeAccount = a.loggedIn === true && a.authMethod === 'claude.ai'; } catch {}
const version = (result) => result.ok ? result.text.match(/\d+\.\d+\.\d+/)?.[0] ?? 'unknown' : 'unavailable';
console.log(JSON.stringify({
  node: process.versions.node,
  claude: { version: version(claudeVersion), subscriptionLogin: claudeAccount,
    inboxAvailableToLauncher: Boolean(process.env.CLAUDE_CODE_MESSAGING_SOCKET && process.env.CLAUDE_CODE_MESSAGING_TOKEN) },
  codex: { version: version(codexVersion), subscriptionLogin: codexAuth.ok && /ChatGPT/i.test(codexAuth.text), queueAvailable: queue.ok && /--thread/.test(queue.text) },
  superset: { version: version(supersetVersion), workspacePresent: Boolean(process.env.SUPERSET_WORKSPACE_ID), browserCommandAvailable: browser.ok && /--url|\bopen\b/.test(browser.text) },
  note: 'Capability inventory only; this does not test live delivery or print credentials.',
}, null, 2));
