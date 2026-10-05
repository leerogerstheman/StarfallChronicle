'use strict';

/**
 * Props: weapons and the odd bag of explosives.
 *
 * Every prop is anchored to a joint rather than to absolute coordinates, so a
 * character's pose change moves the weapon with the hand instead of leaving it
 * floating. Props return three layers because a held object is not simply
 * "in front" or "behind" the figure:
 *
 *   back   strapped across the back, behind the torso
 *   mid    held in a hand — in front of the body, behind the fingers
 *   front  floating, or emitting light that must land on top of everything
 *
 * Drawing a gripped weapon in `mid` and the hand afterwards is what makes it
 * read as *held*: the fingers overlap the grip.
 */

const { path, el, circle, ellipse, rect, smoothClosed, smoothOpen, shape, polyPath } = require('./svg');
const { INK, STROKE, shade } = require('./palette');
const { limb } = require('./body');

const ink = (w = STROKE.outer) => ({ color: INK, width: w });
const draw = (d, fill, w = STROKE.outer, extra = {}) => path(d, shape({ fill, ...extra }, ink(w)));

/** Unit vector for an angle in radians (y grows down, so 0 = right). */
function dir(angle) {
  return [Math.cos(angle), Math.sin(angle)];
}

function along(point, angle, distance) {
  const [dx, dy] = dir(angle);
  return [point[0] + dx * distance, point[1] + dy * distance];
}

/** A tapered blade from the guard to the tip, with a visible edge bevel. */
function blade(from, angle, options) {
  const { length = 250, width = 12, tip = 3, fill, bevel } = options;
  const to = along(from, angle, length);
  const body = draw(limb(from, to, width, tip, { bulge: -1.5 }), fill);
  const edge = bevel
    ? draw(limb(
      [from[0] + dir(angle + Math.PI / 2)[0] * width * 0.45, from[1] + dir(angle + Math.PI / 2)[1] * width * 0.45],
      [to[0] + dir(angle + Math.PI / 2)[0] * tip, to[1] + dir(angle + Math.PI / 2)[1] * tip],
      width * 0.3, tip * 0.4, {},
    ), bevel, STROKE.fine)
    : '';
  return body + edge;
}

/** Grip plus guard, drawn at the hand. */
function hilt(anchor, angle, options) {
  const { grip, guard, wrap = null } = options;
  const back = along(anchor, angle + Math.PI, 42);
  const front = along(anchor, angle, 16);
  const parts = [draw(limb(back, front, 9, 9, {}), grip, STROKE.inner)];

  if (wrap) {
    for (let i = 0; i < 3; i++) {
      const at = along(back, angle, 10 + i * 11);
      parts.push(draw(limb(
        [at[0] + dir(angle + Math.PI / 2)[0] * 10, at[1] + dir(angle + Math.PI / 2)[1] * 10],
        [at[0] - dir(angle + Math.PI / 2)[0] * 10, at[1] - dir(angle + Math.PI / 2)[1] * 10],
        2.4, 2.4, {},
      ), wrap, 0));
    }
  }

  const guardAt = along(anchor, angle, 14);
  const g = [dir(angle + Math.PI / 2)[0] * 30, dir(angle + Math.PI / 2)[1] * 30];
  parts.push(draw(smoothClosed([
    [guardAt[0] + g[0], guardAt[1] + g[1]],
    [guardAt[0] + dir(angle)[0] * 9, guardAt[1] + dir(angle)[1] * 9],
    [guardAt[0] - g[0], guardAt[1] - g[1]],
    [guardAt[0] - dir(angle)[0] * 9, guardAt[1] - dir(angle)[1] * 9],
  ], 0.5), guard, STROKE.inner));

  return parts.join('');
}

// ===========================================================================
// Weapons
// ===========================================================================

/** Ayaha: a long curved sabre, held point-up in the right hand. */
function sabre(pose, colors) {
  const { steel = '#dfe8f2', edge = '#ffffff', grip = '#2c3350', guard = '#c8a44a' } = colors;
  const hand = pose.wristR;
  const angle = (pose.handAngleR ?? -0.18) - Math.PI / 2 - 0.34;

  // Curved: the blade is a limb with a strong bend, so the whole weapon can be
  // re-angled by editing one number.
  const from = along(hand, angle, 30);
  const to = along(hand, angle, 268);
  const bend = along(hand, angle, 150);
  const body = draw(limb(from, to, 13, 3, { bend: [bend[0] - 26, bend[1] + 10], bulge: -1 }), steel);
  const bevel = draw(limb(
    [from[0] - 6, from[1] + 3], [to[0] - 3, to[1] + 2], 4, 1.4, { bend: [bend[0] - 30, bend[1] + 12] },
  ), edge, STROKE.fine);

  // Blade first, then the hilt: the guard has to sit *over* the blade root or
  // the weapon looks like two objects leaning against each other.
  return body + bevel + hilt(hand, angle, { grip, guard, wrap: '#e8cd7c' });
}

/** Byakuya: a long spear carried diagonally across the back. */
function spear(pose, colors) {
  const { shaft = '#3a2c22', steel = '#c9d1e4', glow = '#c77dff' } = colors;
  const a = [96, 664];
  const b = [372, 128];
  const body = draw(limb(a, b, 8, 8, {}), shaft);

  const axis = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const [dx, dy] = dir(axis);
  const [px, py] = dir(axis + Math.PI / 2);

  // Leaf head: tip, two shoulders, base. Four points is enough for a shape
  // that is only ever seen at this size.
  const head = draw(smoothClosed([
    [b[0] + dx * 54, b[1] + dy * 54],
    [b[0] + px * 19 + dx * 8, b[1] + py * 19 + dy * 8],
    [b[0] - dx * 16, b[1] - dy * 16],
    [b[0] - px * 19 + dx * 8, b[1] - py * 19 + dy * 8],
  ], 0.35), steel);

  const collar = draw(limb(
    [b[0] - dx * 22 + px * 3, b[1] - dy * 22 + py * 3],
    [b[0] - dx * 10 + px * 3, b[1] - dy * 10 + py * 3],
    13, 11, {},
  ), steel, STROKE.inner);

  const butt = draw(limb(along(a, axis + Math.PI, 10), a, 11, 8, {}), steel, STROKE.inner);

  // Lightning crawling along the shaft: three short zigzags, which read as
  // electricity without needing a gradient or a filter.
  const bolts = [0.32, 0.55, 0.78].map((t) => {
    const at = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    return path(smoothOpen([
      [at[0] - 14, at[1] - 8], [at[0] - 2, at[1] + 2], [at[0] - 10, at[1] + 6], [at[0] + 8, at[1] + 18],
    ], 0.2), shape({ fill: 'none', stroke: glow, 'stroke-width': 4, opacity: 0.9 }));
  }).join('');

  return { back: body + butt + head + collar, front: bolts };
}

/** Rin: a focus orb floating between both palms. */
function orb(pose, colors) {
  const { core = '#dff4ff', ring = '#63d4ff' } = colors;
  const a = pose.wristL;
  const b = pose.wristR;
  const cx = (a[0] + b[0]) / 2 + 6;
  const cy = (a[1] + b[1]) / 2 - 26;

  const spikes = [0, 45, 90, 135].map((deg) => {
    const r = (deg * Math.PI) / 180;
    return el('line', {
      x1: cx - Math.cos(r) * 34, y1: cy - Math.sin(r) * 34,
      x2: cx + Math.cos(r) * 34, y2: cy + Math.sin(r) * 34,
      stroke: ring, 'stroke-width': 3.4, 'stroke-linecap': 'round', opacity: 0.8,
    });
  }).join('');

  return {
    front: el('g', null, [
      circle(cx, cy, 30, { fill: ring, opacity: 0.22 }),
      circle(cx, cy, 21, { fill: core, stroke: INK, 'stroke-width': STROKE.inner }),
      circle(cx - 7, cy - 8, 7, { fill: '#ffffff', opacity: 0.85 }),
      spikes,
    ].join('')),
  };
}

/** Elise: a tall staff with a ringed head. */
function staff(pose, colors) {
  const { shaft = '#8a6a3a', steel = '#e8cd7c', gem = '#ffd166' } = colors;
  const hand = pose.wristR;
  const angle = -Math.PI / 2 + 0.16;

  const a = along(hand, angle + Math.PI, 190);
  const b = along(hand, angle, 210);
  const body = draw(limb(a, b, 8, 8, {}), shaft);

  const ringC = along(hand, angle, 236);
  const ring = el('g', null, [
    circle(ringC[0], ringC[1], 30, { fill: 'none', stroke: steel, 'stroke-width': 9 }),
    circle(ringC[0], ringC[1], 30, { fill: 'none', stroke: INK, 'stroke-width': 2.2, opacity: 0.5 }),
    path(smoothClosed([
      [ringC[0], ringC[1] - 17], [ringC[0] + 15, ringC[1]], [ringC[0], ringC[1] + 17], [ringC[0] - 15, ringC[1]],
    ], 0.35), shape({ fill: gem, stroke: INK, 'stroke-width': STROKE.fine })),
  ].join(''));

  const wings = [-1, 1].map((s) => draw(smoothClosed([
    [ringC[0] + s * 22, ringC[1] - 11],
    [ringC[0] + s * 46, ringC[1] - 32],
    [ringC[0] + s * 50, ringC[1] - 7],
    [ringC[0] + s * 30, ringC[1] + 11],
    [ringC[0] + s * 18, ringC[1] + 7],
  ], 0.55), steel, STROKE.inner)).join('');

  return { mid: body, front: ring + wings };
}

/** Rinné: a satchel of reagents at the hip, plus a bomb in the left hand. */
function satchel(pose, colors) {
  const { bag = '#6b4d33', strap = '#4a3524', glass = '#7fd7e8', cork = '#c8a44a', fuse = '#ff6b4a' } = colors;

  const body = draw(smoothClosed([
    [286, 452], [342, 462], [352, 528], [330, 562], [288, 556], [276, 500],
  ], 0.6), bag);

  const flap = draw(smoothClosed([
    [282, 448], [346, 458], [344, 490], [286, 482],
  ], 0.5), shade(bag, -0.2), STROKE.inner);

  const band = draw(limb([270, 300], [322, 470], 11, 11, {}), strap, STROKE.inner);

  const vials = [0, 1, 2].map((i) => {
    const x = 296 + i * 20;
    const y = 512 - i * 4;
    return el('g', null, [
      rect(x, y, 12, 30, { rx: 5, fill: glass, stroke: INK, 'stroke-width': STROKE.fine }),
      rect(x, y + 14, 12, 16, { rx: 5, fill: shade(glass, -0.35) }),
      rect(x + 2, y - 8, 8, 10, { rx: 2, fill: cork, stroke: INK, 'stroke-width': STROKE.fine }),
    ].join(''));
  }).join('');

  // A bomb in the off hand, because an alchemist who never holds one is just a
  // person with a bag.
  const hand = pose.wristL;
  const bomb = el('g', null, [
    circle(hand[0] - 8, hand[1] + 30, 22, { fill: '#2b3140', stroke: INK, 'stroke-width': STROKE.inner }),
    circle(hand[0] - 14, hand[1] + 22, 7, { fill: '#ffffff', opacity: 0.3 }),
    path(smoothOpen([
      [hand[0] - 4, hand[1] + 8], [hand[0] + 4, hand[1] - 10], [hand[0] - 6, hand[1] - 26],
    ], 0.6), shape({ fill: 'none', stroke: '#3a2c22', 'stroke-width': 4 })),
    circle(hand[0] - 7, hand[1] - 30, 6, { fill: fuse }),
    circle(hand[0] - 7, hand[1] - 30, 12, { fill: fuse, opacity: 0.28 }),
  ].join(''));

  // `mid`, not `front`: the hand is drawn after this layer, so the fingers
  // close over the bomb instead of the bomb sitting on top of the hand.
  return { mid: band + body + flap + vials + bomb };
}

const WEAPONS = { sabre, spear, orb, staff, satchel };

function weapon(kind, pose, colors) {
  if (!kind) return { back: '', mid: '', front: '' };
  const build = WEAPONS[kind];
  if (!build) throw new Error(`Unknown weapon: ${kind}`);
  const out = build(pose, colors);
  if (typeof out === 'string') return { back: '', mid: out, front: '' };
  return { back: out.back || '', mid: out.mid || '', front: out.front || '' };
}

module.exports = { weapon, WEAPONS, blade, hilt, along, dir };
