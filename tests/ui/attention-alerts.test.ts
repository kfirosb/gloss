import { describe, expect, it } from 'vitest';
import { diffAlerts, emptyTracker, readAlertSettings, writeAlertSettings, ALERT_SOUNDS, type AlertTracker } from '../../src/ui/attention-alerts.js';
import type { CatalogEntry } from '../../src/core/session-catalog.js';

const entry = (id: string, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({ key: id, sessionId: id, target: { agent: 'claude', projectId: '/repo', sessionRef: id }, projectKey: '/repo/.git', projectName: 'repo', open: true, activity: 'idle', availability: 'available', ...extra } as CatalogEntry);
const away = { focused: false, selectedId: 'A' };
function run(snapshots: CatalogEntry[][], context = away) {
  let tracker: AlertTracker = emptyTracker; const all: string[][] = [];
  for (const s of snapshots) { const r = diffAlerts(tracker, s, context); tracker = r.tracker; all.push(r.events.map(e => e.key)); }
  return all;
}

describe('diffAlerts', () => {
  it('seeds silently from the first snapshot', () => {
    expect(run([[entry('A', { attention: 'response', latestResponseSequence: 5 }), entry('B', { attention: 'approval', activity: 'approval-required' })]])).toEqual([[]]);
  });
  it('alerts once per new reply sequence, not on a repeated snapshot', () => {
    const idle = entry('A', { latestResponseSequence: 5 }); const reply = entry('A', { attention: 'response', latestResponseSequence: 9 });
    expect(run([[idle], [reply], [reply], [entry('A', { attention: 'response', latestResponseSequence: 12 })]])).toEqual([[], ['A:r:9'], [], ['A:r:12']]);
  });
  it('alerts for the first reply of a known session that had none', () => {
    expect(run([[entry('A')], [entry('A', { attention: 'response', latestResponseSequence: 3 })]])).toEqual([[], ['A:r:3']]);
  });
  it('alerts on each approval onset', () => {
    const asking = entry('A', { attention: 'approval', activity: 'approval-required' });
    expect(run([[entry('A')], [asking], [asking], [entry('A')], [asking]])).toEqual([[], ['A:a:1'], [], [], ['A:a:2']]);
  });
  it('suppresses the selected session only while focused', () => {
    const snaps = [[entry('A'), entry('B')], [entry('A', { attention: 'response', latestResponseSequence: 1 }), entry('B', { attention: 'response', latestResponseSequence: 1 })]];
    expect(run(snaps, { focused: true, selectedId: 'A' })).toEqual([[], ['B:r:1']]);
    expect(run(snaps, { focused: false, selectedId: 'A' })).toEqual([[], ['A:r:1', 'B:r:1']]);
  });
  it('a suppressed reply does not alert later when focus moves away', () => {
    let t: AlertTracker = emptyTracker;
    t = diffAlerts(t, [entry('A')], { focused: true, selectedId: 'A' }).tracker;
    const reply = [entry('A', { attention: 'response', latestResponseSequence: 4 })];
    const first = diffAlerts(t, reply, { focused: true, selectedId: 'A' }); expect(first.events).toEqual([]);
    expect(diffAlerts(first.tracker, reply, away).events).toEqual([]);
  });
  it('a session discovered already waiting seeds silently', () => {
    expect(run([[entry('A')], [entry('A'), entry('C', { attention: 'response', latestResponseSequence: 8 })]])).toEqual([[], []]);
  });
  it('closed sessions and entries without a session id never alert', () => {
    expect(run([[entry('A'), entry('D', { open: false })], [entry('A', { open: false, attention: 'response', latestResponseSequence: 2 }), { ...entry('D', { attention: 'response', latestResponseSequence: 2 }), sessionId: undefined } as unknown as CatalogEntry]])).toEqual([[], []]);
  });
});

describe('alert settings', () => {
  const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } as unknown as Storage; };
  it('defaults to message and sound on with Glass', () => {
    expect(readAlertSettings(store())).toEqual({ version: 1, message: true, sound: true, soundName: 'Glass' });
  });
  it('round-trips and falls back to Glass for an unknown sound', () => {
    const s = store();
    writeAlertSettings({ version: 1, message: false, sound: true, soundName: 'Ping' }, s);
    expect(readAlertSettings(s)).toEqual({ version: 1, message: false, sound: true, soundName: 'Ping' });
    s.setItem('language-assistant:alerts:v1', JSON.stringify({ version: 1, message: true, sound: false, soundName: '../../etc' }));
    expect(readAlertSettings(s).soundName).toBe('Glass');
    s.setItem('language-assistant:alerts:v1', '{bad');
    expect(readAlertSettings(s).message).toBe(true);
  });
  it('lists the fourteen Mac sounds', () => { expect(ALERT_SOUNDS).toHaveLength(14); expect(ALERT_SOUNDS).toContain('Submarine'); });
});
