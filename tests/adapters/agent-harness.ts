import { mkdtemp, mkdir, readFile, writeFile, rm, appendFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentEvent, AgentKind, CodingConnection } from '../../src/core/contracts.js';
import { createClaudeAdapter } from '../../src/agents/claude/index.js';
import { createCodexAdapter } from '../../src/agents/codex/index.js';
export const ids = { claude: '11111111-1111-4111-8111-111111111111', codex: '22222222-2222-4222-8222-222222222222' };
export async function harness(kind: AgentKind) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'agent-adapter-')));
  const project = join(dir, 'project'); await mkdir(project);
  const transcript = join(dir, 'session.jsonl');
  const sessionRef = ids[kind];
  const native = await readFile(new URL(`../fixtures/${kind === 'claude' ? 'claude-2.1.273' : 'codex-events-0.154.0'}.jsonl`, import.meta.url), 'utf8');
  const fixture = native.replaceAll(`fixture-${kind}-session`, sessionRef).replaceAll('/fixture/project', project);
  const header = kind === 'codex' ? JSON.stringify({ type: 'session_meta', payload: { id: sessionRef, session_id: sessionRef, cwd: project, cli_version: '0.154.0', source: 'cli', originator: 'codex-tui' } }) + '\n' : '';
  await writeFile(transcript, header + fixture);
  let live = true;
  const observeLive = async () => live;
  let adapter;
  if (kind === 'claude') {
    await mkdir(join(dir, 'sessions'));
    await writeFile(join(dir, 'sessions', 'own.json'), JSON.stringify({ sessionId: sessionRef, cwd: project, pid: process.pid, version: '2.1.273', messagingSocketPath: join(dir, 'inbox.sock'), status: 'idle', peerProtocol: 1 }));
    adapter = createClaudeAdapter({ configDir: dir, transcriptPath: async () => transcript, observeLive, pollMs: 5, pageSize: 1 });
  } else {
    const db = new DatabaseSync(join(dir, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, rollout_path TEXT, cli_version TEXT)');
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run(sessionRef, project, transcript, '0.154.0'); db.close();
    adapter = createCodexAdapter({ codexHome: dir, observeLive, pollMs: 5, pageSize: 1 });
  }
  return { kind, dir, project, transcript, sessionRef, adapter, fixture, header,
    target: { agent: kind, sessionRef, projectId: project }, setLive(value: boolean) { live = value; },
    async appendMessage(text = 'later', id = 'later-message') {
      const record = kind === 'claude' ? { type: 'assistant', uuid: id, sessionId: sessionRef, cwd: project, version: '2.1.273', message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } } : { type: 'event_msg', payload: { type: 'item_completed', thread_id: sessionRef, item: { type: 'AgentMessage', phase: 'final_answer', id, content: [{ type: 'Text', text }] } } };
      await appendFile(transcript, JSON.stringify(record) + '\n');
    },
    async cleanup() { await rm(dir, { recursive: true, force: true }); },
  };
}
export function watch(connection: CodingConnection) {
  const controller = new AbortController(); const events: AgentEvent[] = [];
  const done = (async () => { for await (const event of connection.events(controller.signal)) events.push(event); })();
  return { events, async stop() { controller.abort(); await connection.detach(); await done; } };
}
