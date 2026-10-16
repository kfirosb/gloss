import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordOf } from '../../src/core/json-record.js';

/** Captured by scripts/probes/capture-claude-input-screens.mjs from throwaway sessions (tmux delivery plan, Task 1). */
export const FIXTURE_DIR = 'tests/fixtures/tmux-screens';
export const FIXTURE_VERSIONS = ['2.1.299', '2.1.300', '2.1.301'] as const;
export interface CapturedRecord {
  status?: string | undefined;
  waitingFor?: unknown;
  version: string;
}
export function readRecord(version: string, state: 'dialog' | 'permission'): CapturedRecord {
  const value: unknown = JSON.parse(
    readFileSync(join(FIXTURE_DIR, `claude-${version}-${state}.session.json`), 'utf8'),
  );
  const record = recordOf(value);
  if (!record || typeof record.version !== 'string')
    throw new Error('Malformed captured session record');
  return {
    ...(typeof record.status === 'string' ? { status: record.status } : {}),
    waitingFor: record.waitingFor,
    version: record.version,
  };
}
export const readScreen = (version: string, state: string) =>
  readFileSync(join(FIXTURE_DIR, `claude-${version}-${state}.ansi`), 'utf8');
export function readCursor(
  version: string,
  state: string,
): { x: number; y: number; inMode: boolean } {
  const text = readFileSync(join(FIXTURE_DIR, `claude-${version}-${state}.cursor`), 'utf8');
  const match = /^(\d+) (\d+) ([01])$/.exec(text.trim());
  if (!match) throw new Error('Malformed captured cursor');
  return { x: Number(match[1]), y: Number(match[2]), inMode: match[3] === '1' };
}
