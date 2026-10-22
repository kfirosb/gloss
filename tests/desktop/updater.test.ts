import { expect, it } from 'vitest';
// @ts-expect-error untyped desktop module
import { UPDATE_CHECK_INTERVAL_MS, createUpdater, updateArch } from '../../desktop/updater.mjs';

type State = { kind: string; version?: string; percent?: number; message?: string };
type UpdateFile = { url: string; sha512: string; size: number };
type CheckResult = {
  isUpdateAvailable: boolean;
  updateInfo: { version: string; files: UpdateFile[] };
} | null;

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const file = (url: string): UpdateFile => ({ url, sha512: 'x', size: 1 });
const ARM_ZIP = file('Gloss-1.1.0-arm64.zip');
const X64_ZIP = file('Gloss-1.1.0-x64.zip');
const BOTH = [file('Gloss-1.1.0-arm64.dmg'), ARM_ZIP, file('Gloss-1.1.0-x64.dmg'), X64_ZIP];
const available = (version: string, files: UpdateFile[] = BOTH): CheckResult => ({
  isUpdateAvailable: true,
  updateInfo: { version, files },
});
const current = (version: string): CheckResult => ({
  isUpdateAvailable: false,
  updateInfo: { version, files: BOTH },
});

function harness(
  options: {
    check?: () => Promise<CheckResult>;
    download?: () => Promise<unknown>;
    lastCheck?: number;
    platform?: string;
    arch?: string;
    latest?: () => Promise<{ version: string }>;
    openExternal?: () => Promise<unknown>;
    now?: () => number;
  } = {},
) {
  const calls: string[] = [];
  const states: State[] = [];
  let progress: ((p: { percent: number }) => void) | undefined;
  let failure: ((error: Error) => void) | undefined;
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
      on: (event: string, cb: never) => {
        if (event === 'error') failure = cb;
        else progress = cb;
      },
    },
    now: options.now ?? (() => NOW),
    store: {
      lastCheck: () => lastCheck,
      setLastCheck: (t: number) => (lastCheck = t),
    },
    platform: options.platform ?? 'darwin',
    arch: options.arch ?? 'arm64',
    currentVersion: '1.0.0',
    fetchLatestRelease: () => {
      calls.push('fetch');
      return (options.latest ?? (async () => ({ version: '1.0.0' })))();
    },
    openExternal: (url: string) => {
      calls.push('open ' + url);
      return options.openExternal?.();
    },
    send: (state: State) => states.push(state),
  });
  return {
    updater,
    calls,
    states,
    lastCheck: () => lastCheck,
    progress: () => progress,
    fail: (e: Error) => failure?.(e),
  };
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
  for (const code of ['ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS']) {
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

it('a missing latest release is a failed check, not a missing artifact', async () => {
  const h = harness({
    check: async () => {
      throw coded('ERR_UPDATER_LATEST_VERSION_NOT_FOUND');
    },
  });
  await h.updater.checkNow();
  expect(h.updater.state().kind).toBe('error');
});

it('picks the zip for this architecture', async () => {
  for (const arch of ['arm64', 'x64']) {
    const h = harness({ arch, check: async () => available('1.1.0') });
    await h.updater.checkNow();
    expect(h.updater.state()).toEqual({ kind: 'available', version: '1.1.0' });
  }
});

it('an arm64 Mac with only the x64 zip gets no update', async () => {
  const files = [file('Gloss-1.1.0-x64.dmg'), X64_ZIP];
  const manual = harness({ arch: 'arm64', check: async () => available('1.1.0', files) });
  await manual.updater.checkNow();
  expect(manual.updater.state()).toEqual({ kind: 'up-to-date' });
  const weekly = harness({ arch: 'arm64', check: async () => available('1.1.0', files) });
  await weekly.updater.maybeCheck();
  expect(weekly.updater.state()).toEqual({ kind: 'idle' });
  await weekly.updater.install();
  expect(weekly.calls).not.toContain('download');
});

it('an x64 Mac with only the arm64 zip gets no update', async () => {
  const h = harness({ arch: 'x64', check: async () => available('1.1.0', [ARM_ZIP]) });
  await h.updater.checkNow();
  expect(h.updater.state()).toEqual({ kind: 'up-to-date' });
});

it('under Rosetta the zip check follows the arm64 zip electron-updater downloads', async () => {
  expect(updateArch('x64', true)).toBe('arm64');
  expect(updateArch('x64', false)).toBe('x64');
  expect(updateArch('arm64', false)).toBe('arm64');
  expect(updateArch('x64', undefined)).toBe('x64');
  const rosetta = harness({
    arch: updateArch('x64', true),
    check: async () => available('1.1.0', [ARM_ZIP]),
  });
  await rosetta.updater.checkNow();
  expect(rosetta.updater.state()).toEqual({ kind: 'available', version: '1.1.0' });
  const onlyIntel = harness({
    arch: updateArch('x64', true),
    check: async () => available('1.1.0', [X64_ZIP]),
  });
  await onlyIntel.updater.checkNow();
  expect(onlyIntel.updater.state()).toEqual({ kind: 'up-to-date' });
});

it('a later weekly check never hides an update already on offer', async () => {
  let clock = NOW;
  const results: (() => Promise<CheckResult>)[] = [
    async () => available('1.1.0'),
    async () => {
      throw new Error('offline');
    },
  ];
  const h = harness({ now: () => clock, check: () => results.shift()!() });
  await h.updater.maybeCheck();
  expect(h.updater.state()).toEqual({ kind: 'available', version: '1.1.0' });
  clock += 8 * DAY;
  await h.updater.maybeCheck();
  expect(h.calls).toEqual(['check']);
  expect(h.updater.state()).toEqual({ kind: 'available', version: '1.1.0' });
});

it('an updater error after quitAndInstall moves to error without throwing', async () => {
  const h = harness({ check: async () => available('1.1.0') });
  await h.updater.checkNow();
  await h.updater.install();
  expect(() => h.fail(new Error('Squirrel failed'))).not.toThrow();
  expect(h.updater.state()).toEqual({ kind: 'error', message: 'Squirrel failed' });
});

it('an updater error while not installing is ignored', async () => {
  const h = harness();
  await h.updater.checkNow();
  h.fail(new Error('stray'));
  expect(h.updater.state()).toEqual({ kind: 'up-to-date' });
});

it('linux checks the latest release instead of electron-updater', async () => {
  const newer = harness({ platform: 'linux', latest: async () => ({ version: '1.1.0' }) });
  await newer.updater.checkNow();
  expect(newer.updater.state()).toEqual({ kind: 'available', version: '1.1.0' });
  expect(newer.calls).toEqual(['fetch']);
  expect(newer.lastCheck()).toBe(NOW);
  const same = harness({ platform: 'linux' });
  await same.updater.checkNow();
  expect(same.updater.state()).toEqual({ kind: 'up-to-date' });
});

it('linux fetch failure is silent for the weekly check and an error for checkNow', async () => {
  const latest = async () => {
    throw new Error('rate limited');
  };
  const weekly = harness({ platform: 'linux', latest });
  await weekly.updater.maybeCheck();
  expect(weekly.updater.state()).toEqual({ kind: 'idle' });
  expect(weekly.lastCheck()).toBeUndefined();
  const manual = harness({ platform: 'linux', latest });
  await manual.updater.checkNow();
  expect(manual.updater.state()).toEqual({ kind: 'error', message: 'rate limited' });
});

it('install on linux opens the releases page and downloads nothing', async () => {
  const h = harness({ platform: 'linux', latest: async () => ({ version: '1.1.0' }) });
  await h.updater.checkNow();
  await h.updater.install();
  expect(h.calls).toEqual(['fetch', 'open https://github.com/kfirosb/gloss/releases/latest']);
});

it('a rejected openExternal does not throw', async () => {
  const h = harness({
    platform: 'linux',
    latest: async () => ({ version: '1.1.0' }),
    openExternal: async () => {
      throw new Error('no browser');
    },
  });
  await h.updater.checkNow();
  await expect(h.updater.install()).resolves.toBeUndefined();
});
