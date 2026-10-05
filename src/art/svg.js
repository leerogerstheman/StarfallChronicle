'use strict';

/**
 * Tiny SVG construction helpers.
 *
 * Everything here is a pure string builder. No DOM, no library, no build step —
 * the same reason the rest of the project has no dependencies.
 *
 * The one piece worth explaining is `smooth*`. Hand-authoring cubic beziers for
 * organic shapes (hair, cloth, limbs) is how vector art turns into an
 * unmaintainable pile of magic numbers. Instead every curve here is defined by
 * a short list of *anchor points* the author can reason about geometrically,
 * and Catmull-Rom interpolation turns them into beziers. That means a hair
 * silhouette is five readable coordinates rather than four opaque control
 * points per segment, and it can be nudged without redrawing the whole thing.
 */

/**
 * Format a number for output.
 *
 * One decimal place, no trailing zeros, no "-0". The canvas is 460 units wide
 * and displayed at most around 1400px, so a tenth of a unit is under a third of
 * a pixel — invisible, and it takes roughly a tenth off the file size across
 * the several thousand coordinates in a figure.
 */
function n(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`svg: non-finite coordinate ${value}`);
  }
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) return '0';
  return String(rounded);
}

/** Serialize an attribute object. `null`/`undefined`/`false` are skipped. */
function attrs(map) {
  if (!map) return '';
  let out = '';
  for (const [key, value] of Object.entries(map)) {
    if (value === null || value === undefined || value === false) continue;
    if (value === true) {
      out += ` ${key}`;
      continue;
    }
    out += ` ${key}="${escapeAttr(String(value))}"`;
  }
  return out;
}

function escapeAttr(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeText(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** `<tag ...>children</tag>`, or self-closing when there are no children. */
function el(tag, attributes, children) {
  const head = `<${tag}${attrs(attributes)}`;
  if (children === null || children === undefined || children === '') {
    return `${head}/>`;
  }
  const body = Array.isArray(children) ? children.filter(Boolean).join('') : String(children);
  if (body === '') return `${head}/>`;
  return `${head}>${body}</${tag}>`;
}

const g = (attributes, children) => el('g', attributes, children);
const path = (d, attributes) => el('path', { d, ...attributes });
const circle = (cx, cy, r, attributes) => el('circle', { cx: n(cx), cy: n(cy), r: n(r), ...attributes });
const ellipse = (cx, cy, rx, ry, attributes) =>
  el('ellipse', { cx: n(cx), cy: n(cy), rx: n(rx), ry: n(ry), ...attributes });
const rect = (x, y, w, h, attributes) =>
  el('rect', { x: n(x), y: n(y), width: n(w), height: n(h), ...attributes });
const line = (x1, y1, x2, y2, attributes) =>
  el('line', { x1: n(x1), y1: n(y1), x2: n(x2), y2: n(y2), ...attributes });
const text = (x, y, content, attributes) =>
  el('text', { x: n(x), y: n(y), ...attributes }, escapeText(content));

const defs = (children) => el('defs', null, children);
const linearGradient = (id, stops, attributes) =>
  el('linearGradient', { id, ...attributes },
    stops.map((s) => el('stop', { offset: s.at, 'stop-color': s.color, 'stop-opacity': s.opacity })));
const radialGradient = (id, stops, attributes) =>
  el('radialGradient', { id, ...attributes },
    stops.map((s) => el('stop', { offset: s.at, 'stop-color': s.color, 'stop-opacity': s.opacity })));

/**
 * `M x y L x y ...` from `[[x, y], ...]`.
 * `close` appends `Z`, which also fixes the join at the start point.
 */
function polyPath(points, close = true) {
  if (!points.length) return '';
  const [first, ...rest] = points;
  let d = `M${n(first[0])} ${n(first[1])}`;
  for (const [x, y] of rest) d += `L${n(x)} ${n(y)}`;
  return close ? `${d}Z` : d;
}

const polygon = (points, attributes) => el('polygon', { points: points.map((p) => `${n(p[0])},${n(p[1])}`).join(' '), ...attributes });

/** Mirror a point list across a vertical axis. */
const mirrorX = (points, axis) => points.map(([x, y]) => [axis * 2 - x, y]);

/** Linear interpolation; `t` is not clamped, so it doubles as extrapolation. */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Point at `distance` from `[x, y]` along `angle` (radians, 0 = +x, y grows down). */
function polar(x, y, distance, angle) {
  return [x + Math.cos(angle) * distance, y + Math.sin(angle) * distance];
}

/**
 * Catmull-Rom through `points`, emitted as cubic beziers.
 *
 * `tension` 1 is the standard spline; lower values pull the curve tighter to
 * the straight polyline, which is how you get "sharp corner here, soft curve
 * there" without switching curve types mid-shape.
 */
function smoothOpen(points, tension = 1) {
  if (points.length < 2) return '';
  if (points.length === 2) return polyPath(points, false);

  const pts = points;
  const at = (i) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  let d = `M${n(pts[0][0])} ${n(pts[0][1])}`;

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1x = p1[0] + ((p2[0] - p0[0]) / 6) * tension;
    const c1y = p1[1] + ((p2[1] - p0[1]) / 6) * tension;
    const c2x = p2[0] - ((p3[0] - p1[0]) / 6) * tension;
    const c2y = p2[1] - ((p3[1] - p1[1]) / 6) * tension;
    d += `C${n(c1x)} ${n(c1y)} ${n(c2x)} ${n(c2y)} ${n(p2[0])} ${n(p2[1])}`;
  }
  return d;
}

function smoothClosed(points, tension = 1) {
  if (points.length < 3) return polyPath(points, true);
  const count = points.length;
  const at = (i) => points[((i % count) + count) % count];
  let d = `M${n(points[0][0])} ${n(points[0][1])}`;

  for (let i = 0; i < count; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1x = p1[0] + ((p2[0] - p0[0]) / 6) * tension;
    const c1y = p1[1] + ((p2[1] - p0[1]) / 6) * tension;
    const c2x = p2[0] - ((p3[0] - p1[0]) / 6) * tension;
    const c2y = p2[1] - ((p3[1] - p1[1]) / 6) * tension;
    d += `C${n(c1x)} ${n(c1y)} ${n(c2x)} ${n(c2y)} ${n(p2[0])} ${n(p2[1])}`;
  }
  return `${d}Z`;
}

/** Wrap children in a `<svg>` root with a viewBox and the shared style block. */
function root(viewBox, children, options = {}) {
  const [x, y, w, h] = viewBox;
  const label = options.title || options.label;
  return el('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: `${n(x)} ${n(y)} ${n(w)} ${n(h)}`,
    width: options.width || n(w),
    height: options.height || n(h),
    role: 'img',
    'aria-label': label,
    preserveAspectRatio: options.preserveAspectRatio || 'xMidYMid meet',
  }, [
    options.title ? el('title', null, escapeText(options.title)) : '',
    options.style ? el('style', null, options.style) : '',
    options.defs || '',
    children,
  ]);
}

/**
 * Merge a shape's fill with the shared outline treatment.
 *
 * Every visible shape in this art goes through here, which is what keeps the
 * line weight and join style consistent across five characters, six creatures
 * and however many props. It is the single biggest reason the set looks like
 * one artist drew it.
 *
 * `ink` is optional: a stroked detail supplies its own `stroke`/`stroke-width`
 * and passes nothing, and only the join style is applied.
 */
function shape(attributes, ink) {
  const base = { 'stroke-linejoin': 'round', 'stroke-linecap': 'round' };
  if (ink && ink.color) base.stroke = ink.color;
  if (ink && ink.width !== undefined) base['stroke-width'] = ink.width;
  return { ...base, ...attributes };
}

module.exports = {
  n, attrs, el, g, path, polygon, circle, ellipse, rect, line, text,
  defs, linearGradient, radialGradient,
  polyPath, smoothOpen, smoothClosed, mirrorX, lerp, polar, root, shape,
  escapeText, escapeAttr,
};
