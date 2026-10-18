import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ActivityEvent } from '../../core/activity-contracts.js';
import { recordOf } from '../../core/json-record.js';
import { Transcript } from '../shared.js';
import { parseClaudeRecord } from './index.js';

export interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId: string;
  spawnDepth: number;
  model?: string;
}

const META_CACHE_LIMIT = 500;
const META_SUFFIX = '.meta.json';
/** A subagent's meta file never changes once written, so a parsed one is cached per process. */
const metaCache = new Map<string, SubagentMeta>();

export function subagentsDir(transcriptPath: string, sessionRef: string): string {
  return join(dirname(transcriptPath), sessionRef, 'subagents');
}

function parseMeta(value: unknown): SubagentMeta | undefined {
  const record = recordOf(value);
  if (!record || typeof record.toolUseId !== 'string') return undefined;
  return {
    toolUseId: record.toolUseId,
    spawnDepth:
      typeof record.spawnDepth === 'number' && Number.isFinite(record.spawnDepth)
        ? record.spawnDepth
        : 1,
    ...(typeof record.agentType === 'string' ? { agentType: record.agentType } : {}),
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    ...(typeof record.model === 'string' ? { model: record.model } : {}),
  };
}

async function readMeta(path: string): Promise<SubagentMeta | undefined> {
  const cached = metaCache.get(path);
  if (cached) return cached;
  let meta: SubagentMeta | undefined;
  try {
    meta = parseMeta(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return undefined; // unreadable or half-written; retried on the next lookup
  }
  if (!meta) return undefined;
  if (metaCache.size >= META_CACHE_LIMIT) metaCache.delete(metaCache.keys().next().value!);
  metaCache.set(path, meta);
  return meta;
}

export async function findSubagentFile(
  dir: string,
  toolUseId: string,
): Promise<{ agentId: string; path: string; meta: SubagentMeta } | undefined> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (!name.startsWith('agent-') || !name.endsWith(META_SUFFIX)) continue;
    const meta = await readMeta(join(dir, name));
    if (meta?.toolUseId !== toolUseId) continue;
    const agentId = name.slice('agent-'.length, -META_SUFFIX.length);
    return { agentId, path: join(dir, `agent-${agentId}.jsonl`), meta };
  }
  return undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** Streams a subagent transcript's activity until the signal aborts; a transcript failure ends it with a gap. */
export async function* streamSubagent(
  path: string,
  sessionRef: string,
  depth: number,
  signal: AbortSignal,
  pollMs = 1000,
): AsyncGenerator<ActivityEvent> {
  const transcript = new Transcript(path, (record, offset) =>
    parseClaudeRecord(record, offset, sessionRef, depth),
  );
  try {
    await transcript.initialize();
    let batch = transcript.takeInitial();
    while (!signal.aborted) {
      for (const event of batch) {
        if (event.type === 'activity') yield event.event;
        else if (event.type === 'gap') yield { kind: 'gap', reason: event.reason };
      }
      await sleep(pollMs, signal);
      if (signal.aborted) return;
      batch = await transcript.poll();
    }
  } catch (error) {
    if (signal.aborted) return;
    yield {
      kind: 'gap',
      reason: error instanceof Error ? error.message : 'Subagent transcript unavailable',
    };
  }
}
