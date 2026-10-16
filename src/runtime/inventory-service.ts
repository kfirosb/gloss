import type { AgentKind } from '../core/contracts.js';
import type { SessionRecord } from '../core/session-contracts.js';
import type { Inventory } from '../agents/inventory.js';
import { readClaudeInventory } from '../agents/claude/inventory.js';
import { readCodexInventory } from '../agents/codex/inventory.js';
import { createAsyncCache } from '../core/async-cache.js';

export interface InventoryService {
  read(agent: AgentKind, project: string): Promise<Inventory>;
}

/** The folder whose project-level skills and MCP servers apply to a session. */
export const sessionInventoryRoot = (record: SessionRecord) =>
  record.canonicalRoot || record.target.projectId;

/** Reads inventories on demand; a short cache absorbs repeated picker opens and keystrokes. Failures are not cached. */
export function createInventoryService(
  options: {
    readers?: Record<AgentKind, (project: string) => Promise<Inventory>>;
    ttlMs?: number;
    now?: () => number;
  } = {},
): InventoryService {
  const readers = options.readers ?? {
    claude: (project) => readClaudeInventory({ project }),
    codex: (project) => readCodexInventory({ project }),
  };
  const cache = createAsyncCache<string, Inventory>({
    ttlMs: options.ttlMs ?? 2000,
    now: options.now ?? Date.now,
  });
  return {
    read(agent, project) {
      return cache.get(agent + '\0' + project, () => readers[agent](project));
    },
  };
}
