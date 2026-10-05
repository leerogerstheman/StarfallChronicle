'use strict';

/**
 * Element motifs.
 *
 * The thing behind a character in a poster frame. Two jobs: it tells you the
 * character's element before you read a single word of UI, and it fills the
 * empty corners of a tall canvas so a standing figure does not look like a
 * sticker on a wall.
 *
 * Every motif is placed in the *background band* — outside the figure's
 * silhouette, roughly x < 150 or x > 310 — so it can never be mistaken for
 * part of the costume. That constraint is why the anchor lists below look
 * arbitrary: they are the safe zones.
 */

const { path, circle, el, ellipse, smoothOpen, smoothClosed, shape, polyPath, defs, radialGradient } = require('./svg');
const { INK, STROKE, shade } = require('./palette');

/** Safe background anchors, left column then right column, top to bottom. */
const SLOTS = [
  [72, 190], [58, 360], [86, 540], [64, 720],
  [388, 168], [404, 340], [376, 520], [398, 700],
];

function wind(accent) {
  return SLOTS.slice(0, 5).map(([x, y], i) => {
    const s = 26 + (i % 3) * 10;
    return path(smoothOpen([
      [x - s, y + s * 0.5], [x, y], [x + s, y - s * 0.2],
    ], 0.9), shape({
      fill: 'none', stroke: accent, 'stroke-width': 4.5, opacity: 0.55,
    }));
  }).join('');
}

function fire(accent) {
  return SLOTS.slice(0, 6).map(([x, y], i) => {
    const s = 15 + (i % 3) * 7;
    const lick = path(smoothClosed([
      [x - s, y + s], [x - s * 0.3, y - s * 0.6], [x, y - s * 1.7],
      [x + s * 0.4, y - s * 0.5], [x + s, y + s],
    ], 0.7), shape({ fill: accent, opacity: 0.4 }, {}));
    return lick;
  }).join('') + SLOTS.slice(0, 8).map(([x, y], i) => circle(
    x + 24, y - 60, 3 + (i % 2), { fill: accent, opacity: 0.6 },
  )).join('');
}

function ice(accent) {
  return SLOTS.slice(0, 6).map(([x, y], i) => {
    const s = 16 + (i % 3) * 8;
    const shard = path(smoothClosed([
      [x, y - s * 1.8], [x + s * 0.7, y], [x, y + s * 1.8], [x - s * 0.7, y],
    ], 0.3), shape({ fill: accent, opacity: 0.34, stroke: shade(accent, 0.3), 'stroke-width': 2 }, {}));
    return shard;
  }).join('');
}

function lightning(accent) {
  return SLOTS.slice(0, 5).map(([x, y], i) => {
    const s = 30 + (i % 2) * 14;
    return path(smoothOpen([
      [x - s * 0.5, y - s], [x + s * 0.3, y - s * 0.2],
      [x - s * 0.25, y + s * 0.1], [x + s * 0.6, y + s],
    ], 0.15), shape({
      fill: 'none', stroke: accent, 'stroke-width': 5, opacity: 0.6,
    }));
  }).join('');
}

function imaginary(accent) {
  return SLOTS.slice(0, 8).map(([x, y], i) => {
    const r = 5 + (i % 3) * 4;
    return el('g', { opacity: 0.6 }, [
      circle(x, y, r, { fill: accent }),
      el('line', {
        x1: x - r * 2.4, y1: y, x2: x + r * 2.4, y2: y,
        stroke: accent, 'stroke-width': 2.4, opacity: 0.7,
      }),
      el('line', {
        x1: x, y1: y - r * 2.4, x2: x, y2: y + r * 2.4,
        stroke: accent, 'stroke-width': 2.4, opacity: 0.7,
      }),
    ].join(''));
  }).join('');
}

function quantum(accent) {
  return SLOTS.slice(0, 5).map(([x, y], i) => {
    const s = 20 + (i % 3) * 10;
    return el('g', { opacity: 0.42 }, [
      path(smoothClosed([[x, y - s], [x + s, y], [x, y + s], [x - s, y]], 0.1),
        shape({ fill: 'none', stroke: accent, 'stroke-width': 4 })),
      circle(x, y, s * 0.28, { fill: accent }),
    ].join(''));
  }).join('');
}

function physical(accent) {
  return SLOTS.slice(0, 4).map(([x, y], i) => {
    const s = 34 + i * 6;
    return path(smoothOpen([
      [x - s * 0.5, y + s], [x + s * 0.4, y - s],
    ], 0.3), shape({
      fill: 'none', stroke: accent, 'stroke-width': 5, opacity: 0.35,
    }));
  }).join('');
}

/**
 * Drifting spores. Forest creatures get this instead of `wind`, whose swooshes
 * read as motion — wrong for something that sits in leaf litter.
 */
function spore(accent) {
  return SLOTS.slice(0, 8).map(([x, y], i) => {
    const r = 4 + (i % 3) * 3;
    const dx = (i % 2 ? 18 : -14);
    return el('g', { opacity: 0.5 }, [
      circle(x + dx, y, r, { fill: accent }),
      circle(x + dx, y, r * 2.6, { fill: 'none', stroke: accent, 'stroke-width': 1.6, opacity: 0.6 }),
    ].join(''));
  }).join('');
}

/** Loose embers rising off something that has burned for a long time. */
function ember(accent) {
  return SLOTS.slice(0, 8).map(([x, y], i) => {
    const r = 3 + (i % 3) * 2.5;
    return el('g', { opacity: 0.55 }, [
      circle(x, y, r, { fill: accent }),
      path(smoothOpen([
        [x, y + r * 1.5], [x - 6, y + 30], [x + 4, y + 58],
      ], 0.7), shape({ fill: 'none', stroke: accent, 'stroke-width': 2.2, opacity: 0.6 })),
    ].join(''));
  }).join('');
}

const MOTIFS = { wind, fire, ice, lightning, imaginary, quantum, physical, spore, ember };

function motifs(element, accent) {
  const build = MOTIFS[element] || MOTIFS.physical;
  return build(accent);
}

/**
 * The soft disc behind a figure.
 *
 * A radial gradient rather than a flat circle: a hard edge behind a hard-edged
 * figure makes both look cheap, and the gradient costs one `<defs>` entry.
 */
function auraBackdrop(element, tint, id = 'aura') {
  const stops = [
    { at: '0%', color: tint.inner, opacity: 0.95 },
    { at: '62%', color: tint.inner, opacity: 0.45 },
    { at: '100%', color: tint.outer, opacity: 0 },
  ];
  return {
    defs: defs(radialGradient(id, stops, { cx: '50%', cy: '42%', r: '62%' })),
    body: ellipse(230, 430, 232, 400, { fill: `url(#${id})` }),
  };
}

/** Contact shadow under the feet. */
function groundShadow() {
  return ellipse(230, 908, 132, 20, { fill: '#05070d', opacity: 0.5 });
}

module.exports = { motifs, MOTIFS, auraBackdrop, groundShadow, SLOTS };
