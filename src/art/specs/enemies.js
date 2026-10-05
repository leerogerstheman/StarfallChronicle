'use strict';

/**
 * Enemy art specs.
 *
 * Names, titles and accent colours come from `src/core/enemies.js`; only the
 * drawing lives here. Each spec supplies a `build(ctx)` that places the
 * creature primitives.
 *
 * Two conventions worth stating once:
 *
 *   - Every creature stands on `CANVAS.ground` (y = 348) unless it is meant to
 *     float, and floating things are marked by having no contact shadow
 *     (`float: true`). That is the only cue the art gives for "this does not
 *     walk", so it is deliberate rather than decorative.
 *   - The ashen king has two builds. Phase 2 is not a recolour: the shell
 *     cracks, the core shows through, and the crown grows. A boss whose second
 *     phase is a tint swap teaches the player nothing.
 */

const { ENEMIES } = require('../../core/enemies');
const { shade } = require('../palette');
const { smoothClosed, smoothOpen, path, el, circle, ellipse, shape } = require('../svg');

const GROUND = 348;

// ---------------------------------------------------------------------------
// 1. 腐叶虫 Rotgrub — a fat, hunched carrion grub
// ---------------------------------------------------------------------------

function rotgrub(ctx) {
  const { blob, eye, spike, leg, shade: sh } = ctx;
  const shell = '#7fa650';
  const shellDark = sh(shell, -0.3);
  const belly = '#c9d69a';

  // Five segments on an arc from tail to head. The arc is what makes it read
  // as an insect rather than a pile of ovals.
  const spine = [
    [96, 300], [140, 268], [188, 246], [238, 232], [282, 224],
  ];
  const radii = [40, 44, 42, 36, 30];

  const segments = spine.map((p, i) => blob([
    [p[0] - radii[i], p[1]],
    [p[0] - radii[i] * 0.6, p[1] - radii[i] * 0.9],
    [p[0] + radii[i] * 0.6, p[1] - radii[i] * 0.95],
    [p[0] + radii[i], p[1]],
    [p[0] + radii[i] * 0.6, p[1] + radii[i] * 0.85],
    [p[0] - radii[i] * 0.6, p[1] + radii[i] * 0.8],
  ], i % 2 === 0 ? shell : sh(shell, -0.08), { tension: 0.8 })).join('');

  const bellyPlate = blob([
    [110, 322], [160, 306], [216, 296], [262, 288],
    [258, 312], [206, 324], [150, 338], [112, 340],
  ], belly, { tension: 0.7, weight: 3.5 });

  const head = blob([
    [286, 196], [322, 188], [346, 210], [344, 238],
    [318, 256], [288, 250], [276, 224],
  ], shellDark, { tension: 0.75 });

  const mandibles = [
    spike([304, 250], [296, 288], 9, 3, '#4a3524', { bend: [292, 270] }),
    spike([330, 248], [342, 286], 9, 3, '#4a3524', { bend: [344, 268] }),
  ].join('');

  const eyes = [
    eye(304, 214, 10, { iris: '#f2ede1', style: 'round' }),
    eye(334, 210, 8, { iris: '#f2ede1', style: 'round' }),
  ].join('');

  const legs = [
    leg([132, 316], [122, GROUND], 8, shellDark, { claw: [-10, 8, '#4a3524'] }),
    leg([176, 302], [170, GROUND], 8, shellDark, { claw: [-8, 8, '#4a3524'] }),
    leg([224, 290], [222, GROUND], 8, shellDark, { claw: [-6, 8, '#4a3524'] }),
  ].join('') + [
    leg([132, 316], [146, GROUND], 7, sh(shell, -0.2), { claw: [10, 8, '#4a3524'] }),
    leg([176, 302], [194, GROUND], 7, sh(shell, -0.2), { claw: [8, 8, '#4a3524'] }),
    leg([224, 290], [244, GROUND], 7, sh(shell, -0.2), { claw: [6, 8, '#4a3524'] }),
  ].join('');

  // Bristles along the spine: a cheap way to make a smooth mass look alive.
  const bristles = spine.slice(0, 4).map((p, i) => spike(
    [p[0], p[1] - radii[i] * 0.8], [p[0] - 6, p[1] - radii[i] * 0.8 - 26], 4, 1.2, shellDark, {},
  )).join('');

  return { back: legs, body: segments + bellyPlate + bristles, over: head, front: mandibles + eyes };
}

// ---------------------------------------------------------------------------
// 2. 腐叶幼虫 Larva — the same body plan, smaller and paler
// ---------------------------------------------------------------------------

function larva(ctx) {
  const { blob, eye, spike, leg, shade: sh } = ctx;
  const shell = '#a3c46a';
  const pale = '#d6e2a8';

  const spine = [[126, 302], [162, 280], [200, 264], [236, 254]];
  const radii = [27, 29, 27, 23];

  const segments = spine.map((p, i) => blob([
    [p[0] - radii[i], p[1]],
    [p[0] - radii[i] * 0.6, p[1] - radii[i] * 0.9],
    [p[0] + radii[i] * 0.6, p[1] - radii[i] * 0.95],
    [p[0] + radii[i], p[1]],
    [p[0] + radii[i] * 0.6, p[1] + radii[i] * 0.85],
    [p[0] - radii[i] * 0.6, p[1] + radii[i] * 0.8],
  ], i % 2 === 0 ? shell : sh(shell, -0.1), { tension: 0.8 })).join('');

  const head = blob([
    [242, 236], [272, 230], [290, 248], [286, 270], [262, 282], [242, 272],
  ], sh(shell, -0.18), { tension: 0.75 });

  const legs = [144, 178, 214].map((x, i) => leg(
    [x, 296 + i * 2], [x - 6, GROUND - 4], 6, sh(shell, -0.25), { claw: [-6, 6, '#4a3524'] },
  )).join('');

  return {
    back: legs,
    body: segments + blob([[136, 316], [180, 304], [232, 296], [252, 300],
      [246, 318], [190, 326], [146, 330]], pale, { tension: 0.7, weight: 3.2 }),
    over: head,
    front: [
      eye(256, 254, 8, { iris: '#f2ede1' }),
      eye(278, 252, 6.5, { iris: '#f2ede1' }),
      spike([258, 278], [252, 300], 6, 2.4, '#4a3524', { bend: [248, 290] }),
      spike([274, 276], [284, 298], 6, 2.4, '#4a3524', { bend: [286, 288] }),
    ].join(''),
  };
}

// ---------------------------------------------------------------------------
// 3. 腐叶虫母 Grub Matriarch — bigger, darker, carrying an egg sac
// ---------------------------------------------------------------------------

function matriarch(ctx) {
  const { blob, eye, spike, leg, shade: sh, cracks } = ctx;
  const shell = '#5d8a3a';
  const shellDark = sh(shell, -0.34);
  const sac = '#c9b06a';

  const spine = [[70, 288], [118, 246], [170, 218], [224, 202], [272, 194], [310, 192]];
  const radii = [46, 52, 50, 44, 38, 32];

  const segments = spine.map((p, i) => blob([
    [p[0] - radii[i], p[1]],
    [p[0] - radii[i] * 0.62, p[1] - radii[i] * 0.92],
    [p[0] + radii[i] * 0.62, p[1] - radii[i] * 0.98],
    [p[0] + radii[i], p[1]],
    [p[0] + radii[i] * 0.62, p[1] + radii[i] * 0.88],
    [p[0] - radii[i] * 0.62, p[1] + radii[i] * 0.82],
  ], i % 2 === 0 ? shell : sh(shell, -0.1), { tension: 0.78 })).join('');

  // The egg sac: the reason this thing is a priority target, so it is the
  // brightest, roundest shape on the canvas.
  const sacShape = ellipse(150, 178, 62, 46, {
    fill: sac, stroke: '#0a0c14', 'stroke-width': 6,
  });
  const eggs = [[122, 168], [152, 156], [180, 172], [136, 198], [168, 200], [152, 180]]
    .map(([x, y], i) => ellipse(x, y, 13 - (i % 2) * 2, 11, {
      fill: sh(sac, 0.22), stroke: '#0a0c14', 'stroke-width': 2.4,
    })).join('');

  const head = blob([
    [316, 158], [356, 152], [382, 178], [378, 214], [348, 234], [316, 226], [302, 190],
  ], shellDark, { tension: 0.75 });

  const crown = [0, 1, 2, 3].map((i) => spike(
    [318 + i * 18, 160 - i * 2], [312 + i * 20, 106 - i * 6], 8, 2.4, shellDark, {},
  )).join('');

  const eyes = [[322, 186], [348, 180], [370, 190], [336, 208], [362, 208]]
    .map(([x, y], i) => eye(x, y, 9 - (i % 2), { iris: '#ffd166', style: 'cluster' })).join('');

  const legs = [];
  for (let i = 0; i < 4; i++) {
    const x = 96 + i * 56;
    legs.push(leg([x, 300 + i * -6], [x - 14, GROUND], 10, shellDark, { claw: [-12, 10, '#2b2119'] }));
    legs.push(leg([x + 24, 300 + i * -6], [x + 44, GROUND], 9, sh(shell, -0.22), { claw: [12, 10, '#2b2119'] }));
  }

  const backCracks = cracks([
    [[110, 232], [128, 210], [118, 190]],
    [[186, 200], [200, 180], [190, 162]],
    [[252, 186], [264, 168], [256, 152]],
  ], '#e8cd7c');

  return {
    back: legs.join(''),
    body: segments + sacShape + eggs + backCracks,
    over: head + crown,
    front: eyes + [
      spike([330, 232], [318, 272], 11, 4, '#2b2119', { bend: [312, 252] }),
      spike([360, 230], [372, 270], 11, 4, '#2b2119', { bend: [376, 250] }),
    ].join(''),
  };
}

// ---------------------------------------------------------------------------
// 4. 深渊哨兵 Abyss Sentinel — a floating stone construct
// ---------------------------------------------------------------------------

function sentinel(ctx) {
  const { plate, eye, spike, cracks, shade: sh } = ctx;
  const stone = '#8b7cf6';
  const stoneDark = sh(stone, -0.42);
  const core = '#e6dcff';

  // Floating: no contact shadow, and the whole body sits above the ground line.
  const body = plate([
    [200, 96], [258, 150], [272, 226], [236, 300],
    [200, 318], [164, 300], [128, 226], [142, 150],
  ], stone, { weight: 6 });

  const inner = plate([
    [200, 130], [238, 170], [246, 224], [222, 274],
    [200, 286], [178, 274], [154, 224], [162, 170],
  ], stoneDark, { weight: 3.2 });

  const coreShape = [
    el('g', null, [
      circle(200, 210, 40, { fill: core, opacity: 0.28 }),
      plate([[200, 176], [230, 210], [200, 244], [170, 210]], core, { weight: 4 }),
    ].join('')),
  ].join('');

  // Shoulder plates and blade arms, mirrored.
  const arms = [-1, 1].map((s) => [
    plate([
      [200 + s * 62, 150], [200 + s * 116, 138], [200 + s * 130, 176],
      [200 + s * 92, 194], [200 + s * 62, 184],
    ], stone, { weight: 5 }),
    spike([200 + s * 112, 168], [200 + s * 150, 236], 15, 4, stoneDark, { bend: [200 + s * 140, 200] }),
  ].join('')).join('');

  // Hovering shards, placed so the silhouette is broken on both sides.
  const shards = [
    plate([[92, 214], [116, 200], [124, 226], [98, 240]], stoneDark, { weight: 3.4 }),
    plate([[300, 240], [322, 226], [330, 252], [306, 266]], stoneDark, { weight: 3.4 }),
    plate([[146, 300], [172, 292], [178, 316], [152, 326]], stoneDark, { weight: 3.4 }),
    plate([[240, 296], [266, 288], [272, 312], [246, 322]], stoneDark, { weight: 3.4 }),
  ].join('');

  const veins = cracks([
    [[176, 156], [190, 186], [178, 214]],
    [[228, 158], [214, 190], [226, 218]],
    [[200, 262], [188, 284], [200, 300]],
  ], core);

  return {
    back: shards,
    body: body + inner + arms + veins,
    over: '',
    front: coreShape + eye(200, 210, 13, { iris: '#ffffff', style: 'slit', pupil: '#2b1f5c' }),
  };
}

// ---------------------------------------------------------------------------
// 5. 灰烬之王 Ashen King — two phases
// ---------------------------------------------------------------------------

function ashenKing(ctx) {
  const { plate, spike, blob, eye, cracks, shade: sh, phase } = ctx;
  const two = phase >= 2;

  const ash = two ? '#8a3520' : '#5a3a30';
  const ashDark = sh(ash, -0.4);
  const ember = '#ff6b4a';
  const molten = '#ffd166';

  // A long cinder cloak: the widest shape on the canvas, so the boss reads as
  // large even in a small battle card.
  const cloak = blob([
    [200, 92], [280, 128], [318, 216], [336, 316],
    [300, 340], [252, 300], [200, 336], [148, 300], [100, 340], [64, 316],
    [82, 216], [120, 128],
  ], ashDark, { tension: 0.72 });

  const torso = plate([
    [200, 118], [252, 148], [262, 224], [236, 274],
    [200, 284], [164, 274], [138, 224], [148, 148],
  ], ash, { weight: 6 });

  // Crown: four points, taller in phase 2.
  const crownH = two ? 76 : 52;
  const crown = [0, 1, 2, 3].map((i) => {
    const x = 152 + i * 32;
    const h = crownH - Math.abs(1.5 - i) * 14;
    return spike([x, 118], [x - 6 + i * 4, 118 - h], 11, 3, two ? molten : '#8a6a3a', {});
  }).join('') + plate([
    [146, 122], [254, 122], [246, 140], [154, 140],
  ], two ? molten : '#8a6a3a', { weight: 4 });

  // The face is a void with two points of light. Giving it a real face would
  // make it a person; it is supposed to be a thing that used to be one.
  const visor = plate([
    [166, 152], [234, 152], [242, 182], [200, 198], [158, 182],
  ], '#0a0c14', { weight: 4 });
  const eyes = [
    eye(182, 172, 9, { iris: ember, style: 'slit' }),
    eye(218, 172, 9, { iris: ember, style: 'slit' }),
  ].join('');

  // Phase 2: the shell splits and the core shows.
  const rupture = two ? blob([
    [172, 214], [200, 200], [232, 216], [238, 258],
    [206, 288], [172, 276], [160, 244],
  ], '#2a0f0a', { tension: 0.7, weight: 4 }) + blob([
    [186, 226], [200, 218], [218, 228], [222, 254],
    [202, 272], [184, 262], [176, 242],
  ], molten, { tension: 0.7, weight: 3.4 }) : '';

  const arms = [-1, 1].map((s) => [
    plate([
      [200 + s * 62, 148], [200 + s * 118, 140], [200 + s * 130, 182],
      [200 + s * 88, 196], [200 + s * 60, 184],
    ], ash, { weight: 5 }),
    spike([200 + s * 120, 180], [200 + s * 158, 292], 14, 5, ashDark, { bend: [200 + s * 150, 240] }),
  ].join('')).join('');

  const fire = two
    ? [0, 1, 2, 3, 4].map((i) => spike(
      [110 + i * 46, 330], [104 + i * 46, 250 - (i % 3) * 22], 16, 4, ember, {},
    )).join('')
    : [0, 1, 2].map((i) => spike(
      [130 + i * 70, 332], [126 + i * 70, 288], 12, 3, ember, {},
    )).join('');

  const seams = cracks(two
    ? [[[160, 200], [172, 240], [158, 276]], [[244, 198], [232, 242], [246, 280]],
      [[200, 290], [200, 320]]]
    : [[[176, 210], [188, 246], [178, 274]]],
  two ? molten : ember);

  return {
    back: cloak + fire,
    body: torso + arms + rupture,
    over: crown + visor + seams,
    front: eyes,
  };
}

// ---------------------------------------------------------------------------
// 6. 灰烬残骸 Ash Husk — a shambling, hollowed-out remains
// ---------------------------------------------------------------------------

function ashHusk(ctx) {
  const { plate, spike, blob, eye, cracks, shade: sh } = ctx;
  const char = '#4a3a34';
  const charDark = sh(char, -0.4);
  const ember = '#b3563a';

  const legs = [-1, 1].map((s) => [
    spike([200 + s * 24, 262], [200 + s * 40, 330], 15, 9, charDark, { bend: [200 + s * 44, 296] }),
    spike([200 + s * 40, 328], [200 + s * 52, GROUND], 10, 7, charDark, {}),
  ].join('')).join('');

  const torso = plate([
    [200, 138], [252, 168], [258, 232], [232, 268],
    [200, 274], [168, 268], [142, 232], [148, 168],
  ], char, { weight: 6 });

  const ribs = [0, 1, 2].map((i) => path(smoothOpen([
    [158, 176 + i * 24], [200, 168 + i * 24], [242, 176 + i * 24],
  ], 0.7), shape({ fill: 'none', stroke: charDark, 'stroke-width': 5 }))).join('');

  const hollow = blob([
    [176, 206], [200, 196], [228, 208], [232, 240], [200, 258], [174, 240],
  ], '#1a0f0c', { tension: 0.7, weight: 4 });

  const skull = blob([
    [200, 84], [240, 96], [252, 130], [232, 158],
    [200, 164], [168, 158], [148, 130], [160, 96],
  ], sh(char, 0.18), { tension: 0.78 });

  const jaw = plate([
    [172, 158], [228, 158], [222, 184], [200, 192], [178, 184],
  ], charDark, { weight: 4 });

  const arms = [-1, 1].map((s) => [
    spike([200 + s * 56, 176], [200 + s * 116, 220], 14, 9, char, { bend: [200 + s * 96, 186] }),
    spike([200 + s * 116, 220], [200 + s * 128, 300], 10, 6, charDark, { bend: [200 + s * 134, 262] }),
    [0, 1, 2].map((i) => spike(
      [200 + s * 128, 298], [200 + s * (134 + i * 12), 318 + i * 4], 4, 1.6, charDark, {},
    )).join(''),
  ].join('')).join('');

  const burn = cracks([
    [[166, 224], [178, 248], [168, 266]],
    [[236, 226], [226, 250], [238, 268]],
    [[200, 268], [196, 292], [206, 310]],
    [[186, 120], [196, 140], [188, 152]],
  ], ember);

  return {
    back: legs,
    body: torso + ribs + arms,
    over: hollow + skull + jaw,
    front: burn + [
      eye(184, 124, 9, { iris: ember, style: 'slit' }),
      eye(216, 124, 9, { iris: ember, style: 'slit' }),
    ].join(''),
  };
}

// ---------------------------------------------------------------------------

const BUILDS = {
  rotgrub, larva, grub_matriarch: matriarch, abyss_sentinel: sentinel,
  ashen_king: ashenKing, ash_husk: ashHusk,
};

/** Per-enemy art direction that is not part of the gameplay definition. */
const ART = {
  rotgrub: { auraKind: 'forest', motifKind: 'spore', bust: [80, 140, 250, 250] },
  larva: { auraKind: 'forest', motifKind: 'spore', bust: [110, 200, 220, 220] },
  grub_matriarch: { auraKind: 'forest', motifKind: 'spore', bust: [70, 90, 300, 300] },
  abyss_sentinel: { element: 'quantum', auraKind: 'stone', motifKind: 'quantum', bust: [80, 70, 260, 260] },
  ashen_king: { element: 'fire', auraKind: 'ash', motifKind: 'ember', bust: [60, 60, 290, 290] },
  ash_husk: { element: 'fire', auraKind: 'ash', motifKind: 'ember', bust: [90, 60, 240, 240] },
};

function enemyArt(id, options = {}) {
  const base = ENEMIES[id];
  const build = BUILDS[id];
  const art = ART[id] || {};
  if (!base) throw new Error(`Unknown enemy: ${id}`);
  if (!build) throw new Error(`No art build for enemy: ${id}`);
  return {
    ...art,
    id,
    name: base.name,
    title: base.title,
    element: art.element || 'physical',
    accent: base.color,
    phase: options.phase,
    build,
  };
}

function enemyArtIds() {
  return Object.keys(BUILDS);
}

module.exports = { ART, BUILDS, enemyArt, enemyArtIds };
