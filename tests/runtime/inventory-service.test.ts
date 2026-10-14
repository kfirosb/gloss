import { expect, it, vi } from 'vitest';
import { createInventoryService } from '../../src/runtime/inventory-service.js';
import type { Inventory } from '../../src/agents/inventory.js';

it('caches per agent and project for the TTL and retries after a failure', async () => {
  let now = 0; let fail = true;
  const claude = vi.fn(async (project: string): Promise<Inventory> => { if (fail) throw new Error('boom'); return { agent: 'claude', entries: [{ kind: 'skill', name: project, scope: 'global' }], problems: [] }; });
  const codex = vi.fn(async (): Promise<Inventory> => ({ agent: 'codex', entries: [], problems: [] }));
  const service = createInventoryService({ readers: { claude, codex }, ttlMs: 2000, now: () => now });
  await expect(service.read('claude', '/a')).rejects.toThrow('boom');
  fail = false;
  expect((await service.read('claude', '/a')).entries[0]!.name).toBe('/a');
  await service.read('claude', '/a'); now = 1999; await service.read('claude', '/a');
  expect(claude).toHaveBeenCalledTimes(2);
  now = 2001; await service.read('claude', '/a');
  expect(claude).toHaveBeenCalledTimes(3);
  await service.read('codex', '/a'); await service.read('claude', '/b');
  expect(codex).toHaveBeenCalledTimes(1); expect(claude).toHaveBeenCalledTimes(4);
});
