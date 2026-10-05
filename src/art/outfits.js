'use strict';

/**
 * Costumes.
 *
 * Five characters need five silhouettes, but they do not need five hundred
 * lines of one-off path data. The split here is: *construction* is shared
 * (`garment`, `skirt`, `boot`, `sleeve`, `collar`, `belt`, `cape`, `pauldron`)
 * and *proportion* is per character. So "Ayaha's coat is short and split, Rin's
 * is long and closed" is four numbers and one hem point list, not a redrawn
 * shape.
 *
 * The hem point lists matter more than they look. The lower edge of a garment
 * is the line that reads at a distance, so it is always authored explicitly —
 * pointed, split, scalloped or straight — rather than left as a straight cut.
 */

const { path, el, circle, ellipse, rect, smoothClosed, smoothOpen, shape, polyPath } = require('./svg');
const { INK, STROKE, shade } = require('./palette');
const { limb } = require('./body');

const ink = (w = STROKE.outer) => ({ color: INK, width: w });
const draw = (d, fill, w = STROKE.outer, extra = {}) => path(d, shape({ fill, ...extra }, ink(w)));

/**
 * A garment over the torso.
 *
 * Convention, shared by every hem in this module: a hem point list is authored
 * **left to right** along the bottom edge. The function reverses internally
 * where the traversal needs it, so call sites never have to think about which
 * way round the outline is going — that mistake produces a bow-tie, and it is
 * invisible until you look at the render.
 */
function garment(pose, options) {
  const {
    hemY = 520,
    hemHalf = 86,
    shoulderHalf = 78,
    neckDrop = 26,
    hem = null,
    neckline = null,
    waistPinch = 0.94,
  } = options;

  const upper = neckline || [
    [230 - shoulderHalf * 0.55, 250],
    [230 - shoulderHalf, 268],
    [230 - shoulderHalf - 4, 300],
  ];
  const lower = hem || [
    [230 - hemHalf, hemY - 40],
    [230 - hemHalf * 0.98, hemY],
    [230 - hemHalf * 0.4, hemY + 6],
    [230, hemY + 2],
    [230 + hemHalf * 0.4, hemY + 6],
    [230 + hemHalf * 0.98, hemY],
    [230 + hemHalf, hemY - 40],
  ];

  const right = [
    [230 + shoulderHalf + 4, 300],
    [230 + shoulderHalf, 268],
    [230 + shoulderHalf * 0.55, 250],
  ];
  const neck = [
    [230 + pose.neckHalf + 8, 238 + neckDrop * 0.1],
    [230, 238 + neckDrop],
    [230 - pose.neckHalf - 8, 238 + neckDrop * 0.1],
  ];

  // Traverse: down the left side, across the hem (right to left), up the right
  // side, then back across the neckline. Reversing the right-hand side here is
  // what keeps the outline simple instead of a bow-tie.
  const outline = [
    ...upper,
    ...lower,
    ...right.reverse(),
    ...neck,
  ];
  return smoothClosed(outline, 0.72);
}

/** A flared lower piece: coat tail, skirt or robe. */
function skirt(pose, options) {
  const {
    fromY = 470, fromHalf = 78,
    toY = 700, toHalf = 118,
    points = null,
  } = options;

  const hem = points || [
    [230 - toHalf, toY - 30],
    [230 - toHalf, toY],
    [230 - toHalf * 0.45, toY + 10],
    [230, toY + 4],
    [230 + toHalf * 0.45, toY + 10],
    [230 + toHalf, toY],
    [230 + toHalf, toY - 30],
  ];

  return smoothClosed([
    [230 - fromHalf, fromY],
    [230 - fromHalf * 0.7, fromY - 14],
    [230 + fromHalf * 0.7, fromY - 14],
    [230 + fromHalf, fromY],
    ...[...hem].reverse(),
  ], 0.7);
}

/** Sleeve over one arm, from shoulder to `to` ('elbow' or 'wrist'). */
function sleeve(pose, side, options) {
  const {
    to = 'wrist',
    pad = 8,
    cuff = null,
    fill,
  } = options;

  const shoulder = side === 'L' ? pose.shoulderL : pose.shoulderR;
  const elbow = side === 'L' ? pose.elbowL : pose.elbowR;
  const wrist = side === 'L' ? pose.wristL : pose.wristR;
  const bend = side === 'L' ? [124, 330] : [336, 330];

  const upper = draw(limb(shoulder, elbow, 28 + pad, 23 + pad, { bulge: 3, bend }), fill);

  if (to === 'elbow') {
    return upper + (cuff
      ? draw(limb([elbow[0], elbow[1] - 12], [elbow[0], elbow[1] + 8], 25 + pad, 24 + pad, {}), cuff, STROKE.inner)
      : '');
  }

  const lower = draw(limb(elbow, wrist, 23 + pad, 17 + pad, { bulge: 4 }), fill);
  const cuffPiece = cuff
    ? draw(limb([wrist[0] - (wrist[0] - elbow[0]) * 0.16, wrist[1] - (wrist[1] - elbow[1]) * 0.16],
      [wrist[0], wrist[1]], 20 + pad, 19 + pad, {}), cuff, STROKE.inner)
    : '';

  return upper + lower + cuffPiece;
}

/** Tall boot over one leg. */
function boot(pose, side, options) {
  const { fill, topY = 700, cuff = null, sole = null } = options;
  const knee = side === 'L' ? pose.kneeL : pose.kneeR;
  const ankle = side === 'L' ? pose.ankleL : pose.ankleR;
  const bend = side === 'L' ? [158, 762] : [302, 762];

  const top = [knee[0] + (ankle[0] - knee[0]) * ((knee[1] - topY) / (knee[1] - ankle[1])),
    topY];
  const shaft = draw(limb(top, ankle, 28, 21, { bulge: 5, bend }), fill);

  const foot = draw(smoothClosed([
    [ankle[0] - 20, ankle[1] - 4],
    [ankle[0] + 20, ankle[1] - 4],
    [ankle[0] + 22, ankle[1] + 30],
    [ankle[0] + (side === 'L' ? -38 : 38), ankle[1] + 44],
    [ankle[0] - (side === 'L' ? -6 : 6), ankle[1] + 46],
    [ankle[0] - 22, ankle[1] + 32],
  ], 0.55), fill);

  const rim = cuff
    ? draw(limb([top[0], topY - 4], [top[0], topY + 16], 30, 30, {}), cuff, STROKE.inner)
    : '';
  const solePiece = sole
    ? draw(smoothClosed([
      [ankle[0] - 22, ankle[1] + 30],
      [ankle[0] + (side === 'L' ? -38 : 38), ankle[1] + 44],
      [ankle[0] - (side === 'L' ? -6 : 6), ankle[1] + 46],
      [ankle[0] - 22, ankle[1] + 40],
    ], 0.4), sole, STROKE.inner)
    : '';

  return shaft + foot + rim + solePiece;
}

/** Glove cuff over the wrist and back of the hand. */
function glove(pose, side, options) {
  const { fill, length = 0.24 } = options;
  const elbow = side === 'L' ? pose.elbowL : pose.elbowR;
  const wrist = side === 'L' ? pose.wristL : pose.wristR;
  const from = [
    wrist[0] - (wrist[0] - elbow[0]) * length,
    wrist[1] - (wrist[1] - elbow[1]) * length,
  ];
  const past = [
    wrist[0] + (wrist[0] - elbow[0]) * 0.16,
    wrist[1] + (wrist[1] - elbow[1]) * 0.16,
  ];
  return draw(limb(from, past, 20, 18, { bulge: 2 }), fill, STROKE.inner);
}

/** High collar: the shape that reads as "this character has authority". */
function collarHigh(pose, options) {
  const { fill, height = 74, spread = 30 } = options;
  return draw(smoothClosed([
    [230 - pose.neckHalf - 12, 232],
    [230 - pose.neckHalf - spread, 232 - height * 0.55],
    [230, 232 - height],
    [230 + pose.neckHalf + spread, 232 - height * 0.55],
    [230 + pose.neckHalf + 12, 232],
    [230, 244],
  ], 0.5), fill);
}

/** Draped scarf or stole: two hanging ends of unequal length. */
function stole(pose, options) {
  const { fill, shadow, lengthL = 300, lengthR = 230, width = 26 } = options;
  const left = draw(limb([196, 268], [186, 268 + lengthL], width, width * 0.7,
    { bend: [172, 268 + lengthL * 0.55] }), fill);
  const right = draw(limb([264, 268], [276, 268 + lengthR], width, width * 0.7,
    { bend: [290, 268 + lengthR * 0.55] }), fill);
  const knot = shadow
    ? draw(smoothClosed([
      [206, 256], [254, 256], [260, 288], [230, 300], [200, 288],
    ], 0.6), shadow, STROKE.inner)
    : '';
  return left + right + knot;
}

/** Belt or harness strap around the waist. */
function belt(pose, options) {
  const { fill, buckle = null, y = 442, half = 62, height = 20, strap = null } = options;
  const band = draw(smoothClosed([
    [230 - half, y - height * 0.5],
    [230, y - height * 0.7],
    [230 + half, y - height * 0.5],
    [230 + half, y + height * 0.5],
    [230, y + height * 0.7],
    [230 - half, y + height * 0.5],
  ], 0.6), fill, STROKE.inner);

  const plate = buckle
    ? draw(smoothClosed([
      [230 - 15, y - 13], [230 + 15, y - 13], [230 + 17, y + 13], [230 - 17, y + 13],
    ], 0.3), buckle, STROKE.inner)
    : '';

  const diagonal = strap
    ? draw(limb([186, 286], [286, 430], 9, 9, {}), strap, STROKE.inner)
    : '';

  return diagonal + band + plate;
}

/** Shoulder plate. */
function pauldron(pose, side, options) {
  const { fill, shadow } = options;
  const shoulder = side === 'L' ? pose.shoulderL : pose.shoulderR;
  const dir = side === 'L' ? -1 : 1;
  const outer = draw(smoothClosed([
    [shoulder[0], shoulder[1] - 26],
    [shoulder[0] + dir * 34, shoulder[1] - 20],
    [shoulder[0] + dir * 40, shoulder[1] + 22],
    [shoulder[0] + dir * 12, shoulder[1] + 40],
    [shoulder[0] - dir * 16, shoulder[1] + 24],
    [shoulder[0] - dir * 14, shoulder[1] - 18],
  ], 0.6), fill);
  const trim = shadow
    ? draw(smoothOpen([
      [shoulder[0] + dir * 34, shoulder[1] - 16],
      [shoulder[0] + dir * 38, shoulder[1] + 20],
      [shoulder[0] + dir * 12, shoulder[1] + 34],
    ], 0.7), 'none', STROKE.inner, { stroke: shadow, fill: 'none' })
    : '';
  return outer + trim;
}

/** Cape or coat tails, drawn behind the body. */
function cape(pose, options) {
  const {
    fill, shadow = null,
    spread = 132, length = 560, split = false, points = null,
  } = options;

  const hem = points || (split
    ? [[230 - spread, length - 40], [230 - spread * 0.7, length], [230 - spread * 0.1, length - 90],
      [230, length - 30], [230 + spread * 0.1, length - 90], [230 + spread * 0.7, length],
      [230 + spread, length - 40]]
    : [[230 - spread, length - 40], [230 - spread * 0.8, length], [230 - spread * 0.3, length + 14],
      [230, length + 6], [230 + spread * 0.3, length + 14], [230 + spread * 0.8, length],
      [230 + spread, length - 40]]);

  const body = smoothClosed([
    [230 - 74, 262],
    [230 - spread * 0.9, 340],
    [230 - spread, 430],
    ...hem,
    [230 + spread, 430],
    [230 + spread * 0.9, 340],
    [230 + 74, 262],
  ], 0.7);

  const parts = [];
  if (shadow) {
    parts.push(path(body, shape({ fill: shadow, transform: 'translate(-6 6)' }, ink())));
  }
  parts.push(path(body, shape({ fill }, ink())));
  return parts.join('');
}

module.exports = {
  garment, skirt, sleeve, boot, glove, collarHigh, stole, belt, pauldron, cape,
  draw, ink,
};
