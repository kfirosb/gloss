// Regenerates the dark half of every light-dark() color in the UI stylesheets and src/ui/dark-styles.css.
// Light colors are the source of truth: write a plain color (or light-dark(light, anything)) and run
// `node scripts/dark-styles.mjs`; each color gets one variable per dark style.
import { readFileSync, writeFileSync } from 'node:fs';

const SHEETS = [
  'src/ui/styles.css',
  'src/ui/file-tree.css',
  'src/ui/file-content-preview.css',
  'src/ui/files-window.css',
  'src/ui/file-editor.css',
];
const OUT = 'src/ui/dark-styles.css';
const FG = new Set([
  'color',
  'caret-color',
  'fill',
  'stroke',
  '-webkit-text-fill-color',
  'text-decoration-color',
  'accent-color',
]);

export const PALETTES = {
  graphite: {
    page: '#1c1c1f',
    side: '#202024',
    inset: '#1f1f23',
    card: '#26262a',
    toolbar: '#2a2a2f',
    code: '#18181b',
    lang: '#252a34',
    border: '#36363c',
    strong: '#45454d',
    composer: '#4a5568',
    text: '#e6e6eb',
    muted: '#9c9ca6',
    accent: '#0a84ff',
    link: '#5eaaff',
  },
  dimmed: {
    page: '#22272e',
    side: '#1c2128',
    inset: '#262c33',
    card: '#2d333b',
    toolbar: '#2a3038',
    code: '#1f242b',
    lang: '#283447',
    border: '#444c56',
    strong: '#545d68',
    composer: '#4e6a94',
    text: '#adbac7',
    muted: '#8b97a4',
    accent: '#316dca',
    link: '#6cb6ff',
  },
  midnight: {
    page: '#0d0f14',
    side: '#0a0c10',
    inset: '#0f1218',
    card: '#151922',
    toolbar: '#12161e',
    code: '#0a0c10',
    lang: '#141c30',
    border: '#232a36',
    strong: '#323a48',
    composer: '#3b4c80',
    text: '#e8ebf2',
    muted: '#8e97a9',
    accent: '#5b7cfa',
    link: '#93abff',
  },
};
export const DEFAULT_STYLE = 'graphite';

// Light colors with a fixed role; everything else is placed by hue, saturation and lightness.
const ROLES = {
  bg: {
    f6f7fb: 'page',
    ffffff: 'card',
    f1f5f2: 'side',
    f0f3fa: 'toolbar',
    f6f8ff: 'inset',
    eef1f7: 'inset',
    edf1ff: 'lang',
    f4f5f8: 'code',
    d9deea: 'border',
    e0e4ed: 'border',
    cfd6e5: 'border',
    d6e0da: 'border',
    b7c1d4: 'strong',
    bbc5d8: 'strong',
    '8d9fc4': 'composer',
    '2f5bd3': 'accent',
  },
  fg: {
    172033: 'text',
    '23322f': 'text',
    647089: 'muted',
    '58657d': 'muted',
    '66718a': 'muted',
    '65718a': 'muted',
    '2250b5': 'link',
    '2f5bd3': 'link',
  },
};

const parse = (token) => {
  if (token === 'white') return [255, 255, 255, 1];
  if (token === 'black') return [0, 0, 0, 1];
  if (token.startsWith('rgb')) {
    const p = token
      .slice(token.indexOf('(') + 1, -1)
      .split(/[,\s/]+/)
      .filter(Boolean)
      .map(Number);
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  let h = token.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join('');
  const n = (i) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
};
const toHsl = ([r, g, b]) => {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min,
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  return [
    (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) *
      60,
    s,
    l,
  ];
};
const fromHsl = ([h, s, l]) => {
  h = (((h % 360) + 360) % 360) / 360;
  if (s === 0) return [l, l, l].map((v) => Math.round(v * 255));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s,
    p = 2 * l - q;
  const f = (t) => {
    t = (t + 1) % 1;
    return t < 1 / 6
      ? p + (q - p) * 6 * t
      : t < 1 / 2
        ? q
        : t < 2 / 3
          ? p + (q - p) * (2 / 3 - t) * 6
          : p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255),
  );
};
const hex = (rgb, a = 1) =>
  '#' +
  [...rgb, ...(a < 1 ? [Math.round(a * 255)] : [])]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
const key = (token) => {
  const [r, g, b, a] = parse(token);
  return hex([r, g, b], a).slice(1);
};
const hslOf = (c) => toHsl(parse(c));
const lerp = (a, b, t) => a + (b - a) * Math.min(1, Math.max(0, t));
const isBlue = (h) => h >= 195 && h <= 260;

// Returns this palette's dark color for a light color, or null when the light color already works on dark.
function darkFor(light, role, selector, pal) {
  const [r, g, b, a] = parse(light);
  const [h, s, l] = toHsl([r, g, b]);
  const k = key(light).slice(0, 6);
  const fixed = ROLES[role][k];
  if (fixed) return hex(parse(pal[fixed]).slice(0, 3), a);
  const [nh, ns] = hslOf(pal.card);
  const [, , cardL] = hslOf(pal.card);
  const [, , toolbarL] = hslOf(pal.toolbar);
  const [, , borderL] = hslOf(pal.border);
  const [, , strongL] = hslOf(pal.strong);
  const [ah, as] = hslOf(pal.accent);
  const [, , textL] = hslOf(pal.text);
  const [, , mutedL] = hslOf(pal.muted);
  const semantic = s >= 0.45 && !isBlue(h),
    blue = s >= 0.45 && isBlue(h);
  const highlighted = /selected|active|current|pressed|checked|:hover|focus/.test(selector);
  if (role === 'fg') {
    if (l >= 0.5) return null;
    if (blue) return hex(parse(pal.link).slice(0, 3), a);
    if (semantic || s >= 0.3) return hex(fromHsl([h, Math.min(s, 0.7), Math.max(1 - l, 0.66)]), a);
    return hex(fromHsl([nh, ns, lerp(textL, mutedL, (l - 0.12) / 0.33)]), a);
  }
  if (l < 0.45) return null;
  if (l <= 0.68 && s >= 0.45) return blue ? hex(parse(pal.accent).slice(0, 3), a) : null;
  if (semantic)
    return hex(fromHsl([h, Math.min(s, 0.42), l >= 0.88 ? cardL + 0.025 : cardL + 0.15]), a);
  if (blue || (highlighted && l >= 0.85))
    return hex(
      fromHsl([
        ah,
        Math.min(as, 0.35),
        l >= 0.88 ? lerp(cardL, toolbarL + 0.06, (0.99 - l) / 0.1) : 0.38,
      ]),
      a,
    );
  if (l <= 0.6) return hex(parse(pal.accent).slice(0, 3), a);
  if (l >= 0.9) return hex(fromHsl([nh, ns, lerp(cardL, toolbarL + 0.03, (0.995 - l) / 0.095)]), a);
  return hex(fromHsl([nh, ns, lerp(borderL, strongL + 0.08, (0.9 - l) / 0.3)]), a);
}

const COLOR =
  /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{4}\b|#[0-9a-fA-F]{3}\b|rgba?\([^)]*\)|\b(?:white|black)\b/g;
const used = new Map();
function convertValue(prop, value, selector) {
  const role = FG.has(prop.trim().toLowerCase()) ? 'fg' : 'bg';
  const plain = value.replace(
    /light-dark\(\s*([^,()]+(?:\([^)]*\))?)\s*,\s*(?:[^()]+|var\([^)]*\))\s*\)/g,
    '$1',
  );
  return plain.replace(COLOR, (token) => {
    const darks = Object.fromEntries(
      Object.entries(PALETTES).map(([name, pal]) => [name, darkFor(token, role, selector, pal)]),
    );
    if (Object.values(darks).every((d) => d === null)) return token;
    const name = `--dk-${role}-${key(token)}`;
    for (const [style, d] of Object.entries(darks))
      used.set(`${style} ${name}`, d ?? hex(parse(token).slice(0, 3), parse(token)[3]));
    return `light-dark(${token}, var(${name}))`;
  });
}

for (const file of SHEETS) {
  const css = readFileSync(file, 'utf8');
  const out = css.replace(
    /([^{}]*)\{([^{}]*)\}/g,
    (_, selector, body) =>
      selector +
      '{' +
      body.replace(
        /(^|;)(\s*)([-a-zA-Z]+)(\s*:)([^;]*)/g,
        (m, sep, ws, prop, colon, value) =>
          sep + ws + prop + colon + convertValue(prop, value, selector),
      ) +
      '}',
  );
  writeFileSync(file, out);
}
const block = (style) =>
  [...used]
    .filter(([k]) => k.startsWith(style + ' '))
    .map(([k, v]) => `  ${k.split(' ')[1]}: ${v};`)
    .sort()
    .join('\n');
writeFileSync(
  OUT,
  `/* Generated by scripts/dark-styles.mjs from the light colors in the UI stylesheets; do not edit by hand. */\n` +
    Object.keys(PALETTES)
      .map(
        (style) =>
          `${style === DEFAULT_STYLE ? ':root, ' : ''}:root[data-dark-style=${style}] {\n${block(style)}\n}\n`,
      )
      .join(''),
);
console.log(
  `${used.size / Object.keys(PALETTES).length} colors × ${Object.keys(PALETTES).length} dark styles → ${OUT}`,
);
