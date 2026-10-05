'use strict';

/**
 * Character art specs.
 *
 * Each entry is the *art* half of a character: hair, skin, costume, prop and
 * pose. Name, title, element and role are read from `src/core/characters.js`
 * at build time, so renaming a character in the data file renames it in the art
 * too and the two can never drift.
 *
 * A costume is a function rather than a table because a costume is genuinely
 * layered geometry (cape behind, garment, sleeves, collar, belt, boots) and
 * flattening that into key/value pairs would need a mini-language. What the
 * function gets from the shared helpers is every proportion that is hard to
 * eyeball; what it decides itself is only silhouette and colour.
 */

const { CHARACTERS } = require('../../core/characters');
const { shade } = require('../palette');
const {
  garment, skirt, sleeve, boot, glove, collarHigh, stole, belt, pauldron, cape, draw,
} = require('../outfits');
const { smoothClosed } = require('../svg');

/** Trim a garment's hem into points. Authored left to right, like all hems. */
function pointsHem(half, y, tips) {
  const step = (half * 2) / (tips.length + 1);
  const out = [[230 - half, y - 34]];
  tips.forEach((depth, i) => {
    out.push([230 - half + step * (i + 1), y - depth]);
  });
  out.push([230 + half, y - 34]);
  return out;
}

// ---------------------------------------------------------------------------
// 1. 苍叶 Ayaha — wind, sabre, short split coat
// ---------------------------------------------------------------------------

function ayahaCostume(pose) {
  const coat = '#e9f5f0';
  const coatDark = shade(coat, -0.16);
  const inner = '#233240';
  const trim = '#5ee6a8';
  const bootColor = '#2b3448';

  return {
    // A torn, split coat tail behind her: the wind-blown read starts here.
    back: cape(pose, {
      fill: inner, shadow: shade(inner, -0.35), spread: 112, length: 452, split: true,
    }),
    mid: [
      // Inner layer, slightly longer and darker, so the split coat has depth.
      draw(skirt(pose, {
        fromY: 448, fromHalf: 74, toY: 540, toHalf: 104,
        points: pointsHem(104, 540, [30, 6, 26]),
      }), inner),
      // The coat itself: open front, hem cut into wind-torn points.
      draw(garment(pose, {
        hemY: 486, hemHalf: 96, shoulderHalf: 82, neckDrop: 44,
        hem: pointsHem(96, 486, [34, 8, 30, 4]),
      }), coat),
      draw(garment(pose, {
        hemY: 470, hemHalf: 88, shoulderHalf: 74, neckDrop: 34,
        hem: pointsHem(88, 470, [26, 4, 22]),
      }), coatDark),
      sleeve(pose, 'L', { fill: coat, to: 'wrist', cuff: trim, pad: 9 }),
      sleeve(pose, 'R', { fill: coat, to: 'wrist', cuff: trim, pad: 9 }),
      pauldron(pose, 'L', { fill: coat, shadow: trim }),
      stole(pose, { fill: trim, shadow: shade(trim, -0.3), lengthL: 176, lengthR: 122, width: 20 }),
      belt(pose, { fill: '#4a3524', buckle: '#c8a44a', y: 436, half: 66 }),
    ].join(''),
    boots: [
      boot(pose, 'L', { fill: bootColor, topY: 690, cuff: trim, sole: '#161b28' }),
      boot(pose, 'R', { fill: bootColor, topY: 690, cuff: trim, sole: '#161b28' }),
    ].join(''),
    hands: [
      glove(pose, 'L', { fill: inner, length: 0.3 }),
      glove(pose, 'R', { fill: inner, length: 0.3 }),
    ].join(''),
  };
}

// ---------------------------------------------------------------------------
// 2. 御巫铃 Rinné — fire, alchemy, apron and pack
// ---------------------------------------------------------------------------

function rinneCostume(pose) {
  const coat = '#b8452e';
  const coatDark = shade(coat, -0.22);
  const apron = '#d9c39a';
  const leather = '#4a3524';
  const brass = '#c8a44a';

  // The pack is the single most recognisable thing about her silhouette, so it
  // is drawn as one big rounded mass rather than as a tidy backpack.
  const pack = draw(smoothClosed([
    [286, 268], [352, 292], [372, 396], [356, 486], [300, 496], [276, 396], [272, 300],
  ], 0.75), leather);

  const packDetail = [
    draw(smoothClosed([[300, 300], [352, 318], [346, 350], [296, 336]], 0.5), shade(leather, 0.16)),
    draw(smoothClosed([[304, 400], [356, 414], [350, 448], [300, 436]], 0.5), shade(leather, 0.16)),
  ].join('');

  return {
    back: pack + packDetail,
    mid: [
      draw(skirt(pose, {
        fromY: 452, fromHalf: 76, toY: 726, toHalf: 118,
        points: pointsHem(118, 726, [22, 6, 26, 8]),
      }), coatDark),
      draw(garment(pose, {
        hemY: 690, hemHalf: 110, shoulderHalf: 80, neckDrop: 38,
        hem: pointsHem(110, 690, [24, 8, 28, 6]),
      }), coat),
      // Apron panel down the front, with a bib.
      draw(smoothClosed([
        [186, 320], [274, 320], [288, 470], [276, 640], [230, 656], [184, 640], [172, 470],
      ], 0.6), apron),
      draw(smoothClosed([
        [230, 268], [272, 282], [268, 322], [230, 330], [192, 322], [188, 282],
      ], 0.5), shade(apron, -0.12)),
      sleeve(pose, 'L', { fill: coat, to: 'elbow', cuff: leather, pad: 10 }),
      sleeve(pose, 'R', { fill: coat, to: 'elbow', cuff: leather, pad: 10 }),
      stole(pose, { fill: coatDark, shadow: shade(coatDark, -0.3), lengthL: 96, lengthR: 84, width: 30 }),
      belt(pose, { fill: leather, buckle: brass, y: 452, half: 74, strap: shade(leather, -0.2) }),
      // Two tool loops, because an apron with nothing on it reads as a smock.
      draw(smoothClosed([[186, 470], [206, 470], [204, 512], [188, 512]], 0.4), leather),
      draw(smoothClosed([[254, 470], [274, 470], [272, 512], [256, 512]], 0.4), leather),
    ].join(''),
    boots: [
      boot(pose, 'L', { fill: leather, topY: 780, cuff: shade(leather, 0.18), sole: '#2b2119' }),
      boot(pose, 'R', { fill: leather, topY: 780, cuff: shade(leather, 0.18), sole: '#2b2119' }),
    ].join(''),
    hands: [
      glove(pose, 'L', { fill: leather, length: 0.46 }),
      glove(pose, 'R', { fill: leather, length: 0.46 }),
    ].join(''),
  };
}

// ---------------------------------------------------------------------------
// 3. 神代凛 Rin — ice, long coat, high collar
// ---------------------------------------------------------------------------

function rinCostume(pose) {
  const coat = '#233256';
  const coatDark = shade(coat, -0.26);
  const frost = '#dceaf7';
  const ice = '#63d4ff';
  const bootColor = '#161d30';

  return {
    back: cape(pose, {
      fill: coatDark, shadow: shade(coatDark, -0.4), spread: 126, length: 748, split: true,
    }),
    mid: [
      draw(skirt(pose, {
        fromY: 446, fromHalf: 78, toY: 792, toHalf: 126,
        points: pointsHem(126, 792, [18, 4, 20, 4]),
      }), coat),
      // Bodice. Without this the character is a skirt and a scarf over a bare
      // torso — the kind of omission that is obvious in a render and invisible
      // in the source.
      draw(garment(pose, {
        hemY: 470, hemHalf: 92, shoulderHalf: 82, neckDrop: 30,
        hem: pointsHem(92, 470, [8, 2, 10]),
      }), coat),
      // A pale inner panel: the vertical line down the middle is what makes a
      // long coat read as a coat rather than a dress.
      draw(smoothClosed([
        [214, 300], [246, 300], [256, 470], [250, 780], [230, 800], [210, 780], [204, 470],
      ], 0.55), frost),
      sleeve(pose, 'L', { fill: coat, to: 'wrist', cuff: frost, pad: 10 }),
      sleeve(pose, 'R', { fill: coat, to: 'wrist', cuff: frost, pad: 10 }),
      collarHigh(pose, { fill: frost, height: 92, spread: 40 }),
      belt(pose, { fill: '#101728', buckle: ice, y: 446, half: 72 }),
      // Frost gathering at the hem, echoing the motif without repeating it.
      draw(smoothClosed([[176, 770], [204, 758], [210, 800], [180, 806]], 0.4), ice, 2.2),
      draw(smoothClosed([[254, 758], [284, 772], [280, 806], [250, 800]], 0.4), ice, 2.2),
    ].join(''),
    boots: [
      boot(pose, 'L', { fill: bootColor, topY: 668, cuff: frost, sole: '#0b0f1a' }),
      boot(pose, 'R', { fill: bootColor, topY: 668, cuff: frost, sole: '#0b0f1a' }),
    ].join(''),
    hands: [
      glove(pose, 'L', { fill: coatDark, length: 0.34 }),
      glove(pose, 'R', { fill: coatDark, length: 0.34 }),
    ].join(''),
  };
}

// ---------------------------------------------------------------------------
// 4. 白鸦 Byakuya — lightning, long dark coat, harness
// ---------------------------------------------------------------------------

function byakuyaCostume(pose) {
  const coat = '#262c46';
  const coatDark = shade(coat, -0.28);
  const strap = '#14182a';
  const steel = '#8c93a8';
  const spark = '#c77dff';

  return {
    back: '',
    mid: [
      draw(skirt(pose, {
        fromY: 450, fromHalf: 80, toY: 736, toHalf: 108,
        points: [[230 - 108, 736 - 26], [230 - 108, 736], [230 - 60, 700],
          [230 - 14, 748], [230, 700], [230 + 14, 748], [230 + 60, 700],
          [230 + 108, 736], [230 + 108, 736 - 26]],
      }), coatDark),
      draw(garment(pose, {
        hemY: 500, hemHalf: 100, shoulderHalf: 86, neckDrop: 22,
        hem: pointsHem(100, 500, [10, 2, 12]),
      }), coat),
      // Chest harness: two diagonals and a plate. Cheap, and it immediately
      // says "soldier" rather than "person in a coat".
      draw(smoothClosed([
        [206, 292], [258, 292], [252, 348], [212, 348],
      ], 0.35), steel, 2.4),
      sleeve(pose, 'L', { fill: coat, to: 'wrist', cuff: strap, pad: 10 }),
      sleeve(pose, 'R', { fill: coat, to: 'wrist', cuff: strap, pad: 10 }),
      pauldron(pose, 'R', { fill: steel, shadow: shade(steel, -0.4) }),
      belt(pose, { fill: strap, buckle: spark, y: 448, half: 74, strap: shade(strap, 0.18) }),
      collarHigh(pose, { fill: coatDark, height: 58, spread: 34 }),
    ].join(''),
    boots: [
      boot(pose, 'L', { fill: '#12162a', topY: 664, cuff: steel, sole: '#080a14' }),
      boot(pose, 'R', { fill: '#12162a', topY: 664, cuff: steel, sole: '#080a14' }),
    ].join(''),
    hands: [
      glove(pose, 'L', { fill: strap, length: 0.52 }),
      glove(pose, 'R', { fill: strap, length: 0.52 }),
    ].join(''),
  };
}

// ---------------------------------------------------------------------------
// 5. 艾莉丝 Elise — imaginary, white robe, stole
// ---------------------------------------------------------------------------

function eliseCostume(pose) {
  const robe = '#f2ede1';
  const robeDark = shade(robe, -0.12);
  const gold = '#c8a44a';
  const goldLight = '#e8cd7c';
  const tabard = '#fbf7ee';

  return {
    back: '',
    mid: [
      draw(skirt(pose, {
        fromY: 448, fromHalf: 78, toY: 834, toHalf: 130,
        points: pointsHem(130, 834, [14, 4, 16, 4, 14]),
      }), robeDark),
      draw(garment(pose, {
        hemY: 780, hemHalf: 120, shoulderHalf: 80, neckDrop: 40,
        hem: pointsHem(120, 780, [16, 6, 18, 6, 16]),
      }), robe),
      // Tabard: a narrower panel with a gold border, front only.
      draw(smoothClosed([
        [196, 300], [264, 300], [282, 470], [272, 740], [230, 762], [188, 740], [178, 470],
      ], 0.6), tabard),
      draw(smoothClosed([
        [210, 316], [250, 316], [264, 470], [256, 726], [230, 744], [204, 726], [196, 470],
      ], 0.55), gold, 2.6),
      sleeve(pose, 'L', { fill: robe, to: 'wrist', cuff: goldLight, pad: 11 }),
      sleeve(pose, 'R', { fill: robe, to: 'wrist', cuff: goldLight, pad: 11 }),
      stole(pose, { fill: goldLight, shadow: gold, lengthL: 300, lengthR: 210, width: 30 }),
      belt(pose, { fill: gold, buckle: goldLight, y: 444, half: 70 }),
    ].join(''),
    boots: [
      boot(pose, 'L', { fill: '#e6ddc8', topY: 800, cuff: gold, sole: '#9a8a63' }),
      boot(pose, 'R', { fill: '#e6ddc8', topY: 800, cuff: gold, sole: '#9a8a63' }),
    ].join(''),
    hands: [
      glove(pose, 'L', { fill: robeDark, length: 0.28 }),
      glove(pose, 'R', { fill: robeDark, length: 0.28 }),
    ].join(''),
  };
}

// ---------------------------------------------------------------------------
// Art specs, keyed by character id
// ---------------------------------------------------------------------------

const ART = {
  ayaha: {
    pose: 'ready',
    // Heights. Shared skeleton, different people: the scale is applied about
    // the ground line so everyone still stands on the same floor.
    scale: 0.95,
    skin: 'light',
    eye: '#5ee6a8',
    hair: { style: 'ayaha', base: '#4c9c88', shadow: '#2f6b5c' },
    costume: ayahaCostume,
    weapon: 'sabre',
    gear: { steel: '#e4edf7', edge: '#ffffff', grip: '#2b3448', guard: '#c8a44a' },
  },
  rinne: {
    pose: 'hip',
    scale: 0.97,
    skin: 'warm',
    eye: '#ff8a5c',
    hair: { style: 'rinne', base: '#c25a34', shadow: '#8e3c1f' },
    costume: rinneCostume,
    weapon: 'satchel',
    gear: { bag: '#6b4d33', strap: '#4a3524', glass: '#7fd7e8', cork: '#c8a44a', fuse: '#ff6b4a' },
  },
  rin: {
    pose: 'cast',
    scale: 1,
    skin: 'porcelain',
    eye: '#63d4ff',
    hair: { style: 'rin', base: '#cfe3f2', shadow: '#9db8cd' },
    costume: rinCostume,
    weapon: 'orb',
    gear: { core: '#e6f7ff', ring: '#63d4ff' },
  },
  byakuya: {
    pose: 'guard',
    scale: 1.03,
    skin: 'tan',
    eye: '#c77dff',
    hair: { style: 'byakuya', base: '#e8e6e0', shadow: '#a9a6a0' },
    costume: byakuyaCostume,
    weapon: 'spear',
    gear: { shaft: '#3a2c22', steel: '#c9d1e4', glow: '#c77dff' },
  },
  elise: {
    pose: 'reach',
    scale: 1.01,
    skin: 'light',
    eye: '#ffd166',
    // The hair used to be `#e8c98a`, which sat within ~27 RGB of her skin —
    // low enough that the fringe and the forehead read as one shape. Pushing
    // it darker is the whole fix.
    hair: { style: 'elise', base: '#d9b26a', shadow: '#a8834a' },
    costume: eliseCostume,
    weapon: 'staff',
    gear: { shaft: '#8a6a3a', steel: '#e8cd7c', gem: '#ffd166' },
  },
};

/** Merge the art spec with the gameplay definition. */
function characterArt(id) {
  const base = CHARACTERS[id];
  const art = ART[id];
  if (!base) throw new Error(`Unknown character: ${id}`);
  if (!art) throw new Error(`No art spec for character: ${id}`);
  return {
    ...art,
    id,
    name: base.name,
    en: base.en,
    title: base.title,
    element: base.element,
    role: base.role,
    rarity: base.rarity,
    lore: base.lore,
    accent: base.color,
  };
}

function characterArtIds() {
  return Object.keys(ART);
}

module.exports = { ART, characterArt, characterArtIds };
