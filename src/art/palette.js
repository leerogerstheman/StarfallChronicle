'use strict';

/**
 * The art palette.
 *
 * Two rules keep thirteen figures looking like one set:
 *
 *   1. Every shape is filled from here or from a character's own declared
 *      colour. No ad-hoc hex codes in shape data.
 *   2. Shading is not a second colour per material. It is the base colour
 *      pushed toward the shadow hue by a fixed amount, so a whole figure
 *      darkens consistently with one light direction.
 *
 * The light comes from the upper right. That is why `shade` has a companion
 * `shadeSide` in the figure builder: the shaded half is always the left.
 */

/** Outline ink. Near-black with a blue cast so it sits with the dark UI. */
const INK = '#0a0c14';

/** Line weights. Outer silhouette, interior detail, and hairline accents. */
const STROKE = {
  outer: 6,
  inner: 3.5,
  fine: 2.2,
};

/** Neutral skin ladder, lightest to deepest. */
const SKIN = {
  porcelain: { base: '#f4d8c4', shadow: '#d9ae94', line: '#a8795f' },
  light: { base: '#ecc3a4', shadow: '#cd9a78', line: '#9a6b4c' },
  warm: { base: '#dfa87f', shadow: '#bd8259', line: '#8a573a' },
  tan: { base: '#c98a5e', shadow: '#a46840', line: '#77432a' },
  deep: { base: '#96603f', shadow: '#75452b', line: '#4d2a18' },
};

/** Fabric neutrals used by several costumes. */
const CLOTH = {
  ink: '#141726',
  night: '#1d2136',
  slate: '#2c3350',
  steel: '#3d4768',
  fog: '#6b7599',
  bone: '#e6e3d8',
  linen: '#f2ede1',
  leather: '#4a3524',
  leatherLight: '#6b4d33',
  brass: '#c8a44a',
  brassLight: '#e8cd7c',
  iron: '#8c93a8',
  ironLight: '#b9bfd0',
};

/** Per-element accent, mirroring `src/core/rules.js`. */
const ELEMENT_ACCENT = {
  physical: '#c9d1d9',
  fire: '#ff6b4a',
  ice: '#63d4ff',
  lightning: '#c77dff',
  wind: '#5ee6a8',
  quantum: '#8b7cf6',
  imaginary: '#ffd166',
};

/**
 * Background aura used behind full-body art.
 *
 * Kept very dark and low-contrast on purpose: the standing art is displayed
 * over the game's near-black panels, and a bright disc would fight the UI.
 *
 * The last three are not player elements. Enemies have weaknesses rather than
 * an element of their own, so a creature picks the aura that matches what it
 * *is* — forest, ash or stone — and uses `auraKind` to say so.
 */
const AURA = {
  fire: ['#3a1710', '#140a0c'],
  ice: ['#12303f', '#0a141f'],
  lightning: ['#2a1a3f', '#120c1f'],
  wind: ['#123528', '#0a1a16'],
  quantum: ['#1e1a3f', '#0e0c1c'],
  imaginary: ['#3a3016', '#171208'],
  physical: ['#2a2f3d', '#101219'],
  enemy: ['#2a1418', '#120a0c'],
  forest: ['#17301c', '#0a140d'],
  ash: ['#33150f', '#130a09'],
  stone: ['#1d2233', '#0b0d15'],
};

// -- colour maths -----------------------------------------------------------

function parseHex(hex) {
  const clean = String(hex).replace('#', '').trim();
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function toHex([r, g, b]) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('')}`;
}

/** `amount` > 0 lightens toward white, < 0 darkens toward `toward`. */
function shade(hex, amount, toward = '#0a0c14') {
  const from = parseHex(hex);
  const target = parseHex(toward);
  const t = Math.abs(amount);
  const mix = from.map((v, i) => (amount >= 0 ? v + (255 - v) * t : v + (target[i] - v) * t));
  return toHex(mix);
}

/** Blend two colours; `t` 0 returns `a`, 1 returns `b`. */
function mix(a, b, t) {
  const ca = parseHex(a);
  const cb = parseHex(b);
  return toHex(ca.map((v, i) => v + (cb[i] - v) * t));
}

/**
 * Perceived luminance, 0–1.
 *
 * Used by the art tests to assert that, say, a face is lighter than the hair
 * covering it. Without a check like that a "portrait" can be structurally
 * valid SVG and still be an unreadable blob.
 */
function luminance(hex) {
  const [r, g, b] = parseHex(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours, 1–21. */
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** The standard two-tone shading pair for a material. */
function tones(base) {
  return {
    base,
    shadow: shade(base, -0.28),
    deep: shade(base, -0.5),
    light: shade(base, 0.22),
    rim: shade(base, 0.45),
  };
}

function skinTones(name) {
  const entry = SKIN[name] || SKIN.light;
  return {
    base: entry.base,
    shadow: entry.shadow,
    deep: shade(entry.base, -0.34),
    light: shade(entry.base, 0.16),
    line: entry.line,
    rim: shade(entry.base, 0.42),
  };
}

function aura(element) {
  const pair = AURA[element] || AURA.physical;
  return { inner: pair[0], outer: pair[1] };
}

module.exports = {
  INK, STROKE, SKIN, CLOTH, ELEMENT_ACCENT, AURA,
  shade, mix, luminance, contrast, tones, skinTones, aura, parseHex, toHex,
};
