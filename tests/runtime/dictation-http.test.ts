import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { startServer } from '../../src/runtime/http-server.js';
import { createApplication } from '../../src/runtime/application.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';
import type { DictationBridge } from '../../src/runtime/dictation/bridge.js';

// The same construction tests/runtime/sidebar-http.test.ts uses.
const applicationOptions = () => ({
  store: new SqliteStore(':memory:'),
  agents: [new FakeAgent()],
  conversationId: 'A',
  capability: 'cap',
  languageBackends: {
    codex: { open: vi.fn(async () => new FakeLanguageSession()), models: async () => [] },
  },
});

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});
function fakeBridge() {
  const upgrades: string[] = [];
  const bridge: DictationBridge = {
    status: async () => ({
      available: false,
      reason: 'engine-missing',
      model: { present: false },
      engine: 'stopped',
    }),
    cancelDownload: vi.fn(),
    handleUpgrade: (req, socket) => {
      upgrades.push(req.url ?? '');
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
    },
    close: vi.fn(),
  };
  return { bridge, upgrades };
}
it('exposes dictation status and cancel behind the capability, and routes audio upgrades to the bridge', async () => {
  const { bridge, upgrades } = fakeBridge();
  const application = createApplication({ ...applicationOptions(), dictation: bridge });
  const server = await startServer(application, { port: 0 });
  closers.push(
    () => server.close(),
    () => application.close(),
  );
  const origin = new URL(server.url).origin;
  const headers = { Authorization: 'Bearer ' + application.capability };
  expect((await fetch(origin + '/api/dictation')).status).toBe(401);
  const status = await fetch(origin + '/api/dictation', { headers });
  expect(status.status).toBe(200);
  expect(await status.json()).toEqual({
    available: false,
    reason: 'engine-missing',
    model: { present: false },
    engine: 'stopped',
  });
  const cancel = await fetch(origin + '/api/dictation/model/cancel', { method: 'POST', headers });
  expect(cancel.status).toBe(200);
  expect(bridge.cancelDownload).toHaveBeenCalled();
  const ws = new WebSocket(
    origin.replace('http', 'ws') + '/api/dictation/audio?capability=x&session=s&language=he',
  );
  await new Promise<void>((r) => {
    ws.once('unexpected-response', () => r());
    ws.once('error', () => r());
  });
  expect(upgrades[0]).toMatch(/^\/api\/dictation\/audio\?/);
  await application.close();
  expect(bridge.close).toHaveBeenCalled();
});
it('answers 404 for dictation routes when no bridge is configured', async () => {
  const application = createApplication(applicationOptions());
  const server = await startServer(application, { port: 0 });
  closers.push(
    () => server.close(),
    () => application.close(),
  );
  const r = await fetch(new URL('/api/dictation', server.url), {
    headers: { Authorization: 'Bearer ' + application.capability },
  });
  expect(r.status).toBe(404);
});
