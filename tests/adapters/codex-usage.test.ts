import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCodexRecord } from '../../src/agents/codex/index.js';
import { readLatestCodexUsage } from '../../src/agents/codex/usage.js';
import { Transcript } from '../../src/agents/shared.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const limits = {
  limit_id: 'codex',
  primary: { used_percent: 95, window_minutes: 300, resets_at: 1791812736 },
  secondary: { used_percent: 43, window_minutes: 10080, resets_at: 1792309531 },
};
const tokenCount = (timestamp: string, rate_limits: unknown = limits) =>
  JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: { type: 'token_count', info: null, rate_limits },
  });

it('turns a token_count record into a usage observation stamped with the record time', () => {
  expect(parseCodexRecord(JSON.parse(tokenCount('2026-10-12T09:45:36Z')), 0, 's')).toEqual({
    usage: {
      provider: 'codex',
      observedAt: Date.parse('2026-10-12T09:45:36Z'),
      fiveHour: { usedFraction: 0.95, resetsAt: 1791812736000 },
      sevenDay: { usedFraction: 0.43, resetsAt: 1792309531000 },
    },
  });
  expect(parseCodexRecord(JSON.parse(tokenCount('2026-10-12T09:45:36Z', null)), 0, 's')).toEqual(
    {},
  );
});
it('emits usage events from the live transcript tail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-usage-'));
  roots.push(root);
  const path = join(root, 'rollout.jsonl');
  await writeFile(path, tokenCount('2026-10-12T09:45:36Z') + '\n');
  const transcript = new Transcript(path, (record, offset) =>
    parseCodexRecord(record, offset, 's'),
  );
  await transcript.initialize();
  expect(transcript.takeInitial()).toEqual([
    {
      type: 'usage',
      usage: expect.objectContaining({
        provider: 'codex',
        fiveHour: { usedFraction: 0.95, resetsAt: 1791812736000 },
      }),
    },
  ]);
});
it('reads the newest rollout that carries rate limits, ignoring older files and files without them', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-home-'));
  roots.push(home);
  const day = join(home, 'sessions', '2026', '10', '12');
  await mkdir(day, { recursive: true });
  await writeFile(
    join(day, 'rollout-old.jsonl'),
    tokenCount('2026-10-12T08:00:00Z', {
      ...limits,
      primary: { ...limits.primary, used_percent: 10 },
    }) + '\n',
  );
  await writeFile(
    join(day, 'rollout-new.jsonl'),
    '{"type":"session_meta","payload":{"id":"x"}}\n' +
      tokenCount('2026-10-12T09:00:00Z') +
      '\n' +
      tokenCount('2026-10-12T09:30:00Z', {
        ...limits,
        primary: { ...limits.primary, used_percent: 96 },
      }) +
      '\n',
  );
  await writeFile(
    join(day, 'rollout-empty.jsonl'),
    '{"type":"session_meta","payload":{"id":"y"}}\n',
  );
  await utimes(
    join(day, 'rollout-old.jsonl'),
    new Date('2026-10-12T08:00:00Z'),
    new Date('2026-10-12T08:00:00Z'),
  );
  await utimes(
    join(day, 'rollout-new.jsonl'),
    new Date('2026-10-12T09:30:00Z'),
    new Date('2026-10-12T09:30:00Z'),
  );
  await utimes(
    join(day, 'rollout-empty.jsonl'),
    new Date('2026-10-12T10:00:00Z'),
    new Date('2026-10-12T10:00:00Z'),
  );
  expect(await readLatestCodexUsage(home)).toEqual({
    provider: 'codex',
    observedAt: Date.parse('2026-10-12T09:30:00Z'),
    fiveHour: { usedFraction: 0.96, resetsAt: 1791812736000 },
    sevenDay: { usedFraction: 0.43, resetsAt: 1792309531000 },
  });
  expect(await readLatestCodexUsage(join(home, 'missing'))).toBeUndefined();
});
