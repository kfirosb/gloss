import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../../src/runtime/application.js';
import { startServer } from '../../src/runtime/http-server.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { createUsageService } from '../../src/runtime/usage.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';
import type { ProviderUsage } from '../../src/core/usage.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const codexUsage: ProviderUsage = {
  provider: 'codex',
  observedAt: 5,
  fiveHour: { usedFraction: 0.95, resetsAt: 1791812736000 },
};

async function setup() {
  const store = new SqliteStore(':memory:');
  const agent = new FakeAgent('codex');
  const language = new FakeLanguageSession();
  const codexHome = await mkdtemp(join(tmpdir(), 'usage-codex-home-'));
  const usage = createUsageService({
    store,
    codexHome,
    now: () => Date.parse('2026-10-14T10:00:00Z'),
  });
  const refreshUsage = vi.fn(async () => {
    usage.observer.usage({
      provider: 'claude',
      observedAt: 9,
      fiveHour: { usedFraction: 0.37, resetsAt: 1791973200000 },
    });
  });
  const open = vi.fn(async () => language);
  const app = createApplication({
    store,
    usage,
    agents: [agent],
    conversationId: 'A',
    capability: 'cap',
    languageBackends: {
      codex: { open, models: async () => [] },
      claude: { open, models: async () => [], refreshUsage },
    },
  });
  await app.sessions!.register({ agent: 'codex', sessionRef: 'A', projectId: process.cwd() }, 'A');
  const server = await startServer(app);
  const base = new URL('/api/', server.url);
  const request = (path: string, method = 'GET', body?: unknown, auth = true) =>
    fetch(new URL(path, base), {
      method,
      headers: {
        ...(auth ? { authorization: 'Bearer cap' } : {}),
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  cleanup.push(async () => {
    await server.close();
    await app.close();
    await rm(codexHome, { recursive: true, force: true });
  });
  return { app, request, open, agent, usage, refreshUsage, codexHome };
}

it("opens each session's language session scoped to the session id", async () => {
  const { open, app } = await setup();
  await app.sessions!.ensure('A');
  expect(open).toHaveBeenCalledWith('gpt-5.6-sol', undefined, { scope: 'A' });
});
it("reports the session's provider usage, spend per scope and model on the session usage route", async () => {
  const { request, usage } = await setup();
  expect((await request('sessions/A/usage', 'GET', undefined, false)).status).toBe(401);
  expect((await request('sessions/missing/usage')).status).toBe(404);
  let report = await (await request('sessions/A/usage')).json();
  expect(report).toMatchObject({
    provider: 'codex',
    model: 'gpt-5.6-sol',
    usage: null,
    spend: { session: null, today: null, allTime: null },
  });
  usage.observer.spend({
    provider: 'codex',
    model: 'gpt-5.6-sol',
    scope: 'A',
    spend: { inputTokens: 30, outputTokens: 4 },
  });
  usage.observer.spend({
    provider: 'codex',
    model: 'gpt-5.6-sol',
    scope: 'B',
    spend: { inputTokens: 1, outputTokens: 1 },
  });
  usage.observer.usage(codexUsage);
  report = await (await request('sessions/A/usage')).json();
  expect(report.usage).toEqual(codexUsage);
  expect(report.spend).toMatchObject({
    session: { inputTokens: 30, outputTokens: 4 },
    today: { inputTokens: 31, outputTokens: 5 },
    allTime: { inputTokens: 31, outputTokens: 5 },
  });
  // (30 × $4 + 4 × $20) / 1M, estimated from the dated table.
  expect(report.spend.session.usd).toBeCloseTo(0.0002, 10);
  usage.observer.spend({
    provider: 'codex',
    model: 'gpt-5.6-sol',
    scope: 'A',
    spend: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 },
  });
  report = await (await request('sessions/A/usage')).json();
  expect(report.spend.session).toMatchObject({ inputTokens: 1_000_030, outputTokens: 4 });
  expect(report.spend.session.usd).toBeCloseTo(4.0002, 10);
});
it('prices all Codex tokens when the popover is read, including tokens recorded before a price was known', async () => {
  const { request, usage } = await setup();
  usage.observer.spend({
    provider: 'codex',
    model: 'unpriced-model',
    scope: 'A',
    spend: { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 },
  });
  usage.observer.spend({
    provider: 'codex',
    model: 'gpt-5.6-sol',
    scope: 'A',
    spend: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 100_000 },
  });
  const report = await (await request('sessions/A/usage')).json();
  // 1M fresh × $4 + 1M cached × $0.40 + 0.1M output × $20, all at the session model's rate.
  expect(report.spend.session.usd).toBeCloseTo(6.4, 10);
  expect(report.spend.allTime.usd).toBeCloseTo(6.4, 10);
  expect(report.prices).toEqual({ input: 4, cachedInput: 0.4, output: 20, asOf: '2026-10-14' });
});
it('publishes usage in the session catalog, including observations from the live agent', async () => {
  const { request, usage, agent, app } = await setup();
  usage.observer.usage({
    provider: 'claude',
    observedAt: 1,
    sevenDay: { usedFraction: 0.2, resetsAt: 3 },
  });
  await expect
    .poll(async () => (await (await request('session-catalog')).json()).usage?.claude?.sevenDay)
    .toEqual({ usedFraction: 0.2, resetsAt: 3 });
  await app.sessions!.ensure('A');
  agent.emit({ type: 'usage', usage: codexUsage });
  await expect.poll(() => app.catalog!.snapshot().usage?.codex).toEqual(codexUsage);
});
it('refreshes Claude through its backend probe and Codex from the newest rollout', async () => {
  const { request, refreshUsage, codexHome } = await setup();
  expect((await request('usage/refresh', 'POST', { provider: 'claude' }, false)).status).toBe(401);
  expect((await request('usage/refresh', 'POST', { provider: 'other' })).status).toBe(400);
  const claude = await (await request('usage/refresh', 'POST', { provider: 'claude' })).json();
  expect(refreshUsage).toHaveBeenCalledTimes(1);
  expect(claude.claude.fiveHour).toEqual({ usedFraction: 0.37, resetsAt: 1791973200000 });
  const day = join(codexHome, 'sessions', '2026', '10', '14');
  await mkdir(day, { recursive: true });
  await writeFile(
    join(day, 'rollout-a.jsonl'),
    JSON.stringify({
      timestamp: '2026-10-14T09:00:00Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: { primary: { used_percent: 50, window_minutes: 300, resets_at: 1791812736 } },
      },
    }) + '\n',
  );
  const codex = await (await request('usage/refresh', 'POST', { provider: 'codex' })).json();
  expect(codex.codex.fiveHour).toEqual({ usedFraction: 0.5, resetsAt: 1791812736000 });
});
