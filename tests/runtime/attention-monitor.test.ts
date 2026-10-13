import { expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MARKER_TABLES, classifyScreen, markersFor } from '../../src/runtime/attention-markers.js';
import { createAttentionMonitor } from '../../src/runtime/attention-monitor.js';

const dir = 'tests/fixtures/screens';
// Fixture names are <agent>-<version>-<kind>[-<detail>].txt.
for (const file of readdirSync(dir)) {
  const [agent, version, kind] = file.replace('.txt', '').split('-') as ['claude' | 'codex', string, string];
  it(`classifies ${file}`, () => {
    const table = markersFor(agent, version); expect(table, 'marker table for ' + version).toBeDefined();
    const expected = kind === 'consent' ? 'consent' : kind === 'permission' || kind === 'approval' ? 'approval' : 'none';
    expect(classifyScreen(table!, readFileSync(join(dir, file), 'utf8'))).toBe(expected);
  });
}
it('unknown versions have no table', () => { expect(markersFor('codex', '0.0.1')).toBeUndefined(); expect(MARKER_TABLES.length).toBeGreaterThan(0); });
it('does not treat prose questions as approval prompts', () => {
  const claude = markersFor('claude', '2.1.296')!; const codex = markersFor('codex', '0.162.1')!;
  expect(classifyScreen(claude, '⏺ Do you want to proceed?\n  I can run it next.')).toBe('none');
  expect(classifyScreen(codex, '• Would you like to run the following command? I can if you agree.')).toBe('none');
});
it('monitor reports needs-user, clears, and flags unknown versions without guessing', async () => {
  let screen = 'Working…'; const timers: (() => void)[] = [];
  const monitor = createAttentionMonitor({ tmux: async () => ({ capturePane: async () => screen } as any),
    launches: () => [{ id: 'L1', agent: 'codex', folder: '/p', panePid: 2, state: 'running', createdAt: 0 }, { id: 'L2', agent: 'claude', folder: '/p', panePid: 3, state: 'running', createdAt: 0 }],
    agentVersion: async a => a === 'codex' ? MARKER_TABLES.find(t => t.agent === 'codex')!.versions[0] : '9.9.9', intervalMs: 1, setTimer: ((fn: () => void) => { timers.push(fn); return 0 as any; }) as any });
  monitor.start(); await vi.waitFor(() => expect(monitor.current().get('L1')?.state).toBe('clear'));
  expect(monitor.current().get('L2')?.state).toBe('unknown-version');
  screen = readFileSync(join(dir, readdirSync(dir).find(f => f.startsWith('codex') && f.includes('approval'))!), 'utf8');
  timers.shift()!(); await vi.waitFor(() => expect(monitor.current().get('L1')?.state).toBe('needs-user'));
  monitor.close();
});
it('drops ended launches and notifies subscribers of changes', async () => {
  const timers: (() => void)[] = []; let launches = [{ id: 'L1', agent: 'codex' as const, folder: '/p', panePid: 2, state: 'running' as const, createdAt: 0 }];
  const monitor = createAttentionMonitor({ tmux: async () => ({ capturePane: async () => '' } as any), launches: () => launches,
    agentVersion: async () => '0.162.1', setTimer: ((fn: () => void) => { timers.push(fn); return 0 as any; }) as any });
  const seen: number[] = []; monitor.subscribe(m => seen.push(m.size));
  monitor.start(); await vi.waitFor(() => expect(seen).toEqual([1]));
  launches = []; timers.shift()!(); await vi.waitFor(() => expect(seen).toEqual([1, 0]));
  monitor.close();
});
it('classifies only the bottom of the screen, where prompts sit', () => {
  const codex = markersFor('codex', '0.162.1')!; const claude = markersFor('claude', '2.1.296')!;
  const approval = readFileSync(join(dir, 'codex-0.162.1-approval.txt'), 'utf8');
  const quoted = approval.split('\n').slice(26) .join('\n') + '\n' + Array.from({ length: 25 }, (_, i) => `  reply line ${i}`).join('\n') + '\n\n› Ask Codex to do anything\n';
  expect(classifyScreen(codex, quoted)).toBe('none');
  const permission = readFileSync(join(dir, 'claude-2.1.296-permission.txt'), 'utf8');
  const claudeQuoted = permission.split('\n').slice(29).join('\n') + '\n' + Array.from({ length: 25 }, (_, i) => `  reply line ${i}`).join('\n') + '\n❯ \n';
  expect(classifyScreen(claude, claudeQuoted)).toBe('none');
});
it('never captures the pane of a launch whose agent version is unknown', async () => {
  const capturePane = vi.fn(async () => ''); const timers: (() => void)[] = [];
  const monitor = createAttentionMonitor({ tmux: async () => ({ capturePane } as any), launches: () => [{ id: 'L1', agent: 'claude', folder: '/p', panePid: 2, state: 'running', createdAt: 0 }],
    agentVersion: async () => '9.9.9', setTimer: ((fn: () => void) => { timers.push(fn); return 0 as any; }) as any });
  monitor.start(); await vi.waitFor(() => expect(monitor.current().get('L1')?.state).toBe('unknown-version'));
  timers.shift()!(); await vi.waitFor(() => expect(timers).toHaveLength(1));
  expect(capturePane).not.toHaveBeenCalled(); monitor.close();
});
it('retries a failed version probe after a backoff but caches a known version', async () => {
  let clock = 0; const timers: (() => void)[] = []; const results: (string | undefined)[] = [undefined, '0.162.1'];
  const agentVersion = vi.fn(async () => results.shift());
  const monitor = createAttentionMonitor({ tmux: async () => ({ capturePane: async () => '' } as any), launches: () => [{ id: 'L1', agent: 'codex', folder: '/p', panePid: 2, state: 'running', createdAt: 0 }],
    agentVersion, now: () => clock, setTimer: ((fn: () => void) => { timers.push(fn); return 0 as any; }) as any });
  monitor.start(); await vi.waitFor(() => expect(monitor.current().get('L1')?.state).toBe('unknown-version'));
  clock = 59_999; timers.shift()!(); await vi.waitFor(() => expect(timers).toHaveLength(1)); expect(agentVersion).toHaveBeenCalledTimes(1);
  clock = 60_000; timers.shift()!(); await vi.waitFor(() => expect(monitor.current().get('L1')?.state).toBe('clear'));
  clock = 500_000; timers.shift()!(); await vi.waitFor(() => expect(timers).toHaveLength(1));
  expect(agentVersion).toHaveBeenCalledTimes(2); monitor.close();
});
it('exposes the marker table for the installed agent version', async () => {
  const monitor = createAttentionMonitor({ tmux: async () => ({}) as any, launches: () => [], agentVersion: async a => a === 'claude' ? '2.1.296' : '0.0.1' });
  expect(await monitor.markers('claude')).toBe(markersFor('claude', '2.1.296')); expect(await monitor.markers('codex')).toBeUndefined(); monitor.close();
});
it('backs off capturing a pane that cannot be read instead of probing it every poll', async () => {
  let clock = 0; const timers: (() => void)[] = [];
  const capturePane = vi.fn(async () => { throw new Error('no such session'); });
  const monitor = createAttentionMonitor({ tmux: async () => ({ capturePane } as any), launches: () => [{ id: 'L1', agent: 'codex', folder: '/p', panePid: 2, state: 'unidentified', createdAt: 0 }],
    agentVersion: async () => '0.162.1', now: () => clock, setTimer: ((fn: () => void) => { timers.push(fn); return 0 as any; }) as any });
  monitor.start(); await vi.waitFor(() => expect(timers).toHaveLength(1)); expect(capturePane).toHaveBeenCalledTimes(1);
  for (const at of [1000, 5000, 14_999]) { clock = at; timers.shift()!(); await vi.waitFor(() => expect(timers).toHaveLength(1)); }
  expect(capturePane).toHaveBeenCalledTimes(1);
  clock = 15_000; timers.shift()!(); await vi.waitFor(() => expect(capturePane).toHaveBeenCalledTimes(2)); monitor.close();
});
