import { expect, it } from 'vitest';
// @ts-expect-error untyped desktop module
import { UPDATE_CHECK_INTERVAL_MS, createUpdater } from '../../desktop/updater.mjs';

type State = { kind: string; version?: string; percent?: number; message?: string };
type CheckResult = { isUpdateAvailable: boolean; updateInfo: { version: string } } | null;

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const available = (version: string): CheckResult => ({
  isUpdateAvailable: true,
  updateInfo: { version },
});
const current = (version: string): CheckResult => ({
  isUpdateAvailable: false,
  updateInfo: { version },
});

function harness(
  options: {
    check?: () => Promise<CheckResult>;
    download?: () => Promise<unknown>;
    lastCheck?: number;
    platform?: string;
  } = {},
) {
  const calls: string[] = [];
  const states: State[] = [];
  let progress: ((p: { percent: number }) => void) | undefined;
  let lastCheck = options.lastCheck;
  const updater = createUpdater({
    updater: {
      checkForUpdates: () => {
        calls.push('check');
        return (options.check ?? (async () => current('1.0.0')))();
      },
      downloadUpdate: () => {
        calls.push('download');
        return (options.download ?? (async () => []))();
      },
      quitAndInstall: () => calls.push('quitAndInstall'),
      on: (_event: string, cb: (p: { percent: number }) => void) => (progress = cb),
    },
    now: () => NOW,
    store: {
      lastCheck: () => lastCheck,
      setLastCheck: (t: number) => (lastCheck = t),
    },
    platform: options.platform ?? 'darwin',
    openExternal: (url: string) => calls.push('open ' + url),
    send: (state: State) => states.push(state),
  });
  return { updater, calls, states, lastCheck: () => lastCheck, progress: () => progress };
}

const coded = (code: string) => Object.assign(new Error(code), { code });

it('weekly interval is seven days', () => {
  expect(UPDATE_CHECK_INTERVAL_MS).toBe(7 * DAY);
});

it('maybeCheck within 7 days of the last check makes no call', async () => {
  const h = harness({ lastCheck: NOW - 6 * DAY });
  await h.updater.maybeCheck();
  expect(h.calls).toEqual([]);
  expect(h.updater.state()).toEqual({ kind: 'idle' });
});

it('maybeCheck after 7 days checks once and stores now', async () => {
  const h = harness({ lastCheck: NOW - 7 * DAY });
  await h.updater.maybeCheck();
  expect(h.calls).toEqual(['check']);
  expect(h.lastCheck()).toBe(NOW);
});

it('maybeCheck with no stored check runs', async () => {
  const h = harness();
  await h.updater.maybeCheck();
  expect(h.calls).toEqual(['check']);
});

it('a failed check does not advance lastCheck and stays silent for maybeCheck', async () => {
  const h = harness({
    lastCheck: NOW - 8 * DAY,
    check: async () => {
      throw new Error('offline');
    },
  });
  await h.updater.maybeCheck();
  expect(h.lastCheck()).toBe(NOW - 8 * DAY);
  expect(h.updater.state()).toEqual({ kind: 'idle' });
});

it('a failed check shows an error for checkNow', async () => {
  const h = harness({
    check: async () => {
      throw new Error('offline');
    },
  });
  await h.updater.checkNow();
  expect(h.updater.state()).toEqual({ kind: 'error', message: 'offline' });
  expect(h.lastCheck()).toBeUndefined();
});

it('a newer version is available and an equal one is up to date', async () => {
  const newer = harness({ check: async () => available('1.1.0') });
  await newer.updater.checkNow();
  expect(newer.updater.state()).toEqual({ kind: 'available', version: '1.1.0' });
  const same = harness();
  await same.updater.checkNow();
  expect(same.updater.state()).toEqual({ kind: 'up-to-date' });
});

it('a null result means up to date', async () => {
  const h = harness({ check: async () => null });
  await h.updater.checkNow();
  expect(h.updater.state()).toEqual({ kind: 'up-to-date' });
});

it('missing artifact means no update, not an error', async () => {
  for (const code of ['ERR_UPDATER_ASSET_NOT_FOUND', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND']) {
    const check = async () => {
      throw coded(code);
    };
    const manual = harness({ check });
    await manual.updater.checkNow();
    expect(manual.updater.state()).toEqual({ kind: 'up-to-date' });
    const weekly = harness({ check });
    await weekly.updater.maybeCheck();
    expect(weekly.updater.state()).toEqual({ kind: 'idle' });
  }
});

it('checkNow during a running check reuses it', async () => {
  let release: (r: CheckResult) => void = () => {};
  const h = harness({ check: () => new Promise<CheckResult>((resolve) => (release = resolve)) });
  const first = h.updater.checkNow();
  const second = h.updater.checkNow();
  expect(h.updater.state()).toEqual({ kind: 'checking' });
  release(available('2.0.0'));
  await Promise.all([first, second]);
  expect(h.calls).toEqual(['check']);
});

it('sends every state change', async () => {
  const h = harness({ check: async () => available('1.1.0') });
  await h.updater.checkNow();
  expect(h.states).toEqual([{ kind: 'checking' }, { kind: 'available', version: '1.1.0' }]);
});

it('install on darwin downloads with progress then quits and installs once', async () => {
  let finish: () => void = () => {};
  const h = harness({
    check: async () => available('1.1.0'),
    download: () => new Promise((resolve) => (finish = () => resolve([]))),
  });
  await h.updater.checkNow();
  const installing = h.updater.install();
  expect(h.updater.state()).toEqual({ kind: 'downloading', version: '1.1.0', percent: 0 });
  h.progress()?.({ percent: 42.5 });
  expect(h.updater.state()).toEqual({ kind: 'downloading', version: '1.1.0', percent: 42.5 });
  expect(h.calls).not.toContain('quitAndInstall');
  finish();
  await installing;
  expect(h.calls.filter((c) => c === 'quitAndInstall')).toHaveLength(1);
});

it('a download failure shows an error and does not install', async () => {
  const h = harness({
    check: async () => available('1.1.0'),
    download: async () => {
      throw new Error('disk full');
    },
  });
  await h.updater.checkNow();
  await h.updater.install();
  expect(h.updater.state()).toEqual({ kind: 'error', message: 'disk full' });
  expect(h.calls).not.toContain('quitAndInstall');
});

it('install without an available update does nothing', async () => {
  const h = harness();
  await h.updater.install();
  expect(h.calls).toEqual([]);
});

it('install on linux opens the releases page and downloads nothing', async () => {
  const h = harness({ platform: 'linux', check: async () => available('1.1.0') });
  await h.updater.checkNow();
  await h.updater.install();
  expect(h.calls).toEqual(['check', 'open https://github.com/kfirosb/gloss/releases/latest']);
});
