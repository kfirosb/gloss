import { afterEach, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeActivity } from '../../src/agents/claude/index.js';
import { harness } from './agent-harness.js';
import { FIXTURE_VERSIONS, readRecord } from './tmux-fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

it('maps a waiting status or any waitingFor to dialog-open, and keeps approval statuses first', () => {
  expect(claudeActivity('idle')).toBe('idle');
  expect(claudeActivity('busy')).toBe('working');
  expect(claudeActivity('waiting')).toBe('dialog-open');
  expect(claudeActivity('idle', 'dialog open')).toBe('dialog-open');
  expect(claudeActivity('busy', 'permission')).toBe('dialog-open');
  expect(claudeActivity('idle', '')).toBe('idle');
  expect(claudeActivity('idle', null)).toBe('idle');
  // An unexpected shape still means something is waiting: fail closed for typing.
  expect(claudeActivity('idle', { kind: 'unknown' })).toBe('dialog-open');
  expect(claudeActivity('waiting_for_approval', 'permission')).toBe('approval-required');
});
it.each(FIXTURE_VERSIONS)(
  'reads Claude %s’s own record of an open dialog as dialog-open',
  (version) => {
    const dialog = readRecord(version, 'dialog');
    expect(
      dialog.status === 'waiting' ||
        (typeof dialog.waitingFor === 'string' && dialog.waitingFor !== ''),
      'the captured record names the dialog',
    ).toBe(true);
    expect(claudeActivity(dialog.status, dialog.waitingFor)).toBe('dialog-open');
    const permission = readRecord(version, 'permission');
    expect(['dialog-open', 'approval-required']).toContain(
      claudeActivity(permission.status, permission.waitingFor),
    );
  },
);
it('reports dialog-open for a connected session whose record names a dialog', async () => {
  const h = await harness('claude');
  cleanups.push(h.cleanup);
  await writeFile(
    join(h.dir, 'sessions', 'own.json'),
    JSON.stringify({
      sessionId: h.sessionRef,
      cwd: h.project,
      pid: process.pid,
      version: '2.1.301',
      status: 'busy',
      waitingFor: 'dialog open',
    }),
  );
  const connection = await h.adapter.attach(h.target);
  cleanups.push(() => connection.detach());
  const controller = new AbortController();
  cleanups.push(async () => controller.abort());
  let count = 0;
  for await (const event of connection.events(controller.signal)) {
    count += 1;
    expect(event).toEqual({ type: 'status', state: 'dialog-open' });
    break;
  }
  expect(count).toBe(1);
});
