import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentPastSession } from '../../core/past-sessions.js';
import { recordOf, textBlocks } from '../../core/json-record.js';
import { CLAUDE_SETUP_PROMPT } from '../../core/session-contracts.js';
import { normalizeSessionTitle } from '../../core/session-title.js';
import { projectIdentity, uuid } from '../shared.js';

export const CLAUDE_PAST_HEAD_BYTES = 262144;
export const CLAUDE_PAST_TAIL_BYTES = 65536;
const MAX_ENTRIES = 10_000;

/** Claude Code's project directory name for a folder: every character outside [A-Za-z0-9] becomes '-'. */
export function claudeProjectSlug(folder: string): string {
  return folder.replace(/[^A-Za-z0-9]/g, '-');
}

/** Reads `length` bytes at `position`; the result holds only complete lines of the window. */
async function readLines(
  path: string,
  size: number,
  from: 'start' | 'end',
  bound: number,
): Promise<string[]> {
  const handle = await open(path, 'r');
  try {
    const length = Math.min(size, bound);
    const position = from === 'start' ? 0 : size - length;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    // The window may cut a line at its far edge (head) or its near edge (tail); the other end is a line boundary.
    if (from === 'start' && size > length) lines.pop();
    if (from === 'end' && position > 0) lines.shift();
    return lines;
  } finally {
    await handle.close();
  }
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    return recordOf(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function promptText(record: Record<string, unknown>): string | undefined {
  const content = recordOf(record.message)?.content;
  const text = typeof content === 'string' ? content : textBlocks(content).join('\n');
  return text && text !== CLAUDE_SETUP_PROMPT ? text : undefined;
}

/** Top-level `<uuid>.jsonl` files of `<configDir>/projects/<slug>` whose first `cwd` resolves to the folder and that hold a user record. */
export async function listClaudePastSessions(
  configDir: string,
  projectPath: string,
): Promise<AgentPastSession[]> {
  const dir = join(configDir, 'projects', claudeProjectSlug(projectPath));
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (names.length > MAX_ENTRIES) throw new Error('Transcript enumeration exceeds bound');
  const folder = await projectIdentity(projectPath);
  const sessions: AgentPastSession[] = [];
  for (const name of names) {
    const sessionRef = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : '';
    if (!uuid.test(sessionRef)) continue;
    try {
      const path = join(dir, name);
      const info = await stat(path);
      if (!info.isFile()) continue;
      let cwd: string | undefined;
      let branch: string | undefined;
      let fallback: string | undefined;
      let prompted = false;
      for (const line of await readLines(path, info.size, 'start', CLAUDE_PAST_HEAD_BYTES)) {
        const record = parse(line);
        if (!record) continue;
        if (cwd === undefined && typeof record.cwd === 'string') {
          cwd = record.cwd;
          if (typeof record.gitBranch === 'string') branch = record.gitBranch;
        }
        if (record.type !== 'user') continue;
        prompted = true;
        fallback ??= promptText(record);
      }
      // A transcript with only the setup prompt is listed without a title of its own.
      if (cwd === undefined || !prompted || (await projectIdentity(cwd)) !== folder) continue;
      let title = fallback === undefined ? undefined : normalizeSessionTitle(fallback);
      for (const line of (
        await readLines(path, info.size, 'end', CLAUDE_PAST_TAIL_BYTES)
      ).reverse()) {
        const record = parse(line);
        const ai = record?.type === 'ai-title' ? normalizeSessionTitle(record.aiTitle) : undefined;
        if (ai) {
          title = ai;
          break;
        }
      }
      sessions.push({
        agent: 'claude',
        sessionRef,
        ...(title ? { title } : {}),
        lastActiveAt: info.mtimeMs,
        ...(branch ? { branch } : {}),
      });
    } catch {
      /* unreadable transcript or vanished project folder: not listable */
    }
  }
  return sessions;
}
