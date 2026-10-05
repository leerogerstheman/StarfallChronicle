'use strict';

/**
 * Skill definitions and the registry that validates them.
 *
 * A skill is pure data. The engine's `effect` list is executed top to bottom by
 * `src/battle/resolve.js`, so the ordering of effects is part of the design:
 * "buff self, then hit" is a different skill from "hit, then buff self" only
 * because the damage snapshot differs.
 *
 * Effect vocabulary (each is one entry in `skill.effects`):
 *
 *   { type: 'damage',     multiplier, target?, hits?, element?, toughness?, flatBonus?, ratio? }
 *   { type: 'heal',       ratio?, flat?, mode?: 'ratio'|'maxHp'|'flat', target? }
 *   { type: 'shield',     ratio, duration?, target? }
 *   { type: 'status',     status, duration?, chance?, target?, stacks? }
 *   { type: 'cleanse',    target? }
 *   { type: 'dispel',     target? }
 *   { type: 'energy',     amount, target? }        // target defaults to self
 *   { type: 'skillPoint', amount }
 *   { type: 'delay',      amount, target? }        // push target's action value back
 *   { type: 'advance',    amount, target? }        // pull target's action value forward
 *   { type: 'extraTurn',  target?, count? }
 *   { type: 'revive',     hpRatio, target? }
 *   { type: 'summon',     enemy, count?, positions? }
 *   { type: 'reviveAllAllies', hpRatio }
 *   { type: 'detonate',   status, ratio }          // Atelier item detonation
 *   { type: 'toughness',  amount, target? }        // direct toughness damage
 *   { type: 'breakInstantly', target? }
 *   { type: 'consumeStatus', status, perStack: {...} }  // spend a resource for power
 *   { type: 'script',     handler }                // named handler in battle/scripts.js
 *
 * `target` selectors, resolved by the engine against the skill's chosen target:
 *   'primary'  the unit the player selected
 *   'self'     the caster
 *   'allEnemies' / 'allAllies' / 'randomEnemy' / 'lowestHpAlly' / 'blasts'
 *   'allEnemiesExceptPrimary' / 'marked' (units carrying a given status)
 */

const { getStatus } = require('./status');

/**
 * All skills in the demo, keyed by id. Characters reference these; nothing here
 * references a character, so a skill can be shared or remixed freely.
 *
 * Naming: `<owner>_<slot>`. Slots are `basic`, `skill`, `ult`, `talent`,
 * `technique`, plus `extra_*` for summoned/boss-only actions.
 */
const SKILLS = {};

/** Register a skill, applying defaults and validating references. */
function define(skill) {
  const full = {
    // Targeting defaults
    target: 'single',
    // Damage defaults
    multiplier: 0,
    toughness: 30,
    element: 'physical',
    hits: 1,
    // Resource defaults
    skillPointCost: 0,
    energyGain: 0,
    // Presentation
    icon: '✦',
    kind: 'skill',
    desc: '',
    ...skill,
    effects: (skill.effects || []).map((e) => ({ ...e })),
  };
  if (SKILLS[full.id]) throw new Error(`Duplicate skill id: ${full.id}`);
  SKILLS[full.id] = full;
  return full;
}

// ===========================================================================
// 共通 / Shared
// ===========================================================================

define({
  id: 'common_basic_physical',
  name: '普通攻击',
  icon: '⚔',
  kind: 'basic',
  element: 'physical',
  target: 'single',
  toughness: 30,
  skillPointCost: 0,
  energyGain: 20,
  desc: '造成 100% 攻击力的物理伤害，回复 1 点战技点。',
  effects: [
    { type: 'damage', multiplier: 1.0 },
    { type: 'skillPoint', amount: 1 },
  ],
});

// ===========================================================================
// 1. 苍叶 Ayaha — 风属性剑士 / 击破手
//    原型：《伊苏》亚特鲁式高速连击 + 《轨迹》的延迟推条
// ===========================================================================

define({
  id: 'ayaha_basic',
  name: '疾风斩',
  icon: '🌪',
  kind: 'basic',
  element: 'wind',
  target: 'single',
  toughness: 30,
  energyGain: 20,
  desc: '对单体造成 110% 攻击力的风属性伤害，并回复 1 点战技点。',
  effects: [
    { type: 'damage', multiplier: 1.10, element: 'wind' },
    { type: 'skillPoint', amount: 1 },
  ],
});

define({
  id: 'ayaha_skill',
  name: '烈风连斩',
  icon: '🗡',
  kind: 'skill',
  element: 'wind',
  target: 'single',
  toughness: 60,
  skillPointCost: 1,
  energyGain: 30,
  cooldown: 0,
  desc: '连续三段斩击，合计 210% 攻击力的风属性伤害，并削减大量韧性。全体队友速度 +15%（2 回合）。',
  effects: [
    { type: 'damage', multiplier: 0.70, hits: 3, element: 'wind', toughness: 20 },
    { type: 'status', status: 'spd_up', duration: 2, target: 'allAllies', chance: 1.0, aura: 'spd_up_weaker' },
  ],
});

define({
  id: 'ayaha_ult',
  name: '苍岚·断空',
  icon: '🌀',
  kind: 'ultimate',
  element: 'wind',
  target: 'blast',
  toughness: 120,
  energyGain: 0,
  desc: '终结技：对主目标造成 320% 攻击力的风属性伤害，并对相邻目标造成 160%。必定削减 120 点韧性，若击破则额外推条。',
  effects: [
    { type: 'damage', multiplier: 3.20, element: 'wind', toughness: 120 },
    { type: 'damage', multiplier: 1.60, element: 'wind', toughness: 60, target: 'allEnemiesExceptPrimary' },
    { type: 'script', handler: 'ultBreakDelay' },
  ],
});

define({
  id: 'ayaha_talent',
  name: '天赋·追风',
  icon: '💨',
  kind: 'talent',
  target: 'self',
  desc: '天赋：每次击破敌人韧性时，自身行动提前 20%，并获得 1 层「战意高昂」。',
  effects: [],
  // Talent hooks are declared, not executed as effects.
  hooks: [
    { on: 'break', handler: 'ayahaTalentBreak' },
  ],
});

define({
  id: 'ayaha_technique',
  name: '秘技·先手',
  icon: '⚡',
  kind: 'technique',
  target: 'single',
  desc: '秘技：进入战斗时，立刻对随机敌人发动一次 80% 攻击力的风属性攻击并削减韧性。',
  effects: [
    { type: 'damage', multiplier: 0.80, element: 'wind', target: 'randomEnemy', toughness: 40 },
  ],
});

// ===========================================================================
// 2. 御巫铃 Rinné — 火属性炼金术士 / 道具与 Debuff
//    原型：《炼金工房》道具调合 + 《女神异闻录》状态异常
// ===========================================================================

define({
  id: 'rinne_basic',
  name: '烧瓶投掷',
  icon: '🧪',
  kind: 'basic',
  element: 'fire',
  target: 'single',
  toughness: 30,
  energyGain: 20,
  desc: '投掷烧瓶造成 100% 攻击力的火属性伤害，回复 1 点战技点。',
  effects: [
    { type: 'damage', multiplier: 1.00, element: 'fire' },
    { type: 'skillPoint', amount: 1 },
  ],
});

define({
  id: 'rinne_skill',
  name: '冰晶炸弹',
  icon: '❄',
  kind: 'skill',
  element: 'ice',
  target: 'single',
  toughness: 60,
  skillPointCost: 1,
  energyGain: 30,
  desc: '投掷冰晶炸弹造成 170% 攻击力的冰属性伤害，60% 基础概率使目标冻结 1 回合。',
  effects: [
    { type: 'damage', multiplier: 1.70, element: 'ice' },
    { type: 'status', status: 'freeze', duration: 1, chance: 0.60 },
  ],
});

define({
  id: 'rinne_ult',
  name: '贤者之石·爆裂',
  icon: '⚗',
  kind: 'ultimate',
  element: 'fire',
  target: 'aoe',
  toughness: 90,
  desc: '终结技：引爆贤者之石，对全体敌人造成 220% 攻击力的火属性伤害，并附加 2 层「灼烧」与「炼金印记」。',
  effects: [
    { type: 'damage', multiplier: 2.20, element: 'fire', toughness: 90 },
    { type: 'status', status: 'burn', stacks: 2, duration: 3, chance: 1.0 },
    { type: 'status', status: 'brand', stacks: 2, duration: 3, chance: 1.0 },
  ],
});

define({
  id: 'rinne_talent',
  name: '天赋·调合',
  icon: '🔬',
  kind: 'talent',
  target: 'self',
  desc: '天赋：对带有「炼金印记」的敌人造成伤害时引爆印记，追加 45% 攻击力的火属性伤害并削减韧性。',
  effects: [],
  hooks: [{ on: 'damageDealt', handler: 'rinneTalentDetonate' }],
});

// ===========================================================================
// 3. 神代凛 Rin — 冰属性术士 / 群体控制
//    原型：《轨迹》导力魔法 + 冻结控制
// ===========================================================================

define({
  id: 'rin_basic',
  name: '霜之矢',
  icon: '❄',
  kind: 'basic',
  element: 'ice',
  target: 'single',
  toughness: 30,
  energyGain: 20,
  desc: '射出霜之矢造成 100% 攻击力的冰属性伤害，回复 1 点战技点。',
  effects: [
    { type: 'damage', multiplier: 1.00, element: 'ice' },
    { type: 'skillPoint', amount: 1 },
  ],
});

define({
  id: 'rin_skill',
  name: '冰晶风暴',
  icon: '🌨',
  kind: 'skill',
  element: 'ice',
  target: 'aoe',
  toughness: 60,
  skillPointCost: 1,
  energyGain: 30,
  desc: '召唤冰晶风暴，对全体敌人造成 130% 攻击力的冰属性伤害，并使其速度 -20%（2 回合）。',
  effects: [
    { type: 'damage', multiplier: 1.30, element: 'ice', toughness: 60 },
    { type: 'status', status: 'spd_down', duration: 2, chance: 0.85 },
  ],
});

define({
  id: 'rin_ult',
  name: '绝对零度',
  icon: '🧊',
  kind: 'ultimate',
  element: 'ice',
  target: 'aoe',
  toughness: 100,
  desc: '终结技：全场冻结。对全体敌人造成 240% 攻击力的冰属性伤害，必定冻结 1 回合；对已被冻结的目标伤害提升 50%。',
  effects: [
    { type: 'damage', multiplier: 2.40, element: 'ice', toughness: 100, bonusVsStatus: { status: 'freeze', mult: 1.5 } },
    { type: 'status', status: 'freeze', duration: 1, chance: 1.0, target: 'allEnemiesExceptPrimary' },
    { type: 'status', status: 'freeze', duration: 1, chance: 0.8 },
  ],
});

define({
  id: 'rin_talent',
  name: '天赋·霜华',
  icon: '✨',
  kind: 'talent',
  target: 'self',
  desc: '天赋：敌方目标被冻结时，自身获得 15 点能量；攻击冻结目标时暴击率 +20%。',
  effects: [],
  hooks: [{ on: 'statusApplied', handler: 'rinTalentFreeze' }],
});

// ===========================================================================
// 4. 白鸦 Byakuya — 雷属性枪兵 / 速度与推条
//    原型：《轨迹》的延迟/加速 + 《伊苏》的闪避反击
// ===========================================================================

define({
  id: 'byakuya_basic',
  name: '雷光突刺',
  icon: '⚡',
  kind: 'basic',
  element: 'lightning',
  target: 'single',
  toughness: 30,
  energyGain: 20,
  desc: '一记雷光突刺，造成 100% 攻击力的雷属性伤害，回复 1 点战技点。',
  effects: [
    { type: 'damage', multiplier: 1.00, element: 'lightning' },
    { type: 'skillPoint', amount: 1 },
  ],
});

define({
  id: 'byakuya_skill',
  name: '雷鸣突进',
  icon: '🗲',
  kind: 'skill',
  element: 'lightning',
  target: 'single',
  toughness: 60,
  skillPointCost: 1,
  energyGain: 30,
  desc: '突进造成 185% 攻击力的雷属性伤害，并使目标行动延迟 25%。自身行动提前 15%。',
  effects: [
    { type: 'damage', multiplier: 1.85, element: 'lightning' },
    { type: 'delay', amount: 0.25 },
    { type: 'advance', amount: 0.15, target: 'self' },
  ],
});

define({
  id: 'byakuya_ult',
  name: '千雷·贯日',
  icon: '🌩',
  kind: 'ultimate',
  element: 'lightning',
  target: 'single',
  toughness: 150,
  desc: '终结技：贯穿一击，造成 420% 攻击力的雷属性伤害。目标每有一层减益，伤害提升 12%（最多 60%），并使其行动延迟 40%。',
  effects: [
    { type: 'script', handler: 'byakuyaUltScaling' },
    { type: 'damage', multiplier: 4.20, element: 'lightning', toughness: 150 },
    { type: 'delay', amount: 0.40 },
  ],
});

define({
  id: 'byakuya_talent',
  name: '天赋·疾影',
  icon: '💫',
  kind: 'talent',
  target: 'self',
  desc: '天赋：每次使敌人行动延迟时，自身速度 +8%（可叠加 3 层，3 回合）。雷属性攻击对已击破目标伤害 +20%。',
  effects: [],
  hooks: [{ on: 'delayApplied', handler: 'byakuyaTalentHaste' }],
});

// ===========================================================================
// 5. 艾莉丝 Elise — 治疗 / 增益 / 护盾
//    原型：《轨迹》的辅助魔法 + 《炼金工房》的回复道具
// ===========================================================================

define({
  id: 'elise_basic',
  name: '圣杖打击',
  icon: '🔨',
  kind: 'basic',
  element: 'physical',
  target: 'single',
  toughness: 30,
  energyGain: 20,
  desc: '以圣杖敲击造成 90% 攻击力的物理伤害，回复 1 点战技点。',
  effects: [
    { type: 'damage', multiplier: 0.90 },
    { type: 'skillPoint', amount: 1 },
  ],
});

define({
  id: 'elise_skill',
  name: '治愈之光',
  icon: '💚',
  kind: 'skill',
  element: 'imaginary',
  target: 'ally',
  toughness: 0,
  skillPointCost: 1,
  energyGain: 30,
  desc: '为我方单体回复相当于施术者 130% 攻击力 + 目标 8% 最大生命的生命，并附加持续回复（3 回合）。',
  effects: [
    { type: 'heal', ratio: 1.30, mode: 'ratio' },
    { type: 'heal', ratio: 0.08, mode: 'maxHp' },
    { type: 'status', status: 'regen', duration: 3, chance: 1.0 },
  ],
});

define({
  id: 'elise_ult',
  name: '黎明圣咏',
  icon: '🌅',
  kind: 'ultimate',
  element: 'imaginary',
  target: 'allyAll',
  desc: '终结技：为全体队友回复 90% 攻击力 + 12% 最大生命的生命，解除全部减益，并赋予 2 回合「伤害强化」与护盾。',
  effects: [
    { type: 'heal', ratio: 0.90, mode: 'ratio', target: 'allAllies' },
    { type: 'heal', ratio: 0.12, mode: 'maxHp', target: 'allAllies' },
    { type: 'cleanse', target: 'allAllies' },
    { type: 'status', status: 'damage_up', duration: 2, chance: 1.0, target: 'allAllies' },
    { type: 'shield', ratio: 1.20, duration: 3, target: 'allAllies' },
    { type: 'script', handler: 'eliseUltEnergy' },
  ],
});

define({
  id: 'elise_talent',
  name: '天赋·生命线',
  icon: '💗',
  kind: 'talent',
  target: 'self',
  desc: '天赋：队友生命低于 30% 时，其受到的伤害减少 20% 并获得「不屈」；艾莉丝自身每回合额外获得 10 点能量。',
  effects: [],
  hooks: [{ on: 'turnStart', handler: 'eliseTalentSustain' }],
});

// ===========================================================================
// 敌方技能
// ===========================================================================

define({
  id: 'enemy_claw',
  name: '利爪',
  icon: '🩸',
  kind: 'basic',
  element: 'physical',
  target: 'single',
  toughness: 0,
  desc: '对单体造成 100% 攻击力的物理伤害。',
  effects: [{ type: 'damage', multiplier: 1.00 }],
});

define({
  id: 'enemy_spit',
  name: '腐蚀吐息',
  icon: '☠',
  kind: 'skill',
  element: 'wind',
  target: 'single',
  toughness: 0,
  desc: '对单体造成 120% 攻击力的风属性伤害，并有 50% 概率使目标中毒。',
  effects: [
    { type: 'damage', multiplier: 1.20, element: 'wind' },
    { type: 'status', status: 'poison', stacks: 1, duration: 4, chance: 0.50 },
  ],
});

define({
  id: 'enemy_swarm_call',
  name: '虫群呼唤',
  icon: '🐛',
  kind: 'skill',
  target: 'self',
  desc: '召唤 2 只幼虫。',
  effects: [{ type: 'summon', enemy: 'larva', count: 2 }],
});

define({
  id: 'enemy_brute_slam',
  name: '重锤砸击',
  icon: '💥',
  kind: 'skill',
  element: 'physical',
  target: 'blast',
  toughness: 0,
  desc: '对主目标造成 180% 攻击力的物理伤害，相邻目标受到 90%。',
  effects: [
    { type: 'damage', multiplier: 1.80 },
    { type: 'damage', multiplier: 0.90, target: 'allEnemiesExceptPrimary' },
  ],
});

define({
  id: 'enemy_brute_roar',
  name: '战吼',
  icon: '📣',
  kind: 'skill',
  target: 'self',
  desc: '自身攻击力 +30%，并赋予队友 1 层狂暴。',
  effects: [
    { type: 'status', status: 'atk_up', duration: 3, chance: 1.0, target: 'self' },
    { type: 'status', status: 'enrage', stacks: 1, duration: 99, chance: 1.0, target: 'allAllies' },
  ],
});

define({
  id: 'enemy_shield_ward',
  name: '护盾展开',
  icon: '🔷',
  kind: 'skill',
  target: 'allAllies',
  desc: '为全体队友展开护盾。',
  effects: [
    { type: 'shield', ratio: 0.8, duration: 3, target: 'allAllies' },
  ],
});

define({
  id: 'enemy_stasis_bolt',
  name: '停滞电击',
  icon: '⚡',
  kind: 'skill',
  element: 'lightning',
  target: 'single',
  toughness: 0,
  desc: '造成 140% 攻击力的雷属性伤害，并使目标行动延迟。',
  effects: [
    { type: 'damage', multiplier: 1.40, element: 'lightning' },
    { type: 'delay', amount: 0.30 },
    { type: 'status', status: 'shock', stacks: 1, duration: 2, chance: 0.4 },
  ],
});

// ===========================================================================
// 精英：深渊哨兵
// ===========================================================================

define({
  id: 'sentinel_sweep',
  name: '横扫',
  icon: '🌀',
  kind: 'skill',
  element: 'physical',
  target: 'aoe',
  toughness: 0,
  desc: '对全体敌人造成 110% 攻击力的物理伤害。',
  effects: [{ type: 'damage', multiplier: 1.10 }],
});

define({
  id: 'sentinel_pierce',
  name: '贯穿突刺',
  icon: '🗡',
  kind: 'skill',
  element: 'wind',
  target: 'single',
  toughness: 0,
  desc: '对单体造成 230% 攻击力的风属性伤害，并使其防御 -30%（2 回合）。',
  effects: [
    { type: 'damage', multiplier: 2.30, element: 'wind' },
    { type: 'status', status: 'def_down', duration: 2, chance: 0.8 },
  ],
});

define({
  id: 'sentinel_barrage',
  name: '裂空弹幕',
  icon: '✳',
  kind: 'skill',
  element: 'imaginary',
  target: 'bounce',
  toughness: 0,
  desc: '对随机敌人发射 4 次弹幕，每次造成 85% 攻击力的虚数属性伤害。',
  effects: [{ type: 'damage', multiplier: 0.85, element: 'imaginary', target: 'randomEnemy', hits: 4 }],
});

define({
  id: 'sentinel_fortify',
  name: '相位壁垒',
  icon: '🛡',
  kind: 'skill',
  target: 'self',
  desc: '进入防御姿态：伤害减免 40%、韧性强化（2 回合），并清除自身减益。',
  effects: [
    { type: 'dispel', target: 'self' },
    { type: 'status', status: 'dmg_reduce', duration: 2, chance: 1.0, target: 'self' },
    { type: 'status', status: 'toughness_up', duration: 2, chance: 1.0, target: 'self' },
  ],
});

// ===========================================================================
// Boss：灰烬之王 · 瓦尔特斯
// ===========================================================================

define({
  id: 'boss_ember_slash',
  name: '灰烬斩',
  icon: '🔥',
  kind: 'basic',
  element: 'fire',
  target: 'single',
  toughness: 0,
  desc: '对单体造成 150% 攻击力的火属性伤害，并附加 1 层灼烧。',
  effects: [
    { type: 'damage', multiplier: 1.50, element: 'fire' },
    { type: 'status', status: 'burn', stacks: 1, duration: 3, chance: 0.7 },
  ],
});

define({
  id: 'boss_cinder_nova',
  name: '烬灭新星',
  icon: '☄',
  kind: 'ultimate',
  element: 'fire',
  target: 'aoe',
  toughness: 0,
  desc: '全屏爆发，对全体敌人造成 260% 攻击力的火属性伤害，并对每人叠加 1 层灼烧。每层「劫火印记」使伤害提升 15%。',
  effects: [
    { type: 'script', handler: 'bossNovaScaling' },
    { type: 'damage', multiplier: 2.60, element: 'fire' },
    { type: 'status', status: 'burn', stacks: 1, duration: 3, chance: 1.0 },
    { type: 'status', status: 'doom', stacks: -99, chance: 1.0, target: 'self' },
  ],
});

define({
  id: 'boss_mark_of_doom',
  name: '劫火印记',
  icon: '🎯',
  kind: 'skill',
  target: 'self',
  toughness: 0,
  desc: '为自身叠加 2 层「劫火印记」，并回复 6% 最大生命。印记会强化「烬灭新星」。',
  /**
   * The heal is deliberately unbounded here and bounded *by the AI instead*
   * (`boss.ai.skillCooldowns`), because a cooldown is an encounter-design knob:
   * a designer retuning the fight should not have to edit a shared skill, and a
   * second boss that also marks itself may want a different rhythm.
   *
   * This distinction mattered: with no cooldown the boss cast this 43 times in
   * one fight, healing 172,525 HP against 172,659 damage dealt. The party could
   * not win, and the fight timed out at 80 rounds with the boss at 99% HP. The
   * lesson is that any enemy self-heal needs a hard cadence limit — an AI that
   * can pick "heal myself" every turn will eventually do exactly that.
   */
  effects: [
    { type: 'status', status: 'doom', stacks: 2, duration: 99, chance: 1.0, target: 'self' },
    { type: 'heal', ratio: 0.06, mode: 'maxHp', target: 'self' },
  ],
});

define({
  id: 'boss_ashen_grasp',
  name: '灰烬之握',
  icon: '🖐',
  kind: 'skill',
  element: 'fire',
  target: 'single',
  toughness: 0,
  desc: '抓住单体造成 190% 攻击力的火属性伤害，并使其行动延迟 30%、攻击力 -25%（2 回合）。',
  effects: [
    { type: 'damage', multiplier: 1.90, element: 'fire' },
    { type: 'delay', amount: 0.30 },
    { type: 'status', status: 'atk_down', duration: 2, chance: 0.75 },
  ],
});

define({
  id: 'boss_summon_husks',
  name: '召唤灰烬残骸',
  icon: '💀',
  kind: 'skill',
  target: 'self',
  desc: '召唤 2 个灰烬残骸。',
  effects: [{ type: 'summon', enemy: 'ash_husk', count: 2 }],
});

define({
  id: 'boss_phase2_unleash',
  name: '崩坏·灰烬领域',
  icon: '🌋',
  kind: 'ultimate',
  target: 'self',
  toughness: 0,
  desc: '阶段转换：清除自身全部减益，攻击力 +25%、速度 +15%，并获得「狂暴」3 层。',
  effects: [
    { type: 'dispel', target: 'self' },
    { type: 'status', status: 'atk_up', duration: 99, chance: 1.0, target: 'self' },
    { type: 'status', status: 'spd_up', duration: 99, chance: 1.0, target: 'self' },
    { type: 'status', status: 'enrage', stacks: 3, duration: 99, chance: 1.0, target: 'self' },
  ],
});

define({
  id: 'boss_last_word',
  name: '遗言·终焉之焰',
  icon: '🔥',
  kind: 'ultimate',
  element: 'fire',
  target: 'aoe',
  toughness: 0,
  desc: '生命低于 20% 时释放：对全体造成 380% 攻击力的火属性伤害。',
  effects: [
    { type: 'damage', multiplier: 3.80, element: 'fire' },
    { type: 'status', status: 'burn', stacks: 2, duration: 3, chance: 1.0 },
  ],
});

// --- Boss adds -------------------------------------------------------------

define({
  id: 'husk_lunge',
  name: '残骸扑击',
  icon: '🦴',
  kind: 'basic',
  element: 'physical',
  target: 'single',
  toughness: 0,
  desc: '对单体造成 110% 攻击力的物理伤害。',
  effects: [{ type: 'damage', multiplier: 1.10 }],
});

define({
  id: 'husk_selfdestruct',
  name: '自爆',
  icon: '💣',
  kind: 'skill',
  element: 'fire',
  target: 'aoe',
  toughness: 0,
  desc: '自爆，对全体敌人造成 140% 攻击力的火属性伤害，随后自身倒下。',
  effects: [
    { type: 'damage', multiplier: 1.40, element: 'fire' },
    { type: 'script', handler: 'selfDestruct' },
  ],
});

// ===========================================================================
// Validation
// ===========================================================================

/**
 * Boot-time validation. Every skill's status references, target shapes and
 * effect types are checked once at require time. A bad data file must fail
 * loudly here rather than mid-boss-fight.
 */
const VALID_EFFECTS = [
  'damage', 'heal', 'shield', 'status', 'cleanse', 'dispel', 'energy',
  'skillPoint', 'delay', 'advance', 'extraTurn', 'revive', 'summon',
  'detonate', 'toughness', 'breakInstantly', 'consumeStatus', 'script',
];

const VALID_TARGETS = [
  'primary', 'self', 'allEnemies', 'allAllies', 'randomEnemy', 'lowestHpAlly',
  'allEnemiesExceptPrimary', 'allAlliesExceptSelf', 'marked', 'downed',
];

function validateSkill(skill) {
  const errors = [];
  for (const eff of skill.effects) {
    if (!VALID_EFFECTS.includes(eff.type)) {
      errors.push(`effect type "${eff.type}" is not recognised`);
    }
    if (eff.target && !VALID_TARGETS.includes(eff.target)) {
      errors.push(`effect target "${eff.target}" is not recognised`);
    }
    if (eff.type === 'status') {
      try {
        getStatus(eff.status);
      } catch {
        errors.push(`unknown status "${eff.status}"`);
      }
      if (eff.chance != null && (eff.chance < 0 || eff.chance > 1)) {
        errors.push(`chance ${eff.chance} out of range for status "${eff.status}"`);
      }
    }
    if (eff.type === 'detonate') {
      try {
        getStatus(eff.status);
      } catch {
        errors.push(`unknown detonate status "${eff.status}"`);
      }
    }
    if (eff.type === 'summon') {
      // Enemy ids are validated lazily to avoid a require cycle; check shape.
      if (typeof eff.enemy !== 'string') errors.push('summon requires an enemy id string');
    }
    if (eff.type === 'damage' && (eff.multiplier == null || eff.multiplier < 0)) {
      errors.push('damage effect needs a non-negative multiplier');
    }
  }
  if (skill.kind === 'ultimate' && skill.skillPointCost) {
    errors.push('ultimates must not cost skill points');
  }
  return errors;
}

function validateAll() {
  const problems = [];
  for (const id of Object.keys(SKILLS)) {
    const errs = validateSkill(SKILLS[id]);
    for (const e of errs) problems.push(`${id}: ${e}`);
  }
  return problems;
}

function getSkill(id) {
  const s = SKILLS[id];
  if (!s) throw new Error(`Unknown skill id: ${id}`);
  return s;
}

function has(id) {
  return !!SKILLS[id];
}

/** Skills for a given kind, for the in-game library screen. */
function byKind(kind) {
  return Object.values(SKILLS).filter((s) => s.kind === kind);
}

module.exports = { SKILLS, define, getSkill, has, byKind, validateAll, VALID_EFFECTS, VALID_TARGETS };
