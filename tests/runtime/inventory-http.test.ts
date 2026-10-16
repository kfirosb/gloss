import { afterEach, expect, it, vi } from 'vitest';
import { createApplication } from '../../src/runtime/application.js';
import { startServer } from '../../src/runtime/http-server.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';
import type { Inventory } from '../../src/agents/inventory.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

it('serves the inventory for the session agent and folder, never from request input', async () => {
  const read = vi.fn(async (agent: 'claude' | 'codex', project: string): Promise<Inventory> => ({
    agent,
    entries: [{ kind: 'skill', name: 'seen', scope: 'project', description: project }],
    problems: [],
  }));
  const store = new SqliteStore(':memory:');
  const app = createApplication({
    store,
    agents: [new FakeAgent()],
    conversationId: 'A',
    capability: 'cap',
    inventory: { read },
    languageBackends: {
      codex: { open: async () => new FakeLanguageSession(), models: async () => [] },
    },
  });
  await app.sessions!.register({ agent: 'codex', sessionRef: 'A', projectId: process.cwd() }, 'A');
  const server = await startServer(app);
  const base = new URL('/api/', server.url);
  cleanup.push(async () => {
    await server.close();
    await app.close();
  });
  const get = (path: string, auth = true) =>
    fetch(new URL(path, base), { headers: auth ? { authorization: 'Bearer cap' } : {} });
  expect((await get('sessions/A/inventory', false)).status).toBe(401);
  expect((await get('sessions/unknown/inventory')).status).toBe(404);
  const response = await get('sessions/A/inventory?project=/etc&agent=claude');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = (await response.json()) as Inventory;
  expect(body.agent).toBe('codex');
  expect(read).toHaveBeenCalledWith('codex', expect.not.stringMatching(/^\/etc/));
  expect(body.entries[0]!.description).toBe(read.mock.calls[0]![1]);
});
