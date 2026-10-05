'use strict';

/**
 * Town NPC art.
 *
 * The two shopkeepers previously borrowed a playable character's portrait,
 * which made the innkeeper look exactly like Elise and the quartermaster look
 * exactly like Byakuya. They now have their own faces, hair and clothes.
 *
 * They deliberately reuse the *hair style* system and the humanoid skeleton
 * rather than getting bespoke bodies: an NPC stands in the same world as the
 * cast, so they should share its proportions. What makes them distinct is hair
 * shape, colour, costume and face marks — which is exactly the axis a real
 * character designer would reach for too.
 */

const { WORLD } = require('../../core/world-data');
const { shade } = require('../palette');
const {
  garment, skirt, sleeve, boot, glove, stole, belt, pauldron, draw,
} = require('../outfits');
const { smoothClosed } = require('../svg');

/** Look up an NPC by id across every node in the prologue. */
function findNpc(id) {
  for (const node of Object.values(WORLD.nodes)) {
    for (const npc of node.npcs || []) {
      if (npc.id === id) return npc;
    }
  }
  return null;
}

function pointsHem(half, y, tips) {
  const step = (half * 2) / (tips.length + 1);
  const out = [[230 - half, y - 30]];
  tips.forEach((depth, i) => out.push([230 - half + step * (i + 1), y - depth]));
  out.push([230 + half, y - 30]);
  return out;
}

// ---------------------------------------------------------------------------
// 旅店老板娘 Innkeeper — apron, rolled sleeves, kerchief
// ---------------------------------------------------------------------------

function innkeeperCostume(pose) {
  const dress = '#6b4a63';
  const dressDark = shade(dress, -0.22);
  const apron = '#efe6d2';
  const apronDark = shade(apron, -0.14);
  const kerchief = '#c25a52';

  return {
    back: '',
    mid: [
      draw(skirt(pose, {
        fromY: 448, fromHalf: 76, toY: 742, toHalf: 118,
        points: pointsHem(118, 742, [18, 5, 20, 5]),
      }), dressDark),
      draw(garment(pose, {
        hemY: 560, hemHalf: 100, shoulderHalf: 78, neckDrop: 34,
        hem: pointsHem(100, 560, [16, 4, 18]),
      }), dress),
      // Apron: the shape that says "works here" faster than any other.
      draw(smoothClosed([
        [186, 330], [274, 330], [292, 470], [282, 700], [230, 722], [178, 700], [168, 470],
      ], 0.6), apron),
      draw(smoothClosed([
        [186, 330], [274, 330], [278, 356], [182, 356],
      ], 0.4), apronDark),
      sleeve(pose, 'L', { fill: dress, to: 'elbow', cuff: apron, pad: 10 }),
      sleeve(pose, 'R', { fill: dress, to: 'elbow', cuff: apron, pad: 10 }),
      stole(pose, { fill: kerchief, shadow: shade(kerchief, -0.28), lengthL: 84, lengthR: 70, width: 26 }),
      belt(pose, { fill: '#4a3524', buckle: '#c8a44a', y: 450, half: 74 }),
      // A towel tucked through the belt.
      draw(smoothClosed([[252, 452], [280, 456], [276, 512], [250, 506]], 0.4), apronDark),
    ].join(''),
    boots: [
      boot(pose, 'L', { fill: '#3b2a20', topY: 806, cuff: '#6b4d33', sole: '#241a14' }),
      boot(pose, 'R', { fill: '#3b2a20', topY: 806, cuff: '#6b4d33', sole: '#241a14' }),
    ].join(''),
    hands: [
      glove(pose, 'L', { fill: apron, length: 0.2 }),
      glove(pose, 'R', { fill: apron, length: 0.2 }),
    ].join(''),
  };
}

// ---------------------------------------------------------------------------
// 军需官 Quartermaster — military coat, pauldron, old scars
// ---------------------------------------------------------------------------

function quartermasterCostume(pose) {
  const coat = '#3f4a3c';
  const coatDark = shade(coat, -0.28);
  const leather = '#4a3524';
  const brass = '#c8a44a';
  const steel = '#8c93a8';

  return {
    back: '',
    mid: [
      draw(skirt(pose, {
        fromY: 448, fromHalf: 80, toY: 690, toHalf: 100,
        points: pointsHem(100, 690, [12, 3, 14]),
      }), coatDark),
      draw(garment(pose, {
        hemY: 520, hemHalf: 96, shoulderHalf: 86, neckDrop: 20,
        hem: pointsHem(96, 520, [10, 2, 12]),
      }), coat),
      // Crossed ammo pouches, worn high on the chest.
      draw(smoothClosed([[204, 288], [256, 288], [250, 340], [210, 340]], 0.35), leather, 2.4),
      draw(smoothClosed([[210, 348], [262, 348], [256, 400], [216, 400]], 0.35), leather, 2.4),
      sleeve(pose, 'L', { fill: coat, to: 'wrist', cuff: leather, pad: 10 }),
      sleeve(pose, 'R', { fill: coat, to: 'wrist', cuff: leather, pad: 10 }),
      pauldron(pose, 'R', { fill: steel, shadow: shade(steel, -0.4) }),
      stole(pose, { fill: coatDark, shadow: shade(coatDark, -0.3), lengthL: 70, lengthR: 62, width: 28 }),
      belt(pose, { fill: leather, buckle: brass, y: 448, half: 76, strap: shade(leather, 0.16) }),
    ].join(''),
    boots: [
      boot(pose, 'L', { fill: '#241f18', topY: 690, cuff: leather, sole: '#14110d' }),
      boot(pose, 'R', { fill: '#241f18', topY: 690, cuff: leather, sole: '#14110d' }),
    ].join(''),
    hands: [
      glove(pose, 'L', { fill: leather, length: 0.5 }),
      glove(pose, 'R', { fill: leather, length: 0.5 }),
    ].join(''),
  };
}

// ---------------------------------------------------------------------------

const ART = {
  innkeeper: {
    pose: 'stand',
    scale: 0.99,
    skin: 'light',
    eye: '#8a5a3c',
    brow: '#4a3225',
    hair: { style: 'bun', base: '#4a3328', shadow: '#2e2019' },
    accent: '#c25a52',
    costume: innkeeperCostume,
    weapon: null,
  },
  quartermaster: {
    pose: 'cross',
    scale: 1.04,
    skin: 'tan',
    eye: '#7a6a4a',
    brow: '#3a2f22',
    hair: { style: 'crop', base: '#6b6157', shadow: '#413a33' },
    accent: '#8c93a8',
    marks: { beard: { color: '#4a4038', length: 0.35 }, scar: { side: 'R' }, patch: { side: 'L' } },
    costume: quartermasterCostume,
    weapon: null,
  },
};

function npcArt(id) {
  const base = findNpc(id);
  const art = ART[id];
  if (!base) throw new Error(`Unknown NPC: ${id}`);
  if (!art) throw new Error(`No art spec for NPC: ${id}`);
  return {
    ...art,
    id,
    name: base.name,
    en: '',
    title: '',
    element: 'physical',
    // The gallery shows one line of flavour. For an NPC the first thing they
    // say is a better introduction than a gameplay hint, and it is already
    // written.
    lore: (base.dialogue && base.dialogue[0]) || base.hint || '',
    hint: base.hint || '',
    accent: art.accent,
  };
}

function npcArtIds() {
  return Object.keys(ART);
}

module.exports = { ART, npcArt, npcArtIds, findNpc };
