'use strict';

/**
 * The rules layer: every tunable number in the game lives here.
 *
 * Two audiences read this file. Designers change `BALANCE` to retune the whole
 * game without touching engine code; programmers read `ELEMENTS` and
 * `STAT_KEYS` to know the vocabulary the engine speaks.
 *
 * Nothing in here may import from `src/battle/` — data flows one way, from
 * rules to engine, so a balance change can never accidentally depend on
 * runtime state.
 */

/**
 * Elements. The icon is a plain Unicode glyph so the demo has no font files to
 * ship; a real project would swap these for a sprite atlas.
 *
 * `Physical` is deliberately first: it is the default for basic attacks and the
 * only element that never has a "resist" flavour, which keeps early enemies
 * readable.
 */
const ELEMENTS = {
  physical: { id: 'physical', name: '物理', en: 'Physical', icon: '⚔', color: '#c9d1d9' },
  fire: { id: 'fire', name: '火', en: 'Fire', icon: '🔥', color: '#ff6b4a' },
  ice: { id: 'ice', name: '冰', en: 'Ice', icon: '❄', color: '#63d4ff' },
  lightning: { id: 'lightning', name: '雷', en: 'Lightning', icon: '⚡', color: '#c77dff' },
  wind: { id: 'wind', name: '风', en: 'Wind', icon: '🌪', color: '#5ee6a8' },
  quantum: { id: 'quantum', name: '量子', en: 'Quantum', icon: '◈', color: '#8b7cf6' },
  imaginary: { id: 'imaginary', name: '虚数', en: 'Imaginary', icon: '✦', color: '#ffd166' },
};

const ELEMENT_IDS = Object.keys(ELEMENTS);

/**
 * Character stats. Keeping the list explicit (rather than "whatever the JSON
 * happens to contain") means a typo in a data file shows up as a validation
 * error instead of a silently ignored field.
 */
const STAT_KEYS = [
  'hp',        // current hit points
  'maxHp',
  'atk',       // drives damage
  'def',       // reduces incoming damage
  'spd',       // drives how fast the action gauge fills
  'break',     // flat multiplier on toughness damage dealt
  'critRate',  // 0..1, clamped at runtime
  'critDmg',   // multiplier applied on a crit, e.g. 1.5 = +50%
  'effectHit', // 0..1 chance to land a debuff
  'effectRes', // 0..1 chance to shrug one off
  'energy',    // current ultimate charge
  'maxEnergy', // charge needed to cast the ultimate
];

/** Stats that are computed from components (base + level + gear). */
const DERIVED_STATS = ['maxHp', 'atk', 'def', 'spd', 'break', 'critRate', 'critDmg', 'effectHit', 'effectRes', 'maxEnergy'];

/**
 * The whole game's tuning constants.
 *
 * Damage model, in words:
 *   1. Start from the attacker's ATK times the skill's multiplier.
 *   2. Scale by a level ratio so that a level-1 character hitting a level-20
 *      boss does not delete it, and a level-30 character does not one-shot
 *      trash. The exponent (< 1) makes level differences matter but not dominate.
 *   3. Subtract a defence factor. Uses the common `def / (def + K)` shape: it
 *      never reaches zero, so stacking DEF always helps a little but never
 *      makes a unit immortal.
 *   4. Apply element multiplier (weakness = 1.0 through the break system
 *      instead, resist = 0.5, immune = 0, absorb = heal).
 *   5. Apply the attacker's damage buffs and the target's damage-taken debuffs.
 *   6. Roll crit and variance last, because those are the only two steps that
 *      consume randomness and doing them last keeps the RNG draw order stable
 *      when other numbers change.
 */
const BALANCE = {
  // --- Action order (Star Rail style) ---
  /**
   * Distance on the action gauge. A unit's speed is "gauge units per 100
   * action-value"; a unit acts when its accumulated action value reaches
   * ACTION_VALUE. Higher ACTION_VALUE + higher speed = more turns.
   */
  ACTION_VALUE: 10000,
  /** How far ahead the order preview looks, in "turns of the fastest unit". */
  TIMELINE_PREVIEW: 12,
  /** A unit's action value can never be pushed past this (prevents lock-out). */
  MIN_ACTION_VALUE: 5000,
  MAX_ACTION_VALUE: 40000,

  // --- Damage ---
  /** Level scaling: `1 + (atkLv - defLv) * LEVEL_STEP`, clamped to the band. */
  LEVEL_STEP: 0.02,
  LEVEL_BAND: [0.5, 2.0],
  /**
   * Defence constant; larger = DEF matters less.
   *
   * Tuned so that at the demo's encounter levels a defence-relevant hit removes
   * roughly 40–55% of incoming damage. Raising this makes fights faster across
   * the board (good) but flattens the value of DEF gear (bad), so it is the
   * second knob to reach for — prefer tuning an enemy's HP first.
   *
   * History: at 200 the boss fight ran 62 rounds because a level-22 boss's 244
   * DEF cut party damage to ~40% while the boss's own raw ATK was unaffected.
   */
  DEF_CONST: 400,
  /** Element multiplier when the target resists. */
  RESIST_MULT: 0.5,
  /** Extra damage the attacker deals to a broken (toughness-broken) target. */
  BROKEN_TAKEN_BONUS: 0.10,
  /** Damage variance per hit, ±8%. */
  DAMAGE_VARIANCE: 0.08,
  /** Damage floor, so a weak hit still reads as a number instead of 0. */
  MIN_DAMAGE: 1,

  // --- Toughness / weakness break ---
  /** Base toughness damage of a basic attack. */
  TOUGHNESS_BASIC: 30,
  /** A weakness-matched hit multiplies toughness damage by this. */
  WEAKNESS_TOUGHNESS_MULT: 1,
  /** A non-matched hit still chips toughness, at this rate. */
  OFF_ELEMENT_TOUGHNESS_MULT: 0.5,
  /**
   * Star Rail lets only weakness-matched hits break. We keep the chip so that
   * a badly-composed party is slow rather than stuck, but at half rate.
   */
  BREAK_DAMAGE_MULT: 1.5,
  /** Delay applied to a broken unit's action value, in action-value points. */
  BREAK_DELAY: 2500,
  /** Broken units take this multiplier on damage taken (on top of the bonus). */
  BROKEN_DAMAGE_MULT: 1.0,
  /** Toughness regenerates only when a break "recovery" turn happens. */
  BREAK_RECOVERY_RATIO: 1.0,
  /** A broken unit recovers its toughness when its action value reaches this. */
  BREAK_RECOVERY_DELAY: 1,

  // --- Skill points (Star Rail style team resource) ---
  MAX_SKILL_POINTS: 5,
  START_SKILL_POINTS: 3,
  /** Basic attack regenerates this much. */
  SKILL_POINT_GAIN_BASIC: 1,
  /** Skill costs this much. */
  SKILL_POINT_COST_SKILL: 1,

  // --- Ultimate ---
  /** A basic attack charges the ultimate by this fraction of max energy. */
  ENERGY_BASIC: 0.20,
  ENERGY_SKILL: 0.30,
  ENERGY_HIT_TAKEN: 0.10,
  ENERGY_TURN_START: 0.05,
  ENERGY_KILL: 0.15,
  /**
   * Ultimates can be cast at any time, even between enemy turns, as long as
   * the gauge is full — the single most HSR-flavoured rule in the engine.
   */
  ULTIMATE_INTERRUPT: true,

  // --- Status effects ---
  /** Default duration for a debuff that is not given an explicit one. */
  DEFAULT_DURATION: 2,
  /** Debuff duration is reduced by this much per point of target effect RES. */
  RES_TICK_CHANCE: 0.5,
  /** Damage-over-time effects tick at the start of the afflicted unit's turn. */
  DOT_TICK_ON_TURN_START: true,
  /** Maximum stacks for any single status unless the status overrides it. */
  MAX_STACKS: 5,

  // --- Battle economy ---
  /** Ultimate charges carried into the next battle are capped at this. */
  CARRYOVER_ENERGY_RATIO: 0.5,
  /** HP restored after a won battle. */
  POST_BATTLE_HEAL_RATIO: 0.15,
  /** Flee is not allowed in boss fights; this is the chance elsewhere. */
  FLEE_CHANCE: 0.7,

  // --- Progression ---
  /**
   * The EXP and stat-growth curves.
   *
   * **Important invariant:** `GROWTH` is the *single* place level scaling comes
   * from, and it is applied to `baseStats` — which by definition are the stats a
   * unit has at level 1. Enemy definitions in `core/enemies.js` therefore list
   * level-1-equivalent numbers, not "numbers appropriate to the listed level".
   * Getting that wrong compounds the curve twice and produced a boss with
   * 127,000 HP instead of ~16,000 during development; `test/balance.js` now
   * asserts the resulting HP envelope so it cannot regress silently.
   *
   * Per-level growth is a fraction of the level-1 base, so a character with a
   * high base scales faster in absolute terms — which is the intended
   * "rareness means late-game potential" shape.
   */
  EXP_CURVE_BASE: 60,
  EXP_CURVE_POW: 1.55,
  MAX_LEVEL: 60,
  GROWTH: {
    maxHp: 0.085,
    atk: 0.072,
    def: 0.062,
    spd: 0.012,
  },
};

/**
 * Damage-type tags. `skillType` on a skill decides which formula branch runs.
 */
const SKILL_TYPES = {
  attack: '普通攻击',
  skill: '战技',
  ultimate: '终结技',
  talent: '天赋',
  technique: '秘技',
};

/**
 * Target shapes. `side` is 'enemy' or 'ally'; `count` is the number of units
 * the skill can touch. `blast` and `bounce` are the two composite shapes the
 * engine special-cases.
 */
const TARGET_SHAPES = {
  single: { side: 'enemy', count: 1 },
  blast: { side: 'enemy', count: 3, splashRatio: 0.5 },
  aoe: { side: 'enemy', count: Infinity },
  bounce: { side: 'enemy', count: 1, bounces: 3 },
  ally: { side: 'ally', count: 1 },
  allyAll: { side: 'ally', count: Infinity },
  self: { side: 'self', count: 1 },
  none: { side: 'none', count: 0 },
};

/** Status effect categories, used by cleanse ("remove all debuffs"). */
const STATUS_KINDS = {
  buff: '增益',
  debuff: '减益',
  dot: '持续伤害',
  hot: '持续回复',
  control: '控制',
  special: '特殊',
};

/**
 * Damage classes. `physical` uses DEF; everything else also uses DEF, but the
 * split exists so gear can grant "magic damage taken -10%".
 */
const DAMAGE_CLASS = { physical: 'physical', magical: 'magical' };

module.exports = {
  ELEMENTS,
  ELEMENT_IDS,
  STAT_KEYS,
  DERIVED_STATS,
  BALANCE,
  SKILL_TYPES,
  TARGET_SHAPES,
  STATUS_KINDS,
  DAMAGE_CLASS,
};
