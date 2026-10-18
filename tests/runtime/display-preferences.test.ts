import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { LAYOUT_SIZE_MAX, LAYOUT_SIZE_MIN } from '../../src/core/session-contracts.js';
import {
  applyTheme,
  DARK_STYLES,
  pruneDisplayPreferences,
  readDisplayPreferences,
  writeDisplayPreferences,
  type DarkStyle,
  type Theme,
} from '../../src/ui/display-preferences.js';
const storage = (data: string | null = null) =>
  ({
    getItem: () => data,
    setItem: (_k: string, v: string) => {
      data = v;
    },
  }) as unknown as Storage;
it('recovers from unavailable, corrupt and unknown-version preferences', () => {
  for (const s of [
    storage('{'),
    storage('{"version":99}'),
    {
      getItem: () => {
        throw Error('denied');
      },
    } as unknown as Storage,
  ])
    expect(readDisplayPreferences(s)).toEqual({
      version: 1,
      collapsed: false,
      assistantModes: {},
      liveViews: {},
      lastByFolder: {},
      tabOrder: {},
      sidebarWidth: 300,
      theme: 'dark',
      darkStyle: 'graphite',
      filesSide: 'left',
    });
  expect(() =>
    writeDisplayPreferences(readDisplayPreferences(), {
      setItem: () => {
        throw Error('denied');
      },
    } as unknown as Storage),
  ).not.toThrow();
});
it('persists validated per-session modes and folder state without routing or capabilities', () => {
  const s = storage();
  writeDisplayPreferences(
    {
      version: 1,
      collapsed: true,
      assistantModes: { A: 'compact', B: 'full' },
      liveViews: {},
      lastByFolder: {},
      tabOrder: {},
      sidebarWidth: 300,
      theme: 'dark',
      darkStyle: 'graphite',
      filesSide: 'left',
    },
    s,
  );
  expect(readDisplayPreferences(s)).toEqual({
    version: 1,
    collapsed: true,
    assistantModes: { A: 'compact', B: 'full' },
    liveViews: {},
    lastByFolder: {},
    tabOrder: {},
    sidebarWidth: 300,
    theme: 'dark',
    darkStyle: 'graphite',
    filesSide: 'left',
  });
  const bad = storage(
    '{"version":1,"collapsed":"yes","grouping":"no","assistantModes":{"A":"compact","B":"bad"},"capability":"secret"}',
  );
  expect(readDisplayPreferences(bad)).toEqual({
    version: 1,
    collapsed: false,
    assistantModes: { A: 'compact' },
    liveViews: {},
    lastByFolder: {},
    tabOrder: {},
    sidebarWidth: 300,
    theme: 'dark',
    darkStyle: 'graphite',
    filesSide: 'left',
  });
});

it('loads previous-version preferences and keeps new per-folder fields', () => {
  const storage = new Map<string, string>();
  const s = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => {
      storage.set(k, v);
    },
  } as unknown as Storage;
  storage.set(
    'language-assistant:display:v1',
    JSON.stringify({
      version: 1,
      collapsed: true,
      grouping: 'folder',
      assistantModes: { A: 'compact' },
      liveViews: {},
    }),
  );
  expect(readDisplayPreferences(s)).toEqual({
    version: 1,
    collapsed: true,
    assistantModes: { A: 'compact' },
    liveViews: {},
    lastByFolder: {},
    tabOrder: {},
    sidebarWidth: 300,
    theme: 'dark',
    darkStyle: 'graphite',
    filesSide: 'left',
  });
  writeDisplayPreferences(
    {
      version: 1,
      collapsed: false,
      assistantModes: {},
      liveViews: {},
      lastByFolder: { '/f': 'A', bad: 1 as any },
      tabOrder: { '/f': ['A', 'B'], x: 'no' as any },
      sidebarWidth: 300,
      theme: 'dark',
      darkStyle: 'graphite',
      filesSide: 'left',
    },
    s,
  );
  expect(readDisplayPreferences(s)).toEqual({
    version: 1,
    collapsed: false,
    assistantModes: {},
    liveViews: {},
    lastByFolder: { '/f': 'A' },
    tabOrder: { '/f': ['A', 'B'] },
    sidebarWidth: 300,
    theme: 'dark',
    darkStyle: 'graphite',
    filesSide: 'left',
  });
});

it('keeps long-lived tab order beyond 200 keys and prunes only vanished keys, folders and selections', () => {
  const keys = Array.from({ length: 300 }, (_, i) => 'k' + i);
  const s = storage();
  writeDisplayPreferences(
    {
      version: 1,
      collapsed: false,
      assistantModes: {},
      liveViews: {},
      lastByFolder: { '/f': 'k0', '/gone': 'x' },
      tabOrder: { '/f': keys, '/gone': ['x'] },
      sidebarWidth: 300,
      theme: 'dark',
      darkStyle: 'graphite',
      filesSide: 'left',
    },
    s,
  );
  const read = readDisplayPreferences(s);
  expect(read.tabOrder['/f']).toEqual(keys);
  const present = { '/f': { keys: keys.filter((k) => k !== 'k5'), ids: ['k0'] } };
  const pruned = pruneDisplayPreferences(read, present);
  expect(pruned.tabOrder).toEqual({ '/f': keys.filter((k) => k !== 'k5') });
  expect(pruned.lastByFolder).toEqual({ '/f': 'k0' });
  expect(pruneDisplayPreferences(pruned, present)).toBe(pruned);
});

it('validates and persists sidebarWidth', () => {
  expect(readDisplayPreferences(storage()).sidebarWidth).toBe(300);
  const s = storage();
  const w = (n: unknown) => {
    writeDisplayPreferences({ ...readDisplayPreferences(), sidebarWidth: n as number }, s);
    return readDisplayPreferences(s).sidebarWidth;
  };
  expect(w(100)).toBe(240);
  expect(w(900)).toBe(440);
  expect(w(350)).toBe(350);
  expect(w('x')).toBe(300);
  expect(w(NaN)).toBe(300);
});

it('defaults the theme to dark, persists valid themes and rejects unknown ones', () => {
  expect(readDisplayPreferences(storage()).theme).toBe('dark');
  expect(readDisplayPreferences(storage('{"version":1,"collapsed":true}')).theme).toBe('dark');
  const s = storage();
  const t = (theme: unknown) => {
    writeDisplayPreferences({ ...readDisplayPreferences(), theme: theme as Theme }, s);
    return readDisplayPreferences(s).theme;
  };
  expect(t('light')).toBe('light');
  expect(t('auto')).toBe('auto');
  expect(t('dark')).toBe('dark');
  expect(t('sepia')).toBe('dark');
});

it('defaults the dark style to Graphite and rejects unknown styles', () => {
  expect(readDisplayPreferences(storage()).darkStyle).toBe('graphite');
  const s = storage();
  const d = (darkStyle: unknown) => {
    writeDisplayPreferences({ ...readDisplayPreferences(), darkStyle: darkStyle as DarkStyle }, s);
    return readDisplayPreferences(s).darkStyle;
  };
  expect(d('dimmed')).toBe('dimmed');
  expect(d('midnight')).toBe('midnight');
  expect(d('navy')).toBe('graphite');
});

it('marks the root with the theme and dark style its stylesheets key on', () => {
  const root = { dataset: {} } as unknown as HTMLElement;
  for (const theme of ['dark', 'light', 'auto'] as const)
    for (const darkStyle of ['graphite', 'dimmed', 'midnight'] as const) {
      applyTheme({ theme, darkStyle }, root);
      expect(root.dataset).toEqual({ theme, darkStyle });
    }
});

it('defines every dark color variable the stylesheets use for each dark style', () => {
  const sheets = ['styles.css', 'file-tree.css', 'file-content-preview.css']
    .map((f) => readFileSync(new URL('../../src/ui/' + f, import.meta.url), 'utf8'))
    .join('\n');
  const used = new Set([...sheets.matchAll(/var\((--dk-[\w-]+)\)/g)].map((m) => m[1]!));
  const dark = readFileSync(new URL('../../src/ui/dark-styles.css', import.meta.url), 'utf8');
  const blocks = [...dark.matchAll(/data-dark-style='?(\w+)'?\] \{([^}]*)\}/g)].map(
    (m) => [m[1], new Set([...m[2]!.matchAll(/(--dk-[\w-]+):/g)].map((x) => x[1]))] as const,
  );
  expect(blocks.map(([name]) => name)).toEqual(DARK_STYLES.map((s) => s.value));
  expect(used.size).toBeGreaterThan(100);
  for (const [, defined] of blocks) expect([...used].filter((v) => !defined.has(v))).toEqual([]);
  expect(sheets).not.toMatch(/light-dark\([^,]+,\s*#/);
});

it('remembers a validated Live Conversation layout per session', () => {
  const roundTrip = (liveViews: unknown) => {
    const s = storage();
    writeDisplayPreferences({ ...readDisplayPreferences(), liveViews: liveViews as never }, s);
    return readDisplayPreferences(s).liveViews;
  };
  const kept = { view: 'split', conversation: 'original', split: 30 };
  expect(roundTrip({ s1: kept })).toEqual({ s1: kept });
  expect(readDisplayPreferences(storage('{"version":1}')).liveViews).toEqual({});
  expect(
    roundTrip({
      badView: { ...kept, view: 'sideways' },
      badConversation: { ...kept, conversation: 'terminal' },
      nan: { ...kept, split: NaN },
      text: { ...kept, split: '30' },
      str: 'split',
      nul: null,
      low: { ...kept, split: 1 },
      high: { ...kept, split: 99 },
    }),
  ).toEqual({
    low: { ...kept, split: LAYOUT_SIZE_MIN },
    high: { ...kept, split: LAYOUT_SIZE_MAX },
  });
  const many = Object.fromEntries(Array.from({ length: 600 }, (_, i) => ['s' + i, kept]));
  const result = roundTrip(many);
  expect(Object.keys(result)).toHaveLength(500);
  expect(Object.keys(result)[0]).toBe('s100');
  expect(Object.keys(result).at(-1)).toBe('s599');
});
it('round-trips a valid Files window and drops a malformed one without losing other fields', () => {
  const filesWindow = { x: 10, y: 20, width: 900, height: 620, split: 270 };
  const s = storage();
  writeDisplayPreferences({ ...readDisplayPreferences(), collapsed: true, filesWindow }, s);
  expect(readDisplayPreferences(s).filesWindow).toEqual(filesWindow);
  const bad = storage(
    JSON.stringify({ version: 1, collapsed: true, filesWindow: { x: 'a', y: 0, width: 1 } }),
  );
  const read = readDisplayPreferences(bad);
  expect(read.filesWindow).toBeUndefined();
  expect(read.collapsed).toBe(true);
});
it('defaults the Files column to the left, round-trips the right and drops a malformed side', () => {
  expect(readDisplayPreferences(storage()).filesSide).toBe('left');
  expect(
    readDisplayPreferences(storage(JSON.stringify({ version: 1, collapsed: true }))).filesSide,
  ).toBe('left');
  const s = storage();
  writeDisplayPreferences({ ...readDisplayPreferences(s), filesSide: 'right' }, s);
  expect(readDisplayPreferences(s).filesSide).toBe('right');
  for (const side of ['top', 1, null, { side: 'right' }]) {
    const read = readDisplayPreferences(
      storage(JSON.stringify({ version: 1, collapsed: true, filesSide: side })),
    );
    expect(read.filesSide).toBe('left');
    expect(read.collapsed).toBe(true);
  }
});
