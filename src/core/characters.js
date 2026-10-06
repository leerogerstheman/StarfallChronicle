'use strict';

/**
 * The character roster.
 *
 * Five playable characters, each built around a different verb so that the
 * party covers the four mechanical pillars the engine offers:
 *
 *   苍叶 Ayaha   — wind swordswoman. Break/weakness specialist: multi-hit,
 *                  toughness shredding, self-haste on break. (Ys: fast combo)
 *   御巫铃 Rinné — fire alchemist. Status applier: burn/brand stacking and
 *                  detonation on hit. (Atelier: item synthesis)
 *   神代凛 Rin   — ice sorceress. AoE control: freeze lock and speed debuffs.
 *                  (Trails: orbal arts)
 *   白鸦 Byakuya — lightning lancer. Turn-order manipulation: delays and
 *                  advances. (Trails: delay crafts / Ys: dash attacks)
 *   艾莉丝 Elise — healer/buffer. Sustain: heals, cleanse, shields, and the
 *                  party-wide damage buff. (Atelier/Trails support)
 *
 * Balance intent for the demo: the party at level 12 should clear the trash
 * wave with basic attacks, need real skill use on the elite, and need the
 * ultimate chain on the boss. `test/balance.js` asserts roughly that.
 *
 * Stats are level-1 bases; `BALANCE.GROWTH` extrapolates them per level so a
 * designer only ever edits one row.
 */

const { define } = require('./skills');

/**
 * A character definition.
 *
 * `skills` uses named slots rather than an array so the engine can ask for
 * `char.skills.ultimate` without index bookkeeping, and so a missing slot is
 * `undefined` instead of "the wrong skill".
 */
const CHARACTERS = {};

function defineCharacter(char) {
  const full = {
    element: 'physical',
    role: 'attacker',
    rarity: 4,
    level: 1,
    exp: 0,
    /** Stat bumps granted by unlocked talents, applied as `traitStats`. */
    traitStats: {},
    /** Ids of skills unlocked at each level, simplest possible unlock table. */
    unlock: {},
    ...char,
  };
  if (CHARACTERS[full.id]) throw new Error(`Duplicate character id: ${full.id}`);
  CHARACTERS[full.id] = full;
  return full;
}

// ---------------------------------------------------------------------------
// 1. 苍叶 Ayaha
// ---------------------------------------------------------------------------
defineCharacter({
  id: 'ayaha',
  name: '苍叶',
  en: 'Ayaha',
  title: '疾风之刃',
  element: 'wind',
  role: 'breaker',
  rarity: 5,
  color: '#5ee6a8',
  sprite: 'ayaha',
  lore:
    '来自被风暴吞没的海港城镇。她挥剑的速度快到看不清刀身，' +
    '据说那是因为她在等一场永远追不上的风。',
  baseStats: {
    maxHp: 1180, atk: 168, def: 82, spd: 112,
    critRate: 0.12, critDmg: 1.60, effectHit: 0.05, effectRes: 0.05,
    maxEnergy: 120, break: 1.25,
  },
  skills: {
    basic: 'ayaha_basic',
    skill: 'ayaha_skill',
    ultimate: 'ayaha_ult',
    talent: 'ayaha_talent',
    technique: 'ayaha_technique',
  },
  /** Passives that need code; `ayahaTalentBreak` lives in battle/scripts.js. */
  hooks: [{ on: 'break', handler: 'ayahaTalentBreak' }],
  /**
   * Follow-ups. `break` here fires on a break *this unit* dealt (the engine
   * scopes the `break` event to the breaker), so the whole loop is "break →
   * gust → act sooner again".
   */
  followups: [{ on: 'break', skill: 'ayaha_follow_gust', chance: 1, limitPerRound: 1, targetFrom: 'triggerTarget' }],
  unlock: {
    1: ['ayaha_talent'],
    6: [],
    10: [],
  },
});

// ---------------------------------------------------------------------------
// 2. 御巫铃 Rinné
// ---------------------------------------------------------------------------
defineCharacter({
  id: 'rinne',
  name: '御巫铃',
  en: 'Rinné',
  title: '灰烬调合师',
  element: 'fire',
  role: 'debuffer',
  rarity: 5,
  color: '#ff6b4a',
  sprite: 'rinne',
  lore:
    '把一整座工房搬上旅途的炼金术士。她的背包里永远有能炸掉半座桥的' +
    '炸弹，和一瓶刚好够用的胃药。',
  baseStats: {
    maxHp: 1020, atk: 182, def: 70, spd: 98,
    critRate: 0.08, critDmg: 1.50, effectHit: 0.28, effectRes: 0.05,
    maxEnergy: 110, break: 1.0,
  },
  skills: {
    basic: 'rinne_basic',
    skill: 'rinne_skill',
    ultimate: 'rinne_ult',
    talent: 'rinne_talent',
  },
  hooks: [{ on: 'damageDealt', handler: 'rinneTalentDetonate' }],
  /** A break on a marked, burning body is her best detonation, so it fires twice. */
  followups: [{ on: 'break', skill: 'rinne_follow_ash', chance: 1, limitPerRound: 1, targetFrom: 'triggerTarget' }],
  unlock: { 1: ['rinne_talent'] },
});

// ---------------------------------------------------------------------------
// 3. 神代凛 Rin
// ---------------------------------------------------------------------------
defineCharacter({
  id: 'rin',
  name: '神代凛',
  en: 'Rin',
  title: '霜之魔女',
  element: 'ice',
  role: 'controller',
  rarity: 5,
  color: '#63d4ff',
  sprite: 'rin',
  lore:
    '学院里最年轻的导力魔法讲师。她讲课时气温会下降，' +
    '学生说那不是魔法，是她本人太冷了。',
  baseStats: {
    maxHp: 980, atk: 190, def: 66, spd: 96,
    critRate: 0.10, critDmg: 1.55, effectHit: 0.32, effectRes: 0.08,
    maxEnergy: 130, break: 1.0,
  },
  skills: {
    basic: 'rin_basic',
    skill: 'rin_skill',
    ultimate: 'rin_ult',
    talent: 'rin_talent',
  },
  hooks: [{ on: 'statusApplied', handler: 'rinTalentFreeze' }],
  /** Frost after anyone else's ultimate: turn a teammate's burst into setup. */
  followups: [{ on: 'allyUltimate', skill: 'rin_follow_frost', chance: 0.7, limitPerRound: 1, targetFrom: 'randomEnemy' }],
  unlock: { 1: ['rin_talent'] },
});

// ---------------------------------------------------------------------------
// 4. 白鸦 Byakuya
// ---------------------------------------------------------------------------
defineCharacter({
  id: 'byakuya',
  name: '白鸦',
  en: 'Byakuya',
  title: '雷鸣之枪',
  element: 'lightning',
  role: 'attacker',
  rarity: 5,
  color: '#c77dff',
  sprite: 'byakuya',
  lore:
    '沉默的雇佣枪兵，枪尖缠着他自己也不知道来历的雷。' +
    '他记得所有被他推迟过的死亡，唯独记不住自己的名字。',
  baseStats: {
    maxHp: 1080, atk: 196, def: 74, spd: 108,
    critRate: 0.15, critDmg: 1.55, effectHit: 0.15, effectRes: 0.05,
    maxEnergy: 110, break: 1.05,
  },
  skills: {
    basic: 'byakuya_basic',
    skill: 'byakuya_skill',
    ultimate: 'byakuya_ult',
    talent: 'byakuya_talent',
  },
  hooks: [{ on: 'delayApplied', handler: 'byakuyaTalentHaste' }],
  /** His follow-up aims at exactly what the ultimate hit, so it reads as one attack. */
  followups: [{ on: 'allyUltimate', skill: 'byakuya_follow_bolt', chance: 1, limitPerRound: 1, targetFrom: 'casterTarget' }],
  unlock: { 1: ['byakuya_talent'] },
});

// ---------------------------------------------------------------------------
// 5. 艾莉丝 Elise
// ---------------------------------------------------------------------------
defineCharacter({
  id: 'elise',
  name: '艾莉丝',
  en: 'Elise',
  title: '圣咏的守护者',
  element: 'imaginary',
  role: 'support',
  rarity: 5,
  color: '#ffd166',
  sprite: 'elise',
  lore:
    '教会的巡回医者，相信任何一种伤都能被治好，包括不流血的伤。' +
    '她的圣杖敲过人，也敲过地板，后者通常意味着有人说了不该说的话。',
  baseStats: {
    maxHp: 1260, atk: 148, def: 88, spd: 104,
    critRate: 0.05, critDmg: 1.50, effectHit: 0.05, effectRes: 0.12,
    maxEnergy: 120, break: 0.95,
  },
  skills: {
    basic: 'elise_basic',
    skill: 'elise_skill',
    ultimate: 'elise_ult',
    talent: 'elise_talent',
  },
  hooks: [{ on: 'turnStart', handler: 'eliseTalentSustain' }],
  /**
   * She heals constantly, so this fires a lot — hence the 0.6 chance and the
   * party-wide follow-up ceiling keeping it in check.
   */
  followups: [{ on: 'allyHeal', skill: 'elise_follow_choir', chance: 0.6, limitPerRound: 1, targetFrom: 'triggerTarget' }],
  unlock: { 1: ['elise_talent'] },
});

// ---------------------------------------------------------------------------
// Starter gear — enough to make the equipment system real without becoming a
// loot game. Each entry is a flat/percent stat bundle applied via `gearStats`.
// ---------------------------------------------------------------------------
const EQUIPMENT = {};

function defineEquipment(item) {
  EQUIPMENT[item.id] = { slot: 'accessory', rarity: 3, desc: '', ...item };
}

defineEquipment({ id: 'gear_wind_blade', name: '疾风短刃', slot: 'weapon', rarity: 4, atkPct: 0.18, spdPct: 0.06, desc: '攻击力 +18%，速度 +6%。' });
defineEquipment({ id: 'gear_alchemy_kit', name: '调合工具箱', slot: 'weapon', rarity: 4, atkPct: 0.20, effectHit: 0.15, desc: '攻击力 +20%，效果命中 +15%。' });
defineEquipment({ id: 'gear_frost_tome', name: '霜华法典', slot: 'weapon', rarity: 4, atkPct: 0.16, effectHit: 0.18, desc: '攻击力 +16%，效果命中 +18%。' });
defineEquipment({ id: 'gear_thunder_lance', name: '雷贯长枪', slot: 'weapon', rarity: 4, atkPct: 0.22, critRate: 0.08, desc: '攻击力 +22%，暴击率 +8%。' });
defineEquipment({ id: 'gear_holy_staff', name: '圣咏之杖', slot: 'weapon', rarity: 4, atkPct: 0.15, maxHpPct: 0.12, desc: '攻击力 +15%，最大生命 +12%。' });

defineEquipment({ id: 'gear_swift_boots', name: '疾行靴', slot: 'boots', rarity: 3, spd: 12, desc: '速度 +12。' });
defineEquipment({ id: 'gear_guard_ring', name: '守护指环', slot: 'accessory', rarity: 3, def: 30, effectRes: 0.10, desc: '防御 +30，效果抵抗 +10%。' });
defineEquipment({ id: 'gear_crit_lens', name: '洞察透镜', slot: 'accessory', rarity: 4, critRate: 0.10, critDmg: 0.20, desc: '暴击率 +10%，暴击伤害 +20%。' });
defineEquipment({ id: 'gear_break_gauntlet', name: '碎韧护手', slot: 'accessory', rarity: 4, break: 0.35, desc: '削韧效率 +35%。' });
defineEquipment({ id: 'gear_energy_core', name: '充能核心', slot: 'accessory', rarity: 4, maxEnergy: 20, desc: '最大能量 +20。' });
defineEquipment({ id: 'gear_vital_pendant', name: '生命吊坠', slot: 'accessory', rarity: 3, maxHpPct: 0.20, desc: '最大生命 +20%。' });

/** The loadout the demo hands the player at the start. */
const DEFAULT_LOADOUT = {
  ayaha: { weapon: 'gear_wind_blade', boots: 'gear_swift_boots', accessory: 'gear_break_gauntlet' },
  rinne: { weapon: 'gear_alchemy_kit', boots: null, accessory: 'gear_crit_lens' },
  rin: { weapon: 'gear_frost_tome', boots: null, accessory: 'gear_guard_ring' },
  byakuya: { weapon: 'gear_thunder_lance', boots: 'gear_swift_boots', accessory: 'gear_energy_core' },
  elise: { weapon: 'gear_holy_staff', boots: null, accessory: 'gear_vital_pendant' },
};

function getCharacter(id) {
  const c = CHARACTERS[id];
  if (!c) throw new Error(`Unknown character id: ${id}`);
  return c;
}

function getEquipment(id) {
  return EQUIPMENT[id] || null;
}

function listCharacters() {
  return Object.keys(CHARACTERS).map((id) => CHARACTERS[id]);
}

module.exports = {
  CHARACTERS,
  EQUIPMENT,
  DEFAULT_LOADOUT,
  getCharacter,
  getEquipment,
  listCharacters,
  defineCharacter,
  defineEquipment,
};
