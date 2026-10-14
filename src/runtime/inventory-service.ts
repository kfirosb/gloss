import type { AgentKind } from '../core/contracts.js';
import type { SessionRecord } from '../core/session-contracts.js';
import type { Inventory } from '../agents/inventory.js';
import { readClaudeInventory } from '../agents/claude/inventory.js';
import { readCodexInventory } from '../agents/codex/inventory.js';

export interface InventoryService { read(agent: AgentKind, project: string): Promise<Inventory> }

/** The folder whose project-level skills and MCP servers apply to a session. */
export const sessionInventoryRoot = (record: SessionRecord) => record.canonicalRoot || record.target.projectId;

/** Reads inventories on demand; a short cache absorbs repeated picker opens and keystrokes. Failures are not cached. */
export function createInventoryService(options: { readers?: Record<AgentKind, (project: string) => Promise<Inventory>>; ttlMs?: number; now?: () => number } = {}): InventoryService {
  const readers = options.readers ?? { claude: project => readClaudeInventory({ project }), codex: project => readCodexInventory({ project }) };
  const ttl = options.ttlMs ?? 2000; const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; value: Promise<Inventory> }>();
  return {
    read(agent, project) {
      const key = agent + '\0' + project;
      const hit = cache.get(key);
      if (hit && now() - hit.at <= ttl) return hit.value;
      const value = readers[agent](project);
      cache.set(key, { at: now(), value });
      value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
      return value;
    },
  };
}
