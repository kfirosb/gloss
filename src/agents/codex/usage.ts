import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCodexRateLimits, type ProviderUsage } from '../../core/usage.js';

const TAIL_BYTES = 256 * 1024;
const CANDIDATES = 6;

/** The account's quota as the most recently written rollout last saw it; used before a session has its own turns and on refresh. */
export async function readLatestCodexUsage(codexHome: string): Promise<ProviderUsage | undefined> {
  const files = await newestRollouts(join(codexHome, 'sessions'), CANDIDATES).catch(() => []);
  for (const path of files) {
    const usage = await lastUsage(path).catch(() => undefined);
    if (usage) return usage;
  }
  return undefined;
}

/** Newest rollouts by modification time, descending the sessions/YYYY/MM/DD tree from the latest day. */
async function newestRollouts(root: string, limit: number): Promise<string[]> {
  const found: { path: string; mtime: number }[] = [];
  const descend = async (dir: string, depth: number) => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      if (entry.isDirectory() && depth < 3) await descend(join(dir, entry.name), depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) { const path = join(dir, entry.name); found.push({ path, mtime: (await stat(path)).mtimeMs }); }
      if (depth === 0 && found.length >= limit * 4) break;
    }
  };
  await descend(root, 0);
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map(entry => entry.path);
}

async function lastUsage(path: string): Promise<ProviderUsage | undefined> {
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size; const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start); await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    for (const line of lines.reverse()) {
      if (!line.includes('"rate_limits"')) continue;
      let record: any; try { record = JSON.parse(line); } catch { continue; }
      if (record?.type !== 'event_msg' || record.payload?.type !== 'token_count') continue;
      const usage = parseCodexRateLimits(record.payload.rate_limits, Date.parse(record.timestamp) || 0);
      if (usage) return usage;
    }
    return undefined;
  } finally { await file.close(); }
}
