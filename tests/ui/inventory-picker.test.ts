import { expect, it } from 'vitest';
import { detectInvocation, rankEntries } from '../../src/ui/inventory-picker.js';
import type { InventoryEntry } from '../../src/agents/inventory.js';

const s = (name: string, description = ''): InventoryEntry => ({
  kind: 'skill',
  name,
  description,
  scope: 'global',
});

it('detects / and $ only at a word start with an empty or letter-led query', () => {
  expect(detectInvocation('use /fro', 8)).toEqual({
    kind: 'skill',
    start: 4,
    end: 8,
    query: 'fro',
  });
  expect(detectInvocation('$', 1)).toEqual({ kind: 'mcp', start: 0, end: 1, query: '' });
  expect(detectInvocation('בדוק ‎$pla', 10)).toEqual({
    kind: 'mcp',
    start: 6,
    end: 10,
    query: 'pla',
  });
  for (const text of ['a/b', 'costs $5', '/usr/bin', 'x$y', '/front '])
    expect(detectInvocation(text, text.length)).toBeNull();
});

it('ranks name prefix, then name substring, then description, and filters by kind', () => {
  const entries = [
    s('polish', 'final design pass'),
    s('design-system'),
    s('frontend-design'),
    s('debug'),
    { kind: 'mcp', name: 'design-mcp', scope: 'global' } as InventoryEntry,
  ];
  expect(rankEntries(entries, 'skill', 'design').map((e) => e.name)).toEqual([
    'design-system',
    'frontend-design',
    'polish',
  ]);
  expect(rankEntries(entries, 'skill', '').map((e) => e.name)).toEqual([
    'debug',
    'design-system',
    'frontend-design',
    'polish',
  ]);
  expect(rankEntries(entries, 'mcp', 'DES').map((e) => e.name)).toEqual(['design-mcp']);
});
