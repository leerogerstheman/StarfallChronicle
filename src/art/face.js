'use strict';

/**
 * The face.
 *
 * A face is the part of a portrait that decides whether the whole thing reads
 * as a character or as a mannequin, and it is also the part that is easiest to
 * ruin with detail. The approach here is deliberately minimal: bold almond
 * eyes with a coloured iris, a heavy upper lash, a single-line brow, a nose
 * reduced to a hint, and a mouth that is one curve. At bust size that reads
 * clearly; at battle-HUD size it still reads, which a detailed face would not.
 *
 * Expressions are *parameters*, not separate drawings. `EXPRESSIONS` adjusts
 * eye openness, brow angle, brow height and mouth curve; the geometry is
 * shared. That means adding a new expression is four numbers, and it is
 * impossible for the "happy" face to drift out of alignment with the neutral
 * one — the bug that makes hand-drawn expression sheets look wrong.
 */

const { path, circle, ellipse, el, smoothClosed, smoothOpen, shape } = require('./svg');
const { INK, STROKE, shade } = require('./palette');

/** Face landmarks, in full-body coordinates. Shared by every character. */
const FACE = {
  centerX: 230,
  eyeY: 156,
  eyeDX: 27,
  browY: 133,
  noseY: 174,
  mouthY: 189,
  blushY: 172,
};

const EXPRESSIONS = {
  neutral: { open: 1, browTilt: 0, browRaise: 0, mouth: 'line', mouthCurve: 0.2, blush: 0 },
  focus: { open: 0.74, browTilt: -0.22, browRaise: -2, mouth: 'line', mouthCurve: -0.15, blush: 0 },
  hurt: { open: 0.5, browTilt: -0.55, browRaise: -4, mouth: 'open', mouthCurve: -0.6, blush: 0.25 },
  victory: { open: 0.12, browTilt: 0.24, browRaise: 5, mouth: 'open', mouthCurve: 1, blush: 0.4 },
};

const EXPRESSION_IDS = Object.keys(EXPRESSIONS);

function resolveExpression(name) {
  return EXPRESSIONS[name] || EXPRESSIONS.neutral;
}

/**
 * One eye, as an almond.
 *
 * `side` is `-1` for the viewer's left and `+1` for the right; the tilt is
 * mirrored so the pair reads as a matched set rather than two copies.
 */
function eyeOutline(cx, cy, halfW, halfH, side) {
  const outer = halfH * 0.42;
  return smoothClosed([
    [cx - halfW * side, cy + outer * 0.35],
    [cx - halfW * 0.4 * side, cy - halfH],
    [cx + halfW * 0.55 * side, cy - halfH * 0.82],
    [cx + halfW * side, cy - halfH * 0.1],
    [cx + halfW * 0.55 * side, cy + halfH * 0.72],
    [cx - halfW * 0.35 * side, cy + halfH * 0.85],
  ], 0.85);
}

/** Closed/happy eye: an upward arc, drawn as a stroke. */
function closedEye(cx, cy, halfW, side) {
  return smoothOpen([
    [cx - halfW * side, cy + 1],
    [cx, cy - halfW * 0.62],
    [cx + halfW * side, cy + 1],
  ], 0.9);
}

function drawEye(options) {
  const {
    cx, cy, halfW, halfH, side, expression, iris,
    lashWidth = STROKE.inner, uid = 'art',
  } = options;
  const out = [];

  if (expression.open <= 0.2) {
    out.push(path(closedEye(cx, cy, halfW, side), shape({
      fill: 'none', stroke: INK, 'stroke-width': lashWidth + 2.2,
    })));
    out.push(path(smoothOpen([
      [cx + halfW * 1.02 * side, cy - 2],
      [cx + halfW * 1.5 * side, cy - 7],
    ], 0.6), shape({ fill: 'none', stroke: INK, 'stroke-width': lashWidth })));
    return out.join('');
  }

  const open = expression.open;
  const height = halfH * open;
  const d = eyeOutline(cx, cy, halfW, height, side);

  // The iris is deliberately larger than the visible opening and is clipped by
  // the almond. That is what produces the "cut off by the lids" look; an iris
  // sized to fit inside the opening always reads as a floating disc.
  const clipId = `${uid}-eyeclip-${Math.round(cx)}-${Math.round(cy)}`;
  out.push(el('defs', null, el('clipPath', { id: clipId }, path(d, {}))));

  out.push(path(d, shape({ fill: '#f6f1e6' }, { color: INK, width: STROKE.fine })));
  out.push(el('g', { 'clip-path': `url(#${clipId})` }, [
    ellipse(cx, cy + height * 0.1, halfW * 0.64, height * 1.06, { fill: iris }),
    ellipse(cx, cy + height * 0.14, halfW * 0.3, height * 0.62, { fill: shade(iris, -0.62) }),
    circle(cx + halfW * 0.26, cy - height * 0.42, halfW * 0.2, { fill: '#ffffff' }),
    circle(cx - halfW * 0.3, cy + height * 0.5, halfW * 0.12, { fill: '#ffffff', opacity: 0.7 }),
  ]));

  // Heavy upper lash. This single stroke is what makes the eye read as an
  // anime eye rather than a cartoon dot.
  out.push(path(smoothOpen([
    [cx - halfW * 1.06 * side, cy + height * 0.1],
    [cx - halfW * 0.45 * side, cy - height * 0.98],
    [cx + halfW * 0.5 * side, cy - height * 0.92],
    [cx + halfW * 1.12 * side, cy - height * 0.22],
  ], 0.9), shape({ fill: 'none', stroke: INK, 'stroke-width': lashWidth + 2.2 })));

  // Outer corner flick, angled away from the face centre.
  out.push(path(smoothOpen([
    [cx + halfW * 1.05 * side, cy - height * 0.3],
    [cx + halfW * 1.55 * side, cy - height * 0.85],
  ], 0.6), shape({ fill: 'none', stroke: INK, 'stroke-width': lashWidth })));

  return out.join('');
}

function drawBrow(cx, cy, halfW, side, expression, color) {
  const raise = expression.browRaise;
  const tilt = expression.browTilt;
  const inner = [cx - halfW * 0.9 * side, cy + raise - tilt * 7];
  const mid = [cx + halfW * 0.1 * side, cy + raise - halfW * 0.16];
  const outer = [cx + halfW * 1.1 * side, cy + raise + tilt * 8];

  return path(smoothOpen([inner, mid, outer], 0.8), shape({
    fill: 'none', stroke: color, 'stroke-width': 5.2,
  }));
}

/**
 * The whole face, in draw order.
 *
 * Returns SVG markup rather than a structure because every caller wants the
 * same thing: a string to put inside a `<g>`.
 *
 * `marks` carries the ageing and damage details — a beard, a scar, an eye
 * patch. They are options rather than separate face builders because a scar is
 * a decoration on a face, not a different face, and giving them their own code
 * path would mean the NPC faces could drift out of alignment with the cast.
 */
function face(options) {
  const {
    skin,
    iris,
    expression: expressionName = 'neutral',
    browColor,
    showBlush = true,
    uid = 'art',
    marks = {},
  } = options;

  const expression = resolveExpression(expressionName);
  const cx = FACE.centerX;
  const halfW = 15.5;
  const halfH = 12.5;
  const parts = [];

  for (const side of [-1, 1]) {
    const ex = cx + FACE.eyeDX * side;
    parts.push(drawEye({
      cx: ex, cy: FACE.eyeY, halfW, halfH, side, expression, iris, uid,
    }));
  }

  for (const side of [-1, 1]) {
    parts.push(drawBrow(
      cx + FACE.eyeDX * side, FACE.browY, halfW * 1.15, side, expression,
      browColor || shade(skin.deep, -0.25),
    ));
  }

  // Nose: a two-point shadow, no outline. A drawn nose at this scale always
  // looks like a smudge.
  parts.push(path(smoothOpen([
    [cx + 3, FACE.noseY - 7],
    [cx + 5, FACE.noseY],
    [cx - 1, FACE.noseY + 1],
  ], 0.7), shape({
    fill: 'none', stroke: skin.line, 'stroke-width': STROKE.fine,
    opacity: 0.75,
  })));

  parts.push(drawMouth(cx, FACE.mouthY, expression, skin));

  if (showBlush && expression.blush > 0) {
    for (const side of [-1, 1]) {
      parts.push(ellipse(cx + 34 * side, FACE.blushY, 15, 7, {
        fill: '#ff8f7a', opacity: (0.3 * expression.blush).toFixed(2),
      }));
    }
  }

  if (marks.beard) parts.push(drawBeard(cx, skin, marks.beard));
  if (marks.scar) parts.push(drawScar(cx, marks.scar, skin));
  if (marks.patch) parts.push(drawPatch(cx, marks.patch));

  return parts.join('');
}

/** A short beard along the jaw. */
function drawBeard(cx, skin, spec) {
  const color = typeof spec === 'string' ? spec : (spec.color || '#3a2c22');
  const length = (typeof spec === 'object' && spec.length) || 0.5;
  const jawY = 196 + length * 22;
  return path(smoothClosed([
    [cx - 44, 168], [cx - 34, jawY - 26], [cx - 12, jawY],
    [cx, jawY + 6], [cx + 12, jawY],
    [cx + 34, jawY - 26], [cx + 44, 168],
    [cx + 30, 178], [cx, 186], [cx - 30, 178],
  ], 0.7), shape({ fill: color }, { color: INK, width: STROKE.fine }));
}

/** A diagonal scar over one eye, plus the notch in the brow. */
function drawScar(cx, spec, skin) {
  const side = spec.side === 'L' ? -1 : 1;
  const x = cx + FACE.eyeDX * side;
  const color = shade(skin.deep, -0.22);
  return [
    path(smoothOpen([
      [x - 10 * side, FACE.browY - 22],
      [x + 4 * side, FACE.eyeY - 6],
      [x - 6 * side, FACE.eyeY + 26],
    ], 0.7), shape({ fill: 'none', stroke: color, 'stroke-width': 3.4, opacity: 0.85 })),
    path(smoothOpen([
      [x - 12 * side, FACE.browY - 20],
      [x - 5 * side, FACE.browY - 18],
    ], 0.5), shape({ fill: 'none', stroke: color, 'stroke-width': 2.4, opacity: 0.7 })),
  ].join('');
}

/** A leather patch strapped over one eye. */
function drawPatch(cx, spec) {
  const side = spec.side === 'L' ? -1 : 1;
  const x = cx + FACE.eyeDX * side;
  const color = spec.color || '#2b2119';
  return [
    path(smoothClosed([
      [x - 20, FACE.eyeY - 18], [x + 20, FACE.eyeY - 14],
      [x + 22, FACE.eyeY + 16], [x - 18, FACE.eyeY + 18],
    ], 0.5), shape({ fill: color }, { color: INK, width: STROKE.fine })),
    path(smoothOpen([
      [x - 22, FACE.eyeY - 16], [cx - 50 * side, FACE.browY - 6],
    ], 0.6), shape({ fill: 'none', stroke: color, 'stroke-width': 5 })),
    path(smoothOpen([
      [x + 22, FACE.eyeY - 12], [cx + 52 * side, FACE.browY - 4],
    ], 0.6), shape({ fill: 'none', stroke: color, 'stroke-width': 5 })),
  ].join('');
}

function drawMouth(cx, cy, expression, skin) {
  const curve = expression.mouthCurve;

  if (expression.mouth === 'open') {
    const height = 6 + Math.abs(curve) * 8;
    const width = 12 + Math.abs(curve) * 5;
    const d = smoothClosed([
      [cx - width, cy - 2],
      [cx, cy - 3 - curve * 2],
      [cx + width, cy - 2],
      [cx + width * 0.6, cy + height],
      [cx, cy + height + 2],
      [cx - width * 0.6, cy + height],
    ], 0.8);
    return path(d, shape({ fill: shade(skin.deep, -0.45) }, { color: INK, width: STROKE.fine }));
  }

  return path(smoothOpen([
    [cx - 11, cy - curve * 3],
    [cx, cy + curve * 5],
    [cx + 11, cy - curve * 3],
  ], 0.85), shape({
    fill: 'none', stroke: shade(skin.deep, -0.3), 'stroke-width': 3.4,
  }));
}

module.exports = { FACE, EXPRESSIONS, EXPRESSION_IDS, resolveExpression, face, drawEye, drawBrow };
