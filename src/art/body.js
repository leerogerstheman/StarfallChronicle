'use strict';

/**
 * The shared humanoid.
 *
 * Every character is drawn over the *same* skeleton. Proportions, limb
 * thickness, shoulder width and head size are fixed here, and a character
 * spec only chooses hair, costume, props, colours and a pose. That is the only
 * practical way to make five figures drawn by one blind author look like they
 * belong to the same cast: the parts that are hard to eyeball — where the elbow
 * sits, how wide the hips are relative to the shoulders — are decided once,
 * numerically, and never re-litigated per character.
 *
 * Coordinate system
 * -----------------
 * Full body: `0 0 460 960`, ground at y = 906. Head height 124px, total figure
 * 824px, so the cast is 6.6 heads tall — the stylised heroic range, a little
 * shorter than a photograph and a little taller than chibi. Bust view is a crop
 * of the same coordinates, so a face can never drift between the two views.
 */

const { n, path, polyPath, smoothClosed, lerp, mirrorX, shape } = require('./svg');
const { INK, STROKE } = require('./palette');

/** Full-body canvas. */
const CANVAS = { w: 460, h: 960, ground: 906, axis: 230 };

/** Where the bust crop sits: head, shoulders and upper chest. */
const BUST_VIEW = [122, 52, 216, 216];

/**
 * Canonical joints. `L` is the character's own left, which appears on the
 * viewer's right — but since the figure is symmetric except for the arms, the
 * mirroring is handled by `mirrorX` rather than by two hand-written copies.
 */
const JOINTS = {
  headTop: [230, 82],
  headCenter: [230, 144],
  chin: [230, 208],
  headRx: 50,
  headRy: 62,

  neckTop: [230, 192],
  neckBase: [230, 246],
  neckHalf: 21,

  shoulderL: [150, 262],
  shoulderR: [310, 262],
  shoulderHalf: 80,

  chestY: 306,
  chestHalf: 70,
  waistY: 430,
  waistHalf: 56,
  hipY: 478,
  hipHalf: 72,

  elbowL: [126, 394],
  elbowR: [334, 394],
  wristL: [116, 528],
  wristR: [344, 528],

  hipL: [178, 486],
  hipR: [282, 486],
  kneeL: [168, 674],
  kneeR: [292, 674],
  ankleL: [160, 860],
  ankleR: [300, 860],
};

/**
 * Arm poses. Only the arm joints move; everything else is shared, which keeps
 * a raised weapon from silently changing the character's height.
 */
const POSES = {
  stand: {},
  /** Weapon hand up and out — used by the attacker and the spear carrier. */
  ready: {
    elbowR: [340, 372],
    wristR: [352, 286],
    handAngleR: -1.35,
  },
  /** Both hands low and close — the caster's "holding something" stance. */
  cast: {
    elbowR: [326, 402],
    wristR: [286, 452],
    handAngleR: -2.2,
    elbowL: [134, 402],
    wristL: [176, 448],
    handAngleL: -0.94,
  },
  /** One hand on the hip, weight shifted — the confident poster stance. */
  hip: {
    elbowR: [348, 396],
    wristR: [300, 470],
    handAngleR: -2.6,
  },
  /** Both hands brought in low and forward, weapon held across the body. */
  guard: {
    elbowL: [132, 396],
    wristL: [176, 486],
    handAngleL: -2.35,
    elbowR: [330, 396],
    wristR: [286, 486],
    handAngleR: -2.9,
  },
  /** Weapon arm extended out and up, off the body. */
  reach: {
    elbowR: [342, 378],
    wristR: [352, 310],
    handAngleR: -1.05,
  },
  /** Arms folded across the chest. Reads as "I have been doing this a while". */
  cross: {
    elbowL: [126, 392],
    wristL: [270, 386],
    handAngleL: -0.05,
    elbowR: [334, 400],
    wristR: [190, 408],
    handAngleR: 3.09,
  },
};

/**
 * Bust crop for a figure at a given scale.
 *
 * Scaling happens about the ground line, so a shorter character's head sits
 * lower on the canvas. If the bust viewBox did not follow, the battle HUD would
 * show a portrait cropped at the eyes for exactly the characters who are
 * shortest — which is the kind of bug that looks like a rendering glitch and is
 * actually an arithmetic slip.
 */
function bustView(scale = 1) {
  const headOffset = JOINTS.headCenter[1] - BUST_VIEW[1];
  const headY = CANVAS.ground + (JOINTS.headCenter[1] - CANVAS.ground) * scale;
  return [BUST_VIEW[0], headY - headOffset, BUST_VIEW[2], BUST_VIEW[3]];
}

function resolvePose(pose) {
  const patch = POSES[pose] || POSES.stand;
  return { ...JOINTS, ...patch };
}

/** Signed perpendicular of a segment, normalised. */
function normalAt(a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  return [-dy / len, dx / len];
}

/**
 * A tapered, optionally bent limb.
 *
 * The centreline is a quadratic through `a`, `bend` and `b`; at each sample the
 * half-width is interpolated and inflated by `bulge * sin(pi t)`, which is what
 * gives a thigh or a forearm its swell. Sampling rather than authoring the
 * outline means the two sides can never disagree about how thick the limb is.
 *
 * Both ends are closed with a true semicircle rather than a straight chord.
 * The difference only shows where a limb end is visible (a bare arm against a
 * dark coat), which is exactly where a flat cap looks like a mistake.
 */
function limb(a, b, wa, wb, options = {}) {
  const { bend, bulge = 0, samples = 9 } = options;
  const mid = bend || [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

  const at = (t) => {
    const u = 1 - t;
    return [
      u * u * a[0] + 2 * u * t * mid[0] + t * t * b[0],
      u * u * a[1] + 2 * u * t * mid[1] + t * t * b[1],
    ];
  };

  const halfAt = (t) => lerp(wa, wb, t) + bulge * Math.sin(Math.PI * t);
  const normAt = (t) => normalAt(at(Math.max(0, t - 0.01)), at(Math.min(1, t + 0.01)));

  const outline = [];

  // Near side, root to tip.
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const p = at(t);
    const [nx, ny] = normAt(t);
    const half = halfAt(t);
    outline.push([p[0] + nx * half, p[1] + ny * half]);
  }

  // Round cap at the tip.
  const [enx, eny] = normAt(1);
  const [edx, edy] = normalAt(at(0.97), b);
  const endDir = [-edy, edx];
  for (let i = 1; i < 6; i++) {
    const theta = (Math.PI * i) / 6;
    outline.push([
      b[0] + enx * wb * Math.cos(theta) + endDir[0] * wb * Math.sin(theta),
      b[1] + eny * wb * Math.cos(theta) + endDir[1] * wb * Math.sin(theta),
    ]);
  }

  // Far side, tip back to root.
  for (let i = samples; i >= 0; i--) {
    const t = i / samples;
    const p = at(t);
    const [nx, ny] = normAt(t);
    const half = halfAt(t);
    outline.push([p[0] - nx * half, p[1] - ny * half]);
  }

  // Round cap at the root, traversed the other way so the outline stays simple.
  const [snx, sny] = normAt(0);
  const [sdx, sdy] = normalAt(a, at(0.03));
  const startDir = [sdy, -sdx];
  for (let i = 1; i < 6; i++) {
    const theta = (Math.PI * i) / 6;
    outline.push([
      a[0] - snx * wa * Math.cos(theta) + startDir[0] * wa * Math.sin(theta),
      a[1] - sny * wa * Math.cos(theta) + startDir[1] * wa * Math.sin(theta),
    ]);
  }

  return smoothClosed(outline, 0.55);
}

/** Torso silhouette: shoulders, chest, waist, hips, as one closed curve. */
function torso(pose, options = {}) {
  const { shoulderInset = 0, waistPinch = 1, hipFlare = 1, chestBust = 0 } = options;
  const shoulder = pose.shoulderHalf - shoulderInset;
  const waist = pose.waistHalf * waistPinch;
  const hip = pose.hipHalf * hipFlare;

  return smoothClosed([
    [pose.axis ?? 230, 250],
    [230 - shoulder * 0.72, 258],
    [230 - shoulder, 286],
    [230 - pose.chestHalf - chestBust * 0.5, pose.chestY + 12],
    [230 - waist, pose.waistY - 26],
    [230 - waist * 1.02, pose.waistY + 10],
    [230 - hip, pose.hipY - 6],
    [230 - hip * 0.96, pose.hipY + 34],
    [230, pose.hipY + 46],
    [230 + hip * 0.96, pose.hipY + 34],
    [230 + hip, pose.hipY - 6],
    [230 + waist * 1.02, pose.waistY + 10],
    [230 + waist, pose.waistY - 26],
    [230 + pose.chestHalf + chestBust * 0.5, pose.chestY + 12],
    [230 + shoulder, 286],
    [230 + shoulder * 0.72, 258],
  ], 0.85);
}

/** Face outline: soft oval with a tapered jaw. */
function head() {
  return smoothClosed([
    [230, 82],
    [196, 92],
    [180, 122],
    [178, 156],
    [188, 186],
    [208, 203],
    [230, 208],
    [252, 203],
    [272, 186],
    [282, 156],
    [280, 122],
    [264, 92],
  ], 0.92);
}

/** Neck, drawn behind the head so the jaw overlaps it. */
function neck(pose) {
  return polyPath([
    [230 - pose.neckHalf, 176],
    [230 + pose.neckHalf, 176],
    [230 + pose.neckHalf + 3, 252],
    [230 - pose.neckHalf - 3, 252],
  ], true);
}

/** Ear, positioned off the face outline so it reads at bust size. */
function ear(side) {
  const x = side === 'L' ? 181 : 279;
  return { cx: x, cy: 158, rx: 9, ry: 14 };
}

/** A hand: a rounded mitt with a thumb, rotated to the arm's direction. */
function hand(pose, side) {
  const key = side === 'L' ? 'wristL' : 'wristR';
  const [x, y] = pose[key];
  const angle = side === 'L' ? (pose.handAngleL ?? 0.18) : (pose.handAngleR ?? -0.18);
  const deg = (angle * 180) / Math.PI;
  const flip = side === 'L' ? -1 : 1;

  const palm = smoothClosed([
    [x - 15, y - 10],
    [x + 15, y - 10],
    [x + 17, y + 12],
    [x + 6, y + 26],
    [x - 8, y + 25],
    [x - 17, y + 11],
  ], 0.8);

  const thumb = smoothClosed([
    [x + flip * 10, y - 8],
    [x + flip * 20, y + 2],
    [x + flip * 17, y + 12],
    [x + flip * 8, y + 6],
  ], 0.7);

  return { palm, thumb, transform: `rotate(${n(deg)} ${n(x)} ${n(y)})` };
}

/** Foot: a wedge pointing away from the body centreline. */
function foot(pose, side) {
  const ankle = side === 'L' ? pose.ankleL : pose.ankleR;
  const dir = side === 'L' ? -1 : 1;
  return smoothClosed([
    [ankle[0] - 17, ankle[1] - 6],
    [ankle[0] + 17, ankle[1] - 6],
    [ankle[0] + 19, ankle[1] + 28],
    [ankle[0] + dir * 34, ankle[1] + 42],
    [ankle[0] - dir * 4, ankle[1] + 44],
    [ankle[0] - 19, ankle[1] + 30],
  ], 0.6);
}

/**
 * Apply the shared outline treatment.
 *
 * `weight` picks from the three stroke sizes so a caller says "this is a
 * silhouette" or "this is a detail" rather than naming a number.
 */
function ink(weight = 'outer') {
  return { color: INK, width: STROKE[weight] };
}

/** Convenience: a filled shape with the shared ink. */
function filled(d, fill, weight = 'outer', extra = {}) {
  return path(d, shape({ fill, ...extra }, ink(weight)));
}

/** Everything below the neck, in draw order: back limbs, torso, front limbs. */
function bodyBase(pose, options = {}) {
  const { skin, skipArms = false } = options;
  const parts = [];

  // Legs, drawn back-to-front so the near leg overlaps the far one.
  parts.push({ layer: 'legs', d: limb(pose.hipR, pose.kneeR, 36, 27, { bulge: 5, bend: [296, 566] }), fill: skin.shadow });
  parts.push({ layer: 'legs', d: limb(pose.kneeR, pose.ankleR, 27, 17, { bulge: 7, bend: [300, 762] }), fill: skin.shadow });
  parts.push({ layer: 'legs', d: limb(pose.hipL, pose.kneeL, 36, 27, { bulge: 5, bend: [162, 566] }), fill: skin.base });
  parts.push({ layer: 'legs', d: limb(pose.kneeL, pose.ankleL, 27, 17, { bulge: 7, bend: [156, 762] }), fill: skin.base });

  if (!skipArms) {
    parts.push({ layer: 'arms', d: limb(pose.shoulderR, pose.elbowR, 27, 21, { bulge: 3, bend: [332, 330] }), fill: skin.shadow });
    parts.push({ layer: 'arms', d: limb(pose.elbowR, pose.wristR, 21, 15, { bulge: 4 }), fill: skin.shadow });
    parts.push({ layer: 'arms', d: limb(pose.shoulderL, pose.elbowL, 27, 21, { bulge: 3, bend: [128, 330] }), fill: skin.base });
    parts.push({ layer: 'arms', d: limb(pose.elbowL, pose.wristL, 21, 15, { bulge: 4 }), fill: skin.base });
  }

  return parts;
}

module.exports = {
  CANVAS, BUST_VIEW, JOINTS, POSES,
  resolvePose, bustView, limb, torso, head, neck, ear, hand, foot,
  ink, filled, bodyBase, normalAt, mirrorX,
};
