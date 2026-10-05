'use strict';

/**
 * Creatures.
 *
 * Enemies are not humanoids, so they do not get the humanoid skeleton — but
 * they do share the palette, the ink weight, the light direction and the
 * element motifs, which is what keeps a grub and a boss in the same picture
 * book.
 *
 * The canvas is square and smaller than a character sheet (400 vs 460 wide)
 * because enemies are drawn into battle cards, not standing art. Everything is
 * built from four primitives:
 *
 *   blob    a smooth closed mass — the body
 *   plate   a hard-edged closed mass — carapace, stone, armour
 *   spike   a tapered point — mandibles, claws, horns, legs
 *   eye     a lens with a highlight, in one of three shapes
 *
 * A creature spec supplies a `build` function that places those. Nothing else
 * is shared, because "what shape is a bug" has no useful common answer.
 */

const { root, path, el, g, circle, ellipse, smoothClosed, smoothOpen, shape, defs } = require('./svg');
const { INK, STROKE, shade, aura, ELEMENT_ACCENT } = require('./palette');
const { motifs, auraBackdrop, groundShadow } = require('./motifs');
const { limb } = require('./body');

const CANVAS = { w: 400, h: 400, ground: 348, axis: 200 };

const ink = (w = STROKE.outer) => ({ color: INK, width: w });

/** A smooth organic mass. */
function blob(points, fill, options = {}) {
  const { tension = 0.9, weight = STROKE.outer, extra = {} } = options;
  return path(smoothClosed(points, tension), shape({ fill, ...extra }, ink(weight)));
}

/** A hard-edged mass: carapace, stone, crystal. */
function plate(points, fill, options = {}) {
  const { weight = STROKE.outer, extra = {} } = options;
  return path(smoothClosed(points, 0.12), shape({ fill, ...extra }, ink(weight)));
}

/** A tapered point. Reuses the limb primitive so ends stay rounded. */
function spike(from, to, wa, wb, fill, options = {}) {
  const { bend, weight = STROKE.outer } = options;
  return path(limb(from, to, wa, wb, { bend }), shape({ fill }, ink(weight)));
}

/**
 * A lens.
 *
 * `style` picks between a round eye, a slit (predators and constructs) and a
 * cluster (things that should have too many eyes). The highlight is always
 * upper-left-of-centre so every creature looks lit from the same side.
 */
function eye(cx, cy, r, options = {}) {
  const { iris = '#ffd166', style = 'round', pupil = '#0a0c14', uid = 'art', count = 0 } = options;

  if (style === 'cluster') {
    const parts = [];
    for (let i = 0; i < 3; i++) {
      const a = (Math.PI * 2 * i) / 3 - Math.PI / 2;
      parts.push(circle(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9, r * 0.5, {
        fill: pupil, stroke: INK, 'stroke-width': STROKE.fine,
      }));
      parts.push(circle(cx + Math.cos(a) * r * 0.9 - r * 0.15, cy + Math.sin(a) * r * 0.9 - r * 0.15,
        r * 0.16, { fill: '#ffffff', opacity: 0.8 }));
    }
    return el('g', null, parts.join(''));
  }

  const slit = style === 'slit';
  const body = slit
    ? ellipse(cx, cy, r, r * 0.42, { fill: iris, stroke: INK, 'stroke-width': STROKE.fine })
    : circle(cx, cy, r, { fill: iris, stroke: INK, 'stroke-width': STROKE.fine });
  const pupilShape = slit
    ? ellipse(cx, cy, r * 0.22, r * 0.36, { fill: pupil })
    : circle(cx, cy, r * 0.44, { fill: pupil });

  return el('g', null, [
    body,
    pupilShape,
    circle(cx - r * 0.3, cy - r * 0.3, r * 0.2, { fill: '#ffffff', opacity: 0.85 }),
    count ? '' : '',
  ].join(''));
}

/** A segmented leg or tendril ending in a claw. */
function leg(hip, foot, width, fill, options = {}) {
  const { bend, claw = null } = options;
  const parts = [spike(hip, foot, width, width * 0.45, fill, { bend })];
  if (claw) {
    const tip = [foot[0] + claw[0], foot[1] + claw[1]];
    parts.push(spike(foot, tip, width * 0.5, 1.6, claw[2] || fill, {}));
  }
  return parts.join('');
}

/** Rings of cracked light, used for anything burning from the inside. */
function cracks(lines, color) {
  return lines.map((pts) => path(smoothOpen(pts, 0.15), shape({
    fill: 'none', stroke: color, 'stroke-width': 4.5, opacity: 0.9,
  }))).join('');
}

/**
 * Assemble a creature.
 *
 * The spec supplies `build(ctx)` returning a layer map. Layers are emitted in a
 * fixed order so a spec never has to think about it, and so an enemy added
 * later cannot accidentally draw its eyes behind its head.
 */
const ORDER = ['aura', 'ground', 'back', 'body', 'over', 'front'];

function render(spec, options = {}) {
  const { expression = 'neutral', view = 'full', phase = 1 } = options;
  const uid = options.uid || spec.id || 'art';
  const accent = spec.accent || ELEMENT_ACCENT[spec.element] || ELEMENT_ACCENT.physical;
  // A creature's aura and motif are chosen independently of its element: an
  // enemy has weaknesses, not an element, so "forest bug" and "stone construct"
  // are the useful labels here.
  const auraKind = spec.auraKind || (spec.element === 'physical' ? 'enemy' : spec.element);
  const tint = aura(auraKind);

  const ctx = {
    accent,
    uid,
    phase,
    view,
    ink,
    blob,
    plate,
    spike,
    eye,
    leg,
    cracks,
    shade,
  };

  const built = spec.build(ctx) || {};
  const plain = options.plain === true || options.plain === '1' || options.plain === 'true';
  const withBackdrop = options.showAura !== false && !plain;
  const layers = {
    aura: withBackdrop ? auraBackdrop(spec.element, tint, `${uid}-aura`).body : '',
    ground: withBackdrop ? groundShadow() : '',
    back: built.back || '',
    body: built.body || '',
    over: built.over || '',
    front: built.front || '',
    motif: (options.showMotifs === false || plain) ? '' : motifs(spec.motifKind || spec.element, accent),
  };

  const viewBox = view === 'bust' ? spec.bust || [70, 60, 260, 260] : [0, 0, CANVAS.w, CANVAS.h];
  const svg = root(viewBox, [...ORDER.map((k) => layers[k] || ''), layers.motif].join(''), {
    title: `${spec.name}${spec.title ? ` · ${spec.title}` : ''}`,
    label: spec.name,
    defs: withBackdrop ? auraBackdrop(spec.element, tint, `${uid}-aura`).defs : '',
  });

  return { svg, built, layers };
}

module.exports = { render, CANVAS, ORDER, blob, plate, spike, eye, leg, cracks, ink };
