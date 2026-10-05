'use strict';

/**
 * Status effects (buffs, debuffs, damage-over-time, control).
 *
 * Every status in the game is declared here once, as data. Skills reference a
 * status by id in their `apply` list; the engine resolves the id through this
 * registry. Nothing else needs to know how a status works.
 *
 * The hook vocabulary is deliberately small, because a large hook surface is
 * where balance bugs hide:
 *
 *   statMods(entity, status)   -> flat/percent stat changes, summed per stat
 *   onApply(ctx)               -> runs once when the status lands
 *   onTurnStart(ctx)           -> runs on the holder's turn, before its action
 *   onTurnEnd(ctx)             -> runs on the holder's turn, after its action
 *   onTakeDamage(ctx)          -> may mutate `ctx.damage`
 *   onDealDamage(ctx)          -> may mutate `ctx.damage`
 *   onExpire(ctx)              -> runs when stacks/duration hit zero
 *
 * `ctx` always carries { battle, source, target, status, log, rng }.
 *
 * Design notes per status family:
 *   - DoT damage scales off the *applier's* ATK, snapshotted at cast time, so a
 *     buff that later raises the applier's ATK does not retroactively empower a
 *     poison already ticking. This is the Trails/Persona convention and it
 *     keeps damage predictable.
 *   - Control statuses (freeze, stun, imprison) skip the holder's action
 *     entirely but still let DoT tick, so a stun into a burn is a real combo.
 *   - `stackable` decides whether re-applying refreshes duration or adds a
 *     stack; most debuffs use 'refresh' so that a boss cannot be buried in 40
 *     stacks of the same defence shred.
 */

const STATUS_CATEGORY = {
  BUFF: 'buff',
  DEBUFF: 'debuff',
  DOT: 'dot',
  HOT: 'hot',
  CONTROL: 'control',
  SPECIAL: 'special',
};

/** How re-application behaves. */
const STACK_MODE = {
  /** Keep the highest magnitude, refresh the duration. */
  REFRESH: 'refresh',
  /** Add a stack up to maxStacks; magnitude scales with stacks. */
  STACK: 'stack',
  /** Keep the strongest instance only; a weaker recast is ignored. */
  STRONGEST: 'strongest',
  /** Independent instances coexist (used by shields). */
  INSTANCE: 'instance',
};

/**
 * The registry. Keyed by id; each entry is frozen by `freezeRegistry()`.
 *
 * `statMods` values are either a number (flat addend) or `{ pct: 0.25 }`
 * (multiplicative on the final stat, summed across sources then applied once).
 */
const STATUSES = {
  // ---------------------------------------------------------------- buffs ---
  atk_up: {
    id: 'atk_up',
    name: '攻击提升',
    icon: '⬆',
    kind: STATUS_CATEGORY.BUFF,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 3,
    statMods: { atkPct: 0.25 },
    desc: '攻击力 +25%',
  },
  atk_up_self: {
    id: 'atk_up_self',
    name: '战意高昂',
    icon: '⬆',
    kind: STATUS_CATEGORY.BUFF,
    stackMode: STACK_MODE.STACK,
    maxStacks: 3,
    defaultDuration: 2,
    statMods: { atkPct: 0.15 },
    desc: '每层攻击力 +15%，最多 3 层',
  },
  def_up: {
    id: 'def_up',
    name: '防御提升',
    icon: '🛡',
    kind: STATUS_CATEGORY.BUFF,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 3,
    statMods: { defPct: 0.30 },
    desc: '防御力 +30%',
  },
  def_up_major: {
    id: 'def_up_major',
    name: '铁壁',
    icon: '🛡',
    kind: STATUS_CATEGORY.BUFF,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 2,
    statMods: { defPct: 0.60, effectRes: 0.20 },
    desc: '防御力 +60%，效果抵抗 +20%',
  },
  spd_up: {
    id: 'spd_up',
    name: '疾风',
    icon: '💨',
    kind: STATUS_CATEGORY.BUFF,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 3,
    statMods: { spdPct: 0.25 },
    desc: '速度 +25%',
  },
  crit_up: {
    id: 'crit_up',
    name: '暴击率提升',
    icon: '🎯',
    kind: STATUS_CATEGORY.BUFF,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 3,
    statMods: { critRate: 0.25 },
    desc: '暴击率 +25%',
  },
  crit_dmg_up: {
    id: 'crit_dmg_up',
    name: '暴击伤害提升',
    icon: '💥',
    kind: STATUS_CATEGORY.BUFF,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 3,
    statMods: { critDmg: 0.35 },
    desc: '暴击伤害 +35%',
  },
  damage_up: {
    id: 'damage_up',
    name: '伤害强化',
    icon: '🔺',
    kind: STATUS_CATEGORY.BUFF,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 3,
    /** Read by the damage pipeline, not the stat resolver. */
    damageDealtPct: 0.20,
    desc: '造成的伤害 +20%',
  },
  weakness_damage_up: {
    id: 'weakness_damage_up',
    name: '破绽洞察',
    icon: '👁',
    kind: STATUS_CATEGORY.BUFF,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 2,
    /** Only applies against broken targets. */
    vsBrokenDamagePct: 0.35,
    desc: '对已击破目标造成的伤害 +35%',
  },
  shield: {
    id: 'shield',
    name: '护盾',
    icon: '🔷',
    kind: STATUS_CATEGORY.BUFF,
    stackMode: STACK_MODE.INSTANCE,
    maxStacks: 3,
    defaultDuration: 3,
    /** Shield absorbs damage before HP; value is in HP points. */
    shield: true,
    desc: '吸收伤害的护盾',
  },
  regen: {
    id: 'regen',
    name: '持续回复',
    icon: '💚',
    kind: STATUS_CATEGORY.HOT,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 3,
    /** Heals a fraction of the target's max HP when its turn starts. */
    healPct: 0.08,
    desc: '每回合回复 8% 最大生命',
  },
  dmg_reduce: {
    id: 'dmg_reduce',
    name: '伤害减免',
    icon: '🛡',
    kind: STATUS_CATEGORY.BUFF,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 2,
    damageTakenPct: -0.40,
    desc: '受到的伤害 -40%',
  },
  counter: {
    id: 'counter',
    name: '反击',
    icon: '↩',
    kind: STATUS_CATEGORY.BUFF,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 2,
    /** Engine reads this after an incoming single-target attack resolves. */
    counterRatio: 0.8,
    desc: '受到单体攻击时反击 80% 攻击力',
  },
  taunt: {
    id: 'taunt',
    name: '嘲讽',
    icon: '🎯',
    kind: STATUS_CATEGORY.SPECIAL,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 2,
    /** Enemy AI must target this unit with single-target attacks. */
    forcesAggro: true,
    desc: '强制敌人以自身为目标',
  },
  stealth: {
    id: 'stealth',
    name: '隐匿',
    icon: '👻',
    kind: STATUS_CATEGORY.SPECIAL,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 1,
    /** Cannot be selected by enemy single-target skills. */
    untargetable: true,
    desc: '不会被单体技能选中',
  },
  followup_ready: {
    id: 'followup_ready',
    name: '追击准备',
    icon: '⚡',
    kind: STATUS_CATEGORY.SPECIAL,
    stackMode: STACK_MODE.STACK,
    maxStacks: 2,
    defaultDuration: 3,
    desc: '下次队友攻击后追加一次攻击（每层一次）',
  },
  ult_charge: {
    id: 'ult_charge',
    name: '充能',
    icon: '🔋',
    kind: STATUS_CATEGORY.SPECIAL,
    stackMode: STACK_MODE.STACK,
    maxStacks: 3,
    defaultDuration: 2,
    /** Extra energy granted to whoever holds it when it ticks. */
    energyPerStack: 10,
    desc: '每层在回合开始时额外获得能量',
  },
  vulnerability: {
    id: 'vulnerability',
    name: '破防',
    icon: '💢',
    kind: STATUS_CATEGORY.DEBUFF,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 2,
    statMods: { defPct: -0.30 },
    desc: '防御力 -30%',
  },

  // -------------------------------------------------------------- debuffs ---
  def_down: {
    id: 'def_down',
    name: '防御下降',
    icon: '🔻',
    kind: STATUS_CATEGORY.DEBUFF,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 3,
    statMods: { defPct: -0.25 },
    desc: '防御力 -25%',
  },
  atk_down: {
    id: 'atk_down',
    name: '攻击下降',
    icon: '🔽',
    kind: STATUS_CATEGORY.DEBUFF,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 3,
    statMods: { atkPct: -0.25 },
    desc: '攻击力 -25%',
  },
  spd_down: {
    id: 'spd_down',
    name: '迟缓',
    icon: '🐌',
    kind: STATUS_CATEGORY.DEBUFF,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 2,
    statMods: { spdPct: -0.25 },
    desc: '速度 -25%',
  },
  action_delay: {
    id: 'action_delay',
    name: '行动延迟',
    icon: '⏳',
    kind: STATUS_CATEGORY.DEBUFF,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 1,
    /** Pushed back on apply; the status itself is a marker for the UI. */
    delayOnApply: 2000,
    desc: '立即被推条，行动顺序后退',
  },
  damage_taken_up: {
    id: 'damage_taken_up',
    name: '受伤加重',
    icon: '🩸',
    kind: STATUS_CATEGORY.DEBUFF,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 2,
    damageTakenPct: 0.25,
    desc: '受到的伤害 +25%',
  },
  burn: {
    id: 'burn',
    name: '灼烧',
    icon: '🔥',
    kind: STATUS_CATEGORY.DOT,
    element: 'fire',
    stackMode: STACK_MODE.STACK,
    maxStacks: 5,
    defaultDuration: 2,
    /** Multiplier on the applier's snapshotted ATK, per stack, per tick. */
    dotRatio: 0.28,
    desc: '每回合受到火属性持续伤害，最多 5 层',
  },
  bleed: {
    id: 'bleed',
    name: '流血',
    icon: '🩸',
    kind: STATUS_CATEGORY.DOT,
    element: 'physical',
    stackMode: STACK_MODE.STACK,
    maxStacks: 5,
    defaultDuration: 3,
    dotRatio: 0.22,
    desc: '每回合受到物理持续伤害，最多 5 层',
  },
  poison: {
    id: 'poison',
    name: '中毒',
    icon: '☠',
    kind: STATUS_CATEGORY.DOT,
    element: 'wind',
    stackMode: STACK_MODE.STACK,
    maxStacks: 5,
    defaultDuration: 4,
    /** Poison scales with the *target's* max HP, so it works on bosses. */
    dotRatioMaxHp: 0.035,
    desc: '每回合受到相当于自身最大生命 3.5% 的持续伤害，最多 5 层',
  },
  shock: {
    id: 'shock',
    name: '感电',
    icon: '⚡',
    kind: STATUS_CATEGORY.DOT,
    element: 'lightning',
    stackMode: STACK_MODE.STACK,
    maxStacks: 3,
    defaultDuration: 2,
    dotRatio: 0.32,
    /** Shock also delays: the paralysis flavour from Trails' thunder arts. */
    delayOnTick: 300,
    desc: '每回合受到雷属性持续伤害并被轻微推条',
  },
  freeze: {
    id: 'freeze',
    name: '冻结',
    icon: '🧊',
    kind: STATUS_CATEGORY.CONTROL,
    element: 'ice',
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 1,
    /** Skips the action; DoTs still tick. */
    skipsTurn: true,
    /** Frozen units take more damage from the next hit. */
    damageTakenPct: 0.15,
    /** Broken at the end of the skipped turn. */
    desc: '无法行动，受到的伤害 +15%',
  },
  stun: {
    id: 'stun',
    name: '眩晕',
    icon: '💫',
    kind: STATUS_CATEGORY.CONTROL,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 1,
    skipsTurn: true,
    desc: '无法行动',
  },
  imprison: {
    id: 'imprison',
    name: '禁锢',
    icon: '🔗',
    kind: STATUS_CATEGORY.CONTROL,
    element: 'imaginary',
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 1,
    skipsTurn: true,
    statMods: { spdPct: -0.30 },
    desc: '无法行动，行动后速度 -30%',
  },
  silence: {
    id: 'silence',
    name: '封印',
    icon: '🚫',
    kind: STATUS_CATEGORY.CONTROL,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 1,
    /** Blocks skills and ultimates, but not basic attacks. */
    blocksSkill: true,
    blocksUltimate: true,
    desc: '无法使用战技与终结技',
  },
  confusion: {
    id: 'confusion',
    name: '混乱',
    icon: '🌀',
    kind: STATUS_CATEGORY.CONTROL,
    element: 'quantum',
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 1,
    /** 50% chance to hit itself with a basic attack. */
    confuseChance: 0.5,
    desc: '有 50% 概率攻击自己',
  },
  mark: {
    id: 'mark',
    name: '狩猎标记',
    icon: '🎯',
    kind: STATUS_CATEGORY.DEBUFF,
    stackMode: STACK_MODE.STACK,
    maxStacks: 3,
    defaultDuration: 3,
    /** Every hit against a marked target grants the attacker energy. */
    energyOnHit: 5,
    desc: '被标记；对其攻击的队友额外获得能量',
  },
  doom: {
    id: 'doom',
    name: '劫火印记',
    icon: '☄',
    kind: STATUS_CATEGORY.SPECIAL,
    stackMode: STACK_MODE.STACK,
    maxStacks: 5,
    defaultDuration: 99,
    desc: 'Boss 机制层数：每层强化 Boss 的终结技',
  },
  enrage: {
    id: 'enrage',
    name: '狂暴',
    icon: '😡',
    kind: STATUS_CATEGORY.BUFF,
    stackMode: STACK_MODE.STACK,
    maxStacks: 5,
    defaultDuration: 99,
    statMods: { atkPct: 0.10, spdPct: 0.05 },
    desc: '每层攻击力 +10%、速度 +5%',
  },
  focus: {
    id: 'focus',
    name: '集中',
    icon: '🎯',
    kind: STATUS_CATEGORY.BUFF,
    stackMode: STACK_MODE.STACK,
    maxStacks: 3,
    defaultDuration: 3,
    desc: 'Boss 蓄力层数',
  },
  toughness_up: {
    id: 'toughness_up',
    name: '韧性强化',
    icon: '🟨',
    kind: STATUS_CATEGORY.BUFF,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 3,
    /** Multiplies toughness damage taken; < 1 means harder to break. */
    toughnessTakenMult: 0.5,
    desc: '韧性受到的削减 -50%',
  },
  weak_point: {
    id: 'weak_point',
    name: '弱点暴露',
    icon: '🟡',
    kind: STATUS_CATEGORY.DEBUFF,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 2,
    /** Multiplies toughness damage taken; > 1 means easier to break. */
    toughnessTakenMult: 1.6,
    desc: '韧性受到的削减 +60%',
  },
  brand: {
    id: 'brand',
    name: '炼金印记',
    icon: '⚗',
    kind: STATUS_CATEGORY.DEBUFF,
    stackMode: STACK_MODE.STACK,
    maxStacks: 3,
    defaultDuration: 3,
    /** Atelier-flavoured: marked targets detonate when hit by an item skill. */
    detonateRatio: 0.45,
    element: 'fire',
    desc: '每层被道具技能命中时引爆，受到额外火属性伤害',
  },
  link: {
    id: 'link',
    name: '战术链接',
    icon: '🔗',
    kind: STATUS_CATEGORY.SPECIAL,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 2,
    /** Trails-flavoured: allied hits on the linked target grant extra break. */
    extraToughness: 15,
    desc: '队友攻击此目标时额外削减韧性',
  },
  brave_order: {
    id: 'brave_order',
    name: '勇气指令',
    icon: '📣',
    kind: STATUS_CATEGORY.BUFF,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 3,
    statMods: { atkPct: 0.30, defPct: 0.30 },
    energyOnTurnStart: 15,
    desc: '攻击与防御 +30%，每回合额外获得能量',
  },

  // ----------------------------------------------------------- specials ---
  undying: {
    id: 'undying',
    name: '不屈',
    icon: '💗',
    kind: STATUS_CATEGORY.SPECIAL,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 2,
    /** Cannot drop below 1 HP while this holds. */
    surviveLethal: true,
    desc: '受到致命伤害时保留 1 点生命',
  },
  revive_ready: {
    id: 'revive_ready',
    name: '复苏准备',
    icon: '✨',
    kind: STATUS_CATEGORY.SPECIAL,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 3,
    /** Automatically revives at this fraction of max HP when killed. */
    autoRevivePct: 0.5,
    desc: '倒下时自动以 50% 生命复活',
  },
  reflect: {
    id: 'reflect',
    name: '反射',
    icon: '🪞',
    kind: STATUS_CATEGORY.BUFF,
    stackMode: STACK_MODE.REFRESH,
    maxStacks: 1,
    defaultDuration: 2,
    /** Returns a fraction of damage taken to the attacker. */
    reflectRatio: 0.35,
    desc: '将受到伤害的 35% 反射给攻击者',
  },
};

const STATUS_IDS = Object.keys(STATUSES);

/**
 * Resolve a status definition, throwing on an unknown id.
 *
 * Failing loudly here is intentional: a skill that references `atk_u` instead
 * of `atk_up` should break the self-test at boot, not silently no-op in front
 * of a player.
 */
function getStatus(id) {
  const def = STATUSES[id];
  if (!def) throw new Error(`Unknown status id: ${id}`);
  return def;
}

/** True when the status definition declares any stat modifiers. */
function hasStatMods(def) {
  return !!def.statMods && Object.keys(def.statMods).length > 0;
}

/** All statuses of a given kind, for UI legend generation. */
function byKind(kind) {
  return STATUS_IDS.map((id) => STATUSES[id]).filter((s) => s.kind === kind);
}

module.exports = {
  STATUSES,
  STATUS_IDS,
  STATUS_CATEGORY,
  STACK_MODE,
  getStatus,
  hasStatMods,
  byKind,
};
