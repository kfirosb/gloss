import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../../src/runtime/application.js';
import { startServer } from '../../src/runtime/http-server.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';
import type { ActivityEvent } from '../../src/core/activity-contracts.js';
import type { CodingConnection } from '../../src/core/contracts.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const call = (id: string, tool: string): ActivityEvent => ({
  kind: 'call',
  call: { id, tool, summary: tool, input: '', position: 1, depth: 1 },
});

class ActivityAgent extends FakeAgent {
  aborted = false;
  constructor(private readonly withActivity: boolean) {
    super('claude');
  }
  override async attach(target: Parameters<FakeAgent['attach']>[0]): Promise<CodingConnection> {
    const connection = await super.attach(target);
    if (!this.withActivity) return connection;
    const agent = this;
    return {
      ...connection,
      activity: {
        async *subagent(_taskId, signal) {
          signal.addEventListener('abort', () => (agent.aborted = true));
          yield call('c1', 'Read');
          yield call('c2', 'Grep');
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
        },
        async outputPath() {
          throw new Error('Output unavailable');
        },
      },
    };
  }
}

async function setup(withActivity: boolean) {
  const agent = new ActivityAgent(withActivity);
  const attachmentRoot = await mkdtemp(join(tmpdir(), 'activity-http-'));
  const app = createApplication({
    attachmentRoot,
    store: new SqliteStore(':memory:'),
    agents: [agent],
    conversationId: 'A',
    capability: 'cap',
    languageBackends: {
      claude: { open: async () => new FakeLanguageSession(), models: async () => [] },
    },
  });
  await app.sessions!.register({ agent: 'claude', sessionRef: 'A', projectId: process.cwd() }, 'A');
  // Seed a running subagent task through the workflow's activity reducer.
  await app.sessions!.ensure('A');
  agent.emit({
    type: 'activity',
    event: {
      kind: 'task-start',
      task: {
        kind: 'subagent',
        id: 'task1',
        description: 'Review',
        position: 0,
        depth: 0,
        status: 'running',
      },
    },
  });
  await waitFor(() => app.sessions!.snapshot('A').snapshot.activity?.tasks.length === 1);
  const server = await startServer(app);
  cleanup.push(async () => {
    await server.close();
    await app.close();
    await rm(attachmentRoot, { recursive: true, force: true });
  });
  const url = (taskId: string) =>
    new URL(`/api/sessions/A/activity/subagents/${taskId}/events`, server.url);
  const get = (taskId: string, signal?: AbortSignal) =>
    fetch(url(taskId), { headers: { authorization: 'Bearer cap' }, ...(signal ? { signal } : {}) });
  return { agent, get };
}

it('streams subagent events as SSE and aborts the source when the client disconnects', async () => {
  const { agent, get } = await setup(true);
  const abort = new AbortController();
  const response = await get('task1', abort.signal);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  const reader = response.body!.getReader();
  let text = '';
  const decoder = new TextDecoder();
  while (!text.includes('"c2"')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  const events = text
    .split('\n\n')
    .filter((part) => part.startsWith('data: '))
    .map((part) => JSON.parse(part.slice(6)));
  expect(events.map((event) => event.call.id)).toEqual(['c1', 'c2']);
  abort.abort();
  await waitFor(() => agent.aborted);
  expect(agent.aborted).toBe(true);
});

it('rejects unknown tasks and connections without activity', async () => {
  const withActivity = await setup(true);
  const unknown = await withActivity.get('unknown');
  expect(unknown.status).toBe(400);
  expect(await unknown.text()).toContain('Unknown task');
  const without = await setup(false);
  const unavailable = await without.get('task1');
  expect(unavailable.status).toBe(400);
  expect(await unavailable.text()).toContain('Activity unavailable');
});

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 300 && !condition(); i++) await new Promise((r) => setTimeout(r, 10));
}
