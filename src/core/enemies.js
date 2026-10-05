'use strict';

/**
 * The enemy codex.
 *
 * Enemies are stat blocks plus an AI descriptor. Deliberately no per-enemy code:
 * everything a boss does is expressible as (a) a skill list, (b) an AI policy,
 * (c) optional phase triggers. That constraint is what makes the encounter JSON
 * in `data/world/` the only file a designer has to touch to add a new fight.
 *
 * --- How to read `baseStats` ---
 *
 * These are **level-1-equivalent** numbers. `BALANCE.GROWTH` multiplies them by
 * the enemy's `level` at battle-construction time, using the same curve as the
 * party. So an enemy's effective stats are:
 *
 *     baseStats[k] * (1 + GROWTH[k] * (level - 1))
 *
 * A level-22 boss with `maxHp: 16400` therefore arrives at ~45,700 HP. Writing
 * the *desired* level-22 number here and letting growth apply on top compounds
 * the curve and produced a 127,000 HP boss during development.
 *
 * The tier targets the demo is tuned against. A party at the demo's expected
 * level deals roughly 640 damage per ally action with a competent policy, and a
 * "round" is about four ally actions, so a fight's length is roughly
 * `effectiveHp / 2560` rounds. The bands below are asserted by
 * `test/run-all.js` so a future edit that writes a level-scaled number here is
 * caught immediately.
 *
 *   tier        effective HP   expected length   intent
 *   trash       1,300–2,000    1–2 rounds        teach weaknesses and breaks
 *   trash lead  2,500          2–3 rounds        teach "kill the summoner"
 *   elite       1,000–30,000   4–8 rounds        real skill-point management
 *   boss        30,000–45,000  12–18 rounds      full kit: phases, adds, nova
 *
 * Weakness design (this is the part that makes a JRPG party feel like a puzzle
 * rather than a damage race):
 *
 *   trash      — weaknesses cover 3 of the 5 party elements, so any party works
 *   elite      — weaknesses are wind + lightning; the elite resists fire and ice,
 *                so Rinné and Rin must switch to support/debuff duty
 *   boss       — weaknesses are ice + imaginary in phase 1, and it *gains* a wind
 *                weakness in phase 2, rewarding the player for having kept a
 *                breaker in reserve
 */

const ENEMIES = {};

function defineEnemy(enemy) {
  const full = {
    side: 'enemy',
    level: 1,
    toughness: 0,
    weaknesses: [],
    resist: {},
    breakDamageMult: 1.5,
    ai: { policy: 'aggressive' },
    skills: [],
    scale: 1,
    title: '',
    ...enemy,
  };
  if (ENEMIES[full.id]) throw new Error(`Duplicate enemy id: ${full.id}`);
  ENEMIES[full.id] = full;
  return full;
}

// ---------------------------------------------------------------------------
// Trash: 腐叶虫 / 腐叶虫幼虫
// ---------------------------------------------------------------------------
defineEnemy({
  id: 'rotgrub',
  name: '腐叶虫',
  title: '森林的食腐者',
  level: 10,
  color: '#7fa650',
  sprite: 'grub',
  scale: 1,
  baseStats: { maxHp: 560, atk: 78, def: 62, spd: 88, critRate: 0.05, critDmg: 1.5, effectHit: 0.1, effectRes: 0.0, maxEnergy: 100 },
  toughness: 90,
  weaknesses: ['fire', 'wind'],
  resist: { ice: 0.7 },
  skills: ['enemy_claw', 'enemy_spit'],
  ai: {
    policy: 'aggressive',
    // 20% chance to use the debuff skill, otherwise attack.
    skillPreference: { enemy_spit: 0.35, enemy_claw: 0.65 },
    /** Prefers the lowest-HP ally when it uses a single-target skill. */
    targeting: 'lowestHp',
  },
  exp: 42,
  gold: 18,
});

defineEnemy({
  id: 'larva',
  name: '腐叶幼虫',
  title: '虫群',
  level: 8,
  color: '#a3c46a',
  sprite: 'larva',
  scale: 0.7,
  baseStats: { maxHp: 300, atk: 62, def: 44, spd: 102, critRate: 0.05, critDmg: 1.5, effectHit: 0.05, effectRes: 0.0, maxEnergy: 100 },
  toughness: 50,
  weaknesses: ['fire', 'ice', 'lightning'],
  skills: ['enemy_claw'],
  ai: { policy: 'aggressive', skillPreference: { enemy_claw: 1 }, targeting: 'random' },
  exp: 18,
  gold: 7,
});

// ---------------------------------------------------------------------------
// Trash wave lead: 虫母
// ---------------------------------------------------------------------------
defineEnemy({
  id: 'grub_matriarch',
  name: '腐叶虫母',
  title: '虫群之核',
  level: 11,
  color: '#5d8a3a',
  sprite: 'matriarch',
  scale: 1.25,
  baseStats: { maxHp: 900, atk: 86, def: 68, spd: 92, critRate: 0.05, critDmg: 1.5, effectHit: 0.2, effectRes: 0.05, maxEnergy: 100 },
  toughness: 120,
  weaknesses: ['fire', 'wind'],
  resist: { ice: 0.7, lightning: 0.85 },
  skills: ['enemy_claw', 'enemy_spit', 'enemy_swarm_call'],
  ai: {
    policy: 'summoner',
    /** Won't summon more than this many living adds. */
    summonCap: 4,
    skillPreference: { enemy_swarm_call: 0.30, enemy_spit: 0.35, enemy_claw: 0.35 },
    targeting: 'lowestHp',
  },
  exp: 78,
  gold: 34,
});

// ---------------------------------------------------------------------------
// Elite: 深渊哨兵
// ---------------------------------------------------------------------------
defineEnemy({
  id: 'abyss_sentinel',
  name: '深渊哨兵',
  title: '遗迹的看守者',
  level: 16,
  color: '#8b7cf6',
  sprite: 'sentinel',
  scale: 1.4,
  baseStats: { maxHp: 7400, atk: 175, def: 94, spd: 150, critRate: 0.10, critDmg: 1.6, effectHit: 0.25, effectRes: 0.20, maxEnergy: 100 },
  toughness: 340,
  // Wind + lightning only: forces Rinné/Rin into support roles.
  weaknesses: ['wind', 'lightning'],
  resist: { fire: 0.6, ice: 0.6, physical: 0.85 },
  skills: ['sentinel_sweep', 'sentinel_pierce', 'sentinel_barrage', 'sentinel_fortify'],
  ai: {
    policy: 'tactical',
    /** Cycles through a scripted opening so the fight reads as designed. */
    script: [
      { turn: 1, skill: 'sentinel_barrage' },
      { turn: 2, skill: 'sentinel_pierce' },
      { turn: 3, skill: 'sentinel_sweep' },
      { turn: 4, skill: 'sentinel_fortify' },
    ],
    scriptLength: 4,
    skillPreference: { sentinel_barrage: 0.35, sentinel_pierce: 0.25, sentinel_sweep: 0.25, sentinel_fortify: 0.15 },
    /** Fortifies only when it has taken meaningful damage this battle. */
    fortifyBelowHpRatio: 0.75,
    targeting: 'highestAtk',
  },
  exp: 260,
  gold: 140,
  /** Elite fights get an extra opening beat in the narration. */
  intro: '守卫者的独眼亮起，整条走廊开始震颤。',
});

// ---------------------------------------------------------------------------
// Boss: 灰烬之王 · 瓦尔特斯
// ---------------------------------------------------------------------------
defineEnemy({
  id: 'ashen_king',
  name: '灰烬之王·瓦尔特斯',
  title: '焚毁旧都的余烬',
  level: 22,
  color: '#ff6b4a',
  sprite: 'ashenking',
  scale: 1.8,
  /**
   * A boss is 8+ levels above the party's expected arrival level on purpose, and
   * the demo's `requiredLevel` gate tells the player so. Two knobs make that gap
   * bite rather than merely slow the fight down:
   *
   *   - high `effectRes` (0.35) means freeze/burn locks mostly fail, so a party
   *     cannot skip the fight's mechanics;
   *   - high `critRate`/`critDmg` means the gap shows up as *lethality*, which is
   *     what a player reads as "I am under-levelled" rather than "this is slow".
   *
   * Both were chosen after measuring: at level 13 the boss beat the party only
   * 34% of the time when these were 0.30/0.14, which is far too kind for a
   * seven-level deficit.
   */
  baseStats: { maxHp: 9500, atk: 285, def: 118, spd: 175, critRate: 0.22, critDmg: 1.85, effectHit: 0.45, effectRes: 0.35, maxEnergy: 100 },
  toughness: 480,
  weaknessHint: 'phase-dependent',
  // Phase 1 weakness set; swapped in phase 2 by the encounter script.
  weaknesses: ['ice', 'imaginary'],
  resist: { fire: 0.25, physical: 0.7, quantum: 0.8 },
  skills: ['boss_ember_slash', 'boss_ashen_grasp', 'boss_cinder_nova', 'boss_mark_of_doom', 'boss_summon_husks'],
  ai: {
    policy: 'boss',
    /* The AI is a small state machine, described declaratively:
     *   - hard-scripted first three turns so the player learns the kit;
     *   - after that, weighted random gated by HP ratio and doom stacks;
     *   - phase 2 at 50% HP forces the phase-change skill once;
     *   - "last word" at 20% HP fires once and is not re-usable. */
    script: [
      { turn: 1, skill: 'boss_ember_slash' },
      { turn: 2, skill: 'boss_mark_of_doom' },
      { turn: 3, skill: 'boss_ashen_grasp' },
    ],
    phases: [
      { atHpRatio: 0.50, skill: 'boss_phase2_unleash', once: true, phaseFrom: 1, phaseTo: 2, dialogue: '「灰烬不会熄灭。它只会换个地方燃烧。」' },
    ],
    finishers: [
      { atHpRatio: 0.20, skill: 'boss_last_word', once: true },
    ],
    /* Two summon budgets, both required. `summonCap` keeps the field readable;
     * `summonTotalCap` stops a boss that out-heals incoming damage from
     * re-summoning forever, which turned a 15-round fight into a 76-round one. */
    summonCap: 2,
    summonTotalCap: 4,
    /**
     * Two actions per turn. A lone boss otherwise takes one turn per six party
     * actions, which makes it a punching bag; two actions is the classic JRPG
     * answer and keeps the action gauge honest instead of inflating speed.
     * Extra actions never repeat the ultimate (enforced by the battle loop).
     */
    actionsPerTurn: 2,
    /**
     * Cooldowns, measured in the boss's own turns.
     *
     * These are load-bearing, not flavour. Without them the weighted picker cast
     * 「劫火印记」 43 times in a single fight and the boss healed 172,525 HP
     * against the party's 172,659 damage — an unwinnable, 80-round stalemate.
     * The rules now are:
     *   - the self-heal is on a 3-turn cooldown, so it cannot out-pace damage;
     *   - the summon is once per phase at most, via the lifetime budget;
     *   - the nova needs 3 doom stacks, and stacks are drained on cast, so the
     *     big hit is paced by the marking skill rather than by a dice roll.
     */
    skillCooldowns: {
      boss_mark_of_doom: 3,
      boss_summon_husks: 4,
      boss_cinder_nova: 2,
    },
    /** Nova only fires once enough doom stacks exist — telegraphs the mechanic. */
    ultRequiresStacks: { status: 'doom', min: 3 },
    skillPreference: {
      boss_cinder_nova: 0.30,
      boss_summon_husks: 0.15,
      boss_ashen_grasp: 0.25,
      boss_ember_slash: 0.30,
    },
    /** Below 40% HP it stops summoning and pushes damage. */
    aggressiveBelowHpRatio: 0.40,
    targeting: 'highestAtk',
  },
  phases: [
    {
      phase: 1,
      name: '余烬',
      weaknesses: ['ice', 'imaginary'],
      dialogue: '「来到我面前的，都会变成灰。」',
    },
    {
      phase: 2,
      name: '焚天',
      weaknesses: ['ice', 'imaginary', 'wind'],
      resist: { fire: 0.0, physical: 0.6, quantum: 0.7 },
      /** Phase 2 tightens the window: hits harder, acts more often. */
      statScale: { atk: 1.15, spd: 1.10 },
      dialogue: '「那就让这里，和我一起烧尽。」',
    },
  ],
  exp: 920,
  gold: 640,
  intro: '王座上的灰烬聚拢成形。它已经等了几百年，只为再烧一次。',
});

// ---------------------------------------------------------------------------
// Boss adds: 灰烬残骸
// ---------------------------------------------------------------------------
defineEnemy({
  id: 'ash_husk',
  name: '灰烬残骸',
  title: '未熄的遗骸',
  level: 18,
  color: '#b3563a',
  sprite: 'husk',
  scale: 0.95,
  baseStats: { maxHp: 440, atk: 92, def: 70, spd: 96, critRate: 0.05, critDmg: 1.5, effectHit: 0.1, effectRes: 0.0, maxEnergy: 100 },
  toughness: 80,
  weaknesses: ['ice', 'imaginary', 'wind'],
  resist: { fire: 0.2 },
  skills: ['husk_lunge', 'husk_selfdestruct'],
  ai: {
    policy: 'suicide',
    /** Detonates on its second turn — a timer the player must respect. */
    selfDestructAfterTurns: 2,
    skillPreference: { husk_lunge: 0.7, husk_selfdestruct: 0.3 },
    targeting: 'random',
  },
  exp: 60,
  gold: 22,
});

// ---------------------------------------------------------------------------

function getEnemy(id) {
  const e = ENEMIES[id];
  if (!e) throw new Error(`Unknown enemy id: ${id}`);
  return e;
}

function hasEnemy(id) {
  return !!ENEMIES[id];
}

function listEnemies() {
  return Object.keys(ENEMIES).map((id) => ENEMIES[id]);
}

/** Validate that every enemy's skills exist and its weaknesses are real elements. */
function validateAll(skillRegistry, elementIds) {
  const problems = [];
  for (const id of Object.keys(ENEMIES)) {
    const e = ENEMIES[id];
    for (const s of e.skills) {
      if (!skillRegistry[s]) problems.push(`${id}: unknown skill "${s}"`);
    }
    const pool = [...e.skills, ...(e.ai.script || []).map((x) => x.skill), ...(e.ai.phases || []).map((x) => x.skill), ...(e.ai.finishers || []).map((x) => x.skill)]
      .filter(Boolean);
    for (const s of pool) {
      if (!skillRegistry[s]) problems.push(`${id}: AI references unknown skill "${s}"`);
    }
    for (const w of e.weaknesses) {
      if (!elementIds.includes(w)) problems.push(`${id}: unknown weakness element "${w}"`);
    }
    for (const r of Object.keys(e.resist)) {
      if (!elementIds.includes(r)) problems.push(`${id}: unknown resist element "${r}"`);
    }
    for (const s of e.skills) {
      const sk = skillRegistry[s];
      // Enemies *may* hold ultimates (the boss's nova is one) — that is how a
      // telegraphed big hit is expressed. What they must not do is pay for it
      // with skill points, and the AI must gate it behind its own mechanic.
      if (sk && sk.skillPointCost > 0) {
        problems.push(`${id}: enemy skill "${s}" costs skill points`);
      }
    }
    if (e.toughness > 0 && e.weaknesses.length === 0) {
      problems.push(`${id}: has toughness but no weaknesses — unbreakable`);
    }
  }
  return problems;
}

module.exports = { ENEMIES, defineEnemy, getEnemy, hasEnemy, listEnemies, validateAll };
