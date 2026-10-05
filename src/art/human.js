'use strict';

/**
 * Assemble a character.
 *
 * This is the only place that knows the draw order, and the order is the whole
 * design. Almost every "why does this look wrong" in flat vector character art
 * is a layer in the wrong place — a collar under the jaw, a weapon behind the
 * fingers, hair behind the face it should cover. Pinning it down once, with a
 * comment per step, means a new character cannot get it wrong.
 */

const { root, g, path, ellipse, el, shape } = require('./svg');
const { skinTones, shade, aura, ELEMENT_ACCENT } = require('./palette');
const body = require('./body');
const { face } = require('./face');
const { hair } = require('./hair');
const { weapon } = require('./gear');
const { motifs, auraBackdrop, groundShadow } = require('./motifs');

const { resolvePose, bustView, CANVAS } = body;

/**
 * Build the layered markup for one character.
 *
 * Returns the layers separately as well as joined, because the art test wants
 * to assert *what* is in each band (for example: no skin-coloured shape may
 * appear above the hair) rather than just that the file parses.
 */
function figure(spec, options = {}) {
  const { expression = 'neutral', view = 'full', showMotifs = true, showAura = true } = options;
  // Every generated id is prefixed with the character id. Clip paths and
  // gradients are document-global, so two characters on one page would
  // otherwise fight over `#face-shade` and `#aura` — and the loser would
  // silently get the other one's element gradient.
  const uid = options.uid || spec.id || 'art';
  const pose = resolvePose(spec.pose);
  const skin = skinTones(spec.skin || 'light');
  const accent = spec.accent || ELEMENT_ACCENT[spec.element] || ELEMENT_ACCENT.physical;
  const hairColors = {
    base: spec.hair.base,
    shadow: spec.hair.shadow || shade(spec.hair.base, -0.34),
    accent,
  };

  const hairParts = hair(spec.hair.style, hairColors);
  const costume = spec.costume(pose, { accent, skin, colors: spec.colors || {} });
  const prop = weapon(spec.weapon, pose, { accent, ...(spec.gear || {}) });
  const skinParts = body.bodyBase(pose, { skin });
  const inkOuter = body.ink('outer');
  const inkInner = body.ink('inner');
  const fill = (d, color, weight = 'outer') => path(d, shape({ fill: color }, body.ink(weight)));

  const layers = {
    // Behind everything: the disc, then the contact shadow.
    aura: showAura ? auraBackdrop(spec.element, aura(spec.element), `${uid}-aura`).body : '',
    ground: showAura ? groundShadow() : '',

    // Behind the body: capes and coat tails, then the back hair mass, then the
    // neck (which the jaw and the collar both overlap).
    cape: costume.back || '',
    hairBack: hairParts.back || '',
    neck: fill(body.neck(pose), skin.shadow, 'inner'),

    // Bare limbs. Clothes are drawn over these, so a costume that forgets a
    // sleeve leaves a visible arm rather than a hole.
    legs: skinParts.filter((p) => p.layer === 'legs').map((p) => fill(p.d, p.fill)).join(''),
    // Boots go on before the costume: a long coat hem has to fall *over* the
    // boot top, and a coat drawn first would be sliced by it.
    boots: costume.boots || '',
    arms: skinParts.filter((p) => p.layer === 'arms').map((p) => fill(p.d, p.fill)).join(''),

    // Props that belong behind the torso, e.g. a spear across the back. Drawn
    // before the costume on purpose: the coat hides the middle of the shaft,
    // which is what "carried on the back" actually looks like.
    propBack: prop.back || '',

    // The costume itself.
    clothes: costume.mid || '',

    // Held props, then the hands over them so the fingers close on the grip.
    propMid: prop.mid || '',
    hands: (() => {
      const parts = [];
      for (const side of ['R', 'L']) {
        const h = body.hand(pose, side);
        const tone = side === 'L' ? skin.base : skin.shadow;
        parts.push(g({ transform: h.transform }, [
          path(h.thumb, shape({ fill: tone }, inkInner)),
          path(h.palm, shape({ fill: tone }, inkOuter)),
        ].join('')));
      }
      return parts.join('');
    })(),
    gloves: costume.hands || '',
    // Head last among the body parts: the jaw must cover the neck.
    //
    // The cheek shading is a copy of the face outline pushed toward the
    // light-away side and clipped back to the face. Clipping matters: without
    // it the shading shape sticks out past the jaw and reads as a second head.
    head: (() => {
      const clipId = `${uid}-face-shade`;
      return [
        ellipse(body.ear('L').cx, body.ear('L').cy, body.ear('L').rx, body.ear('L').ry,
          shape({ fill: skin.shadow }, inkInner)),
        ellipse(body.ear('R').cx, body.ear('R').cy, body.ear('R').rx, body.ear('R').ry,
          shape({ fill: skin.base }, inkInner)),
        fill(body.head(), skin.base),
        el('defs', null, el('clipPath', { id: clipId }, path(body.head(), {}))),
        el('g', { 'clip-path': `url(#${clipId})` }, path(body.head(), shape({
          fill: skin.shadow, opacity: 0.5, transform: 'translate(-52 0)',
        }))),
      ].join('');
    })(),

    face: face({
      skin,
      iris: spec.eye || accent,
      expression,
      browColor: spec.brow,
      uid,
      marks: spec.marks || {},
    }),
    hairFront: hairParts.front || '',
    hairAcc: hairParts.accessory || '',
    propFront: prop.front || '',
    motif: showMotifs ? motifs(spec.element, accent) : '',
  };

  return { layers, spec, pose, skin, accent };
}

/** Draw order, as an explicit list so nothing depends on object key order. */
const ORDER = [
  'aura', 'ground', 'cape', 'hairBack', 'neck', 'legs', 'boots', 'arms', 'propBack',
  'clothes', 'propMid', 'hands', 'gloves', 'head', 'face', 'hairFront',
  'hairAcc', 'propFront', 'motif',
];

function ordered(layers) {
  return ORDER.map((key) => layers[key] || '').join('');
}

/**
 * Full SVG document for a character.
 *
 * `view: 'bust'` is a crop of the same coordinates — the head, shoulders and
 * upper chest — so the battle HUD and the party screen can never disagree
 * about where a character's eyes are.
 *
 * `spec.scale` changes how tall the character is. It is applied about the
 * ground line, which is why `bustView` has to be recomputed rather than being
 * a constant. Cast members having different heights is the cheapest way to make
 * a lineup read as a group of people rather than a row of clones, and it is the
 * one thing a shared skeleton cannot express on its own.
 */
function render(spec, options = {}) {
  const bust = options.view === 'bust';
  const opts = bust || options.plain
    ? { ...options, showMotifs: false, showAura: false }
    : options;
  // Ids must be unique per character, not per document, because the same
  // character is drawn many times on one page (battle row, HUD, party list).
  const uid = options.uid || spec.id || 'art';
  const built = figure(spec, { ...opts, uid });
  const scale = Number.isFinite(spec.scale) ? spec.scale : 1;
  const viewBox = bust ? bustView(scale) : [0, 0, CANVAS.w, CANVAS.h];
  const auraDefs = opts.showAura === false
    ? ''
    : auraBackdrop(spec.element, aura(spec.element), `${uid}-aura`).defs;

  const inner = ordered(built.layers);
  const content = scale === 1
    ? inner
    : g({ transform: `translate(230 906) scale(${round(scale)}) translate(-230 -906)` }, inner);

  const svg = root(viewBox, content, {
    title: options.title || `${spec.name} ${spec.en || ''}`.trim(),
    defs: auraDefs,
    label: `${spec.name}${spec.title ? ` · ${spec.title}` : ''}`,
  });

  return { svg, built };
}

const round = (v) => Math.round(v * 1000) / 1000;

module.exports = { figure, render, ORDER, ordered };
