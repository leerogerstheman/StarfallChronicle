'use strict';

/**
 * Hair.
 *
 * Hair does most of the work of telling five silhouettes apart, so the goal
 * here is legibility at a glance rather than strand-by-strand realism:
 *
 *   ayaha    short, asymmetric, blown to one side
 *   rinne    shoulder length, wavy, one long front lock, goggles on the crown
 *   rin      very long and straight, blunt fringe
 *   byakuya  spiky and short on top, thin ponytail to the waist
 *   elise    long and wavy, circlet and veil
 *
 * Two primitives do all of it. `piece` builds a closed silhouette from an
 * explicit upper edge and a lower edge (the lower edge is where the strand
 * points live, so "make the fringe sharper" means editing one list of points).
 * `lock` is the limb primitive from `body.js` reused as a tapered strand —
 * a hair lock and a forearm are the same shape problem, and sharing the code
 * means they share the same rounded ends and swell.
 */

const { path, circle, ellipse, el, smoothClosed, smoothOpen, shape, polyPath } = require('./svg');
const { INK, STROKE, shade } = require('./palette');
const { limb } = require('./body');

/** Closed hair silhouette: upper edge then lower edge, both left to right. */
function piece(upper, lower, tension = 0.92) {
  return smoothClosed([...upper, ...lower], tension);
}

/** A tapered strand. Thin wrapper so hair call sites do not import body.js. */
function lock(a, b, wa, wb, options = {}) {
  return limb(a, b, wa, wb, { bulge: options.bulge ?? 2, ...options });
}

function inkStroke(width = STROKE.outer) {
  return { color: INK, width };
}

/**
 * Draw a hair mass.
 *
 * `shadow` is the darker under-layer. Every style gets one because a single
 * flat fill makes hair look like a helmet; a second shape offset down and to
 * the left is enough to imply volume and matches the figure's light direction.
 */
function mass(d, fill, options = {}) {
  const { stroke = STROKE.outer, shadeFill } = options;
  const parts = [];
  if (shadeFill) {
    parts.push(path(d, shape({ fill: shadeFill, transform: 'translate(-5 7)' }, inkStroke(stroke))));
  }
  parts.push(path(d, shape({ fill }, inkStroke(stroke))));
  return parts.join('');
}

// ===========================================================================
// 1. Ayaha — short, asymmetric, windblown
// ===========================================================================

function ayaha(colors) {
  const { base, shadow } = colors;

  const back = mass(piece(
    [[172, 150], [166, 104], [186, 74], [230, 64], [274, 74], [294, 106], [288, 156]],
    [[284, 176], [268, 158], [240, 172], [206, 160], [180, 178]],
  ), base, { shadeFill: shadow });

  // Two long locks swept to the viewer's left: the wind reads as motion even
  // in a still frame, and it breaks the head's symmetry.
  const swept = [
    lock([196, 96], [130, 118], 20, 12, { bend: [158, 92] }),
    lock([190, 122], [124, 168], 16, 8, { bend: [150, 132] }),
  ].map((d) => path(d, shape({ fill: base }, inkStroke()))).join('');

  const front = mass(piece(
    [[176, 148], [170, 106], [188, 78], [230, 70], [272, 80], [290, 110], [286, 150]],
    [
      [280, 128], [268, 146], [256, 116], [242, 138], [228, 110],
      [212, 136], [198, 112], [186, 140], [178, 122],
    ],
  ), base, { shadeFill: shadow });

  return { back: back + swept, front };
}

// ===========================================================================
// 2. Rinné — shoulder length, wavy, goggles
// ===========================================================================

function rinne(colors) {
  const { base, shadow } = colors;

  const back = mass(piece(
    [[168, 152], [162, 100], [188, 72], [230, 62], [276, 74], [300, 108], [296, 166],
      [312, 232], [300, 296], [286, 246], [274, 300], [262, 240], [250, 292]],
    [[240, 288], [228, 238], [216, 296], [200, 240], [186, 292], [172, 236], [158, 288],
      [146, 240], [152, 172], [160, 150]],
  ), base, { shadeFill: shadow });

  const front = mass(piece(
    [[174, 146], [168, 104], [188, 76], [230, 68], [274, 78], [292, 110], [288, 148]],
    [
      [282, 124], [270, 142], [258, 112], [246, 136], [236, 106],
      [226, 136], [214, 108], [202, 138], [190, 112], [180, 136],
    ],
  ), base, { shadeFill: shadow });

  // One long lock down the viewer's left cheek, past the jaw.
  const sideLock = path(
    lock([186, 130], [176, 268], 17, 9, { bend: [166, 198] }),
    shape({ fill: base }, inkStroke()),
  );

  // Braid: three overlapping beads down the lock, which reads as a plait
  // without drawing individual strands.
  const braid = [0, 1, 2].map((i) => ellipse(180, 196 + i * 34, 15 - i * 2, 12 - i * 1.5, {
    fill: shade(base, i % 2 === 0 ? 0.12 : -0.08),
    stroke: INK, 'stroke-width': STROKE.fine,
  })).join('');

  return { back, front: front + sideLock + braid, accessory: goggles(colors) };
}

function goggles(colors) {
  const strap = path(smoothOpen([[176, 92], [230, 78], [286, 96]], 0.8), shape({
    fill: 'none', stroke: '#3b2a1c', 'stroke-width': 9,
  }));
  const lens = (x) => [
    circle(x, 86, 15, { fill: '#7fd7e8', stroke: INK, 'stroke-width': STROKE.inner }),
    circle(x - 5, 81, 5, { fill: '#ffffff', opacity: 0.65 }),
  ].join('');
  const rims = path(smoothOpen([[188, 88], [230, 80], [272, 90]], 0.8), shape({
    fill: 'none', stroke: colors.shadow, 'stroke-width': 5,
  }));
  return strap + lens(206) + lens(254) + rims;
}

// ===========================================================================
// 3. Rin — very long and straight, blunt fringe
// ===========================================================================

function rin(colors) {
  const { base, shadow } = colors;

  const back = mass(piece(
    [[166, 156], [158, 96], [188, 66], [230, 56], [278, 70], [306, 104], [302, 176],
      [318, 330], [312, 500], [292, 516], [286, 340], [278, 470], [266, 320]],
    [[258, 500], [252, 330], [240, 470], [230, 318], [218, 468], [206, 330], [198, 500],
      [184, 322], [176, 470], [160, 340], [154, 180], [158, 154]],
  ), base, { shadeFill: shadow, stroke: STROKE.outer });

  const front = mass(piece(
    [[172, 150], [166, 100], [188, 70], [230, 62], [276, 74], [296, 108], [292, 148]],
    [
      [290, 132], [278, 136], [268, 130], [256, 136], [244, 129],
      [232, 136], [220, 129], [208, 136], [196, 130], [186, 136], [176, 130],
    ],
    0.75,
  ), base, { shadeFill: shadow });

  // Two straight locks framing the face down past the collarbone.
  const side = [-1, 1].map((s) => path(
    lock([230 + 46 * s, 132], [230 + 52 * s, 288], 15, 11, { bend: [230 + 58 * s, 210] }),
    shape({ fill: s < 0 ? base : shade(base, -0.1) }, inkStroke()),
  )).join('');

  return { back, front: front + side, accessory: snowPin(colors) };
}

function snowPin(colors) {
  const cx = 282;
  const cy = 112;
  const arms = [0, 60, 120].map((deg) => el('line', {
    x1: cx - Math.cos((deg * Math.PI) / 180) * 16,
    y1: cy - Math.sin((deg * Math.PI) / 180) * 16,
    x2: cx + Math.cos((deg * Math.PI) / 180) * 16,
    y2: cy + Math.sin((deg * Math.PI) / 180) * 16,
    stroke: '#dff4ff', 'stroke-width': 4, 'stroke-linecap': 'round',
  })).join('');
  return el('g', null, [
    circle(cx, cy, 17, { fill: shade(colors.base, -0.35), stroke: INK, 'stroke-width': STROKE.inner }),
    arms,
    circle(cx, cy, 5, { fill: '#ffffff' }),
  ].join(''));
}

// ===========================================================================
// 4. Byakuya — spiky short, thin ponytail
// ===========================================================================

function byakuya(colors) {
  const { base, shadow } = colors;

  // Ponytail first: it falls behind the shoulder, so it belongs in `back`.
  const tail = path(
    lock([272, 128], [300, 546], 19, 7, { bend: [318, 330], bulge: 4 }),
    shape({ fill: shadow }, inkStroke()),
  );
  const tie = ellipse(276, 136, 13, 9, {
    fill: '#2f3550', stroke: INK, 'stroke-width': STROKE.fine,
  });

  const back = mass(piece(
    [[170, 148], [164, 100], [186, 70], [230, 60], [276, 72], [298, 106], [292, 152]],
    [[288, 170], [268, 152], [236, 166], [204, 154], [178, 172]],
  ), base, { shadeFill: shadow });

  // Spiky fringe: the lower edge is a saw of alternating long and short points.
  const front = mass(piece(
    [[174, 146], [168, 100], [188, 70], [230, 60], [274, 72], [294, 106], [290, 146]],
    [
      [288, 118], [276, 142], [268, 108], [256, 140], [246, 104],
      [234, 138], [224, 102], [212, 140], [202, 110], [192, 142], [182, 116],
    ],
    0.45,
  ), base, { shadeFill: shadow });

  // A few strands breaking the silhouette upward, which is what makes it read
  // as "spiky" rather than "short".
  //
  // Heights are capped around y = 50 rather than y = 26. Byakuya is drawn at
  // scale 1.06, and the scale is anchored at the ground, so a strand at y = 26
  // lands at y = -27 — above the canvas, and clipped. The taller the character,
  // the more headroom their hair needs; this is the only place in the art where
  // that coupling is not obvious.
  const spikes = [
    [[186, 78], [162, 56], [180, 92]],
    [[216, 64], [206, 48], [232, 68]],
    [[258, 68], [270, 52], [270, 76]],
    [[288, 92], [310, 70], [296, 104]],
  ].map((pts) => path(polyPath(pts), shape({ fill: base }, inkStroke(STROKE.inner)))).join('');

  return { back: back + tail + tie, front: front + spikes };
}

// ===========================================================================
// 5. Elise — long and wavy, circlet and veil
// ===========================================================================

function elise(colors) {
  const { base, shadow } = colors;

  const veil = path(piece(
    [[158, 120], [176, 66], [230, 44], [284, 66], [304, 120],
      [322, 300], [300, 470], [276, 300], [258, 460], [236, 296]],
    [[214, 452], [196, 294], [176, 456], [152, 296], [140, 440], [136, 200], [152, 128]],
  ), shape({ fill: '#eceff7', 'fill-opacity': 0.24, stroke: '#cdd6ea', 'stroke-width': STROKE.fine }, {}));

  const back = mass(piece(
    [[166, 154], [160, 98], [188, 68], [230, 58], [278, 72], [300, 106], [296, 168],
      [314, 268], [302, 392], [288, 300], [278, 420], [264, 296], [252, 404]],
    [[240, 396], [228, 292], [216, 410], [202, 294], [190, 400], [174, 290], [160, 386],
      [148, 268], [156, 176], [160, 152]],
  ), base, { shadeFill: shadow });

  const front = mass(piece(
    [[172, 148], [166, 102], [188, 72], [230, 64], [276, 76], [296, 108], [292, 146]],
    [
      [286, 126], [274, 144], [264, 114], [252, 140], [242, 110],
      [232, 142], [220, 112], [208, 140], [198, 114], [188, 142], [178, 120],
    ],
  ), base, { shadeFill: shadow });

  const braid = [0, 1, 2, 3].map((i) => ellipse(272 + i * 3, 108 + i * 26, 16 - i * 1.5, 12, {
    fill: shade(base, i % 2 === 0 ? 0.14 : -0.06),
    stroke: INK, 'stroke-width': STROKE.fine,
  })).join('');

  return { back: veil + back, front: front + braid, accessory: circlet(colors) };
}

function circlet(colors) {
  const band = path(smoothOpen([[178, 122], [230, 100], [282, 124]], 0.85), shape({
    fill: 'none', stroke: '#e8cd7c', 'stroke-width': 7,
  }));
  const gem = path(smoothClosed([
    [230, 92], [240, 104], [230, 118], [220, 104],
  ], 0.4), shape({ fill: colors.accent, stroke: INK, 'stroke-width': STROKE.fine }));
  return band + gem;
}

// ===========================================================================
// 6. Bun — hair pulled back tight, wound up at the crown (innkeeper)
// ===========================================================================

function bun(colors) {
  const { base, shadow } = colors;

  // The bun sits above and slightly behind the skull. Drawing it in `back`
  // rather than `front` matters: it has to be occluded by the head, otherwise
  // it reads as a hat.
  const knot = [
    ellipse(238, 52, 36, 32, { fill: base, stroke: INK, 'stroke-width': STROKE.outer }),
    ellipse(238, 52, 22, 19, { fill: shadow, opacity: 0.5 }),
    path(smoothOpen([[212, 40], [232, 28], [256, 34]], 0.7),
      shape({ fill: 'none', stroke: shade(base, -0.2), 'stroke-width': 4 })),
  ].join('');

  const back = knot + mass(piece(
    [[176, 150], [170, 106], [190, 78], [230, 70], [272, 80], [290, 112], [286, 152]],
    [[282, 168], [258, 152], [230, 162], [202, 152], [180, 168]],
  ), base, { shadeFill: shadow });

  const front = mass(piece(
    [[178, 146], [172, 106], [192, 80], [230, 74], [270, 84], [286, 112], [282, 146]],
    [
      [280, 124], [266, 134], [252, 118], [238, 132], [226, 116],
      [214, 132], [200, 118], [188, 134], [180, 122],
    ],
    0.6,
  ), base, { shadeFill: shadow });

  // Two loose strands at the temples. A perfectly smooth pull-back reads as
  // bald from the front; these are what say "hair".
  const loose = [-1, 1].map((s) => path(
    lock([230 + 52 * s, 120], [230 + 62 * s, 186], 9, 4, { bend: [230 + 66 * s, 152] }),
    shape({ fill: shade(base, -0.12) }, inkStroke(STROKE.inner)),
  )).join('');

  return { back, front: front + loose };
}

// ===========================================================================
// 7. Crop — short, neat, greying at the temples (quartermaster)
// ===========================================================================

function crop(colors) {
  const { base, shadow } = colors;

  const back = mass(piece(
    [[180, 144], [174, 104], [194, 78], [230, 70], [268, 80], [286, 110], [282, 146]],
    [[278, 156], [252, 146], [230, 152], [206, 146], [182, 156]],
  ), base, { shadeFill: shadow });

  const front = mass(piece(
    [[182, 140], [176, 104], [196, 78], [230, 72], [266, 82], [282, 110], [278, 140]],
    [
      [276, 122], [262, 128], [248, 120], [234, 126], [220, 120],
      [206, 126], [192, 120], [184, 126],
    ],
    0.5,
  ), base, { shadeFill: shadow });

  // Grey at the temples: two small pale wedges, which is the cheapest way to
  // make a face read as older without touching the face itself.
  const grey = [-1, 1].map((s) => path(smoothClosed([
    [230 + 50 * s, 112], [230 + 60 * s, 124], [230 + 52 * s, 144], [230 + 44 * s, 128],
  ], 0.5), shape({ fill: shade(base, 0.34), stroke: INK, 'stroke-width': STROKE.fine }))).join('');

  return { back, front: front + grey };
}

// ===========================================================================

const STYLES = { ayaha, rinne, rin, byakuya, elise, bun, crop };

/** Build `{ back, front, accessory }` markup for a style id. */
function hair(styleId, colors) {
  const build = STYLES[styleId];
  if (!build) throw new Error(`Unknown hair style: ${styleId}`);
  const result = build(colors);
  return { back: result.back || '', front: result.front || '', accessory: result.accessory || '' };
}

module.exports = { hair, STYLES, piece, lock, mass };
