'use strict';

/**
 * The damage and healing pipeline.
 *
 * Everything that changes HP goes through `resolveDamage` / `resolveHeal`.
 * Each stage is a named step with its own comment, because when a number looks
 * wrong the first question is always "which multiplier did that".
 *
 * `explain: true` returns the full intermediate breakdown. The UI shows it in
 * a tooltip (a real project would hide it behind a debug key); `test/balance.js`
 * uses it to assert that specific stages do what the design intends.
 */

const { BALANCE, ELEMENTS } = require('./rules');
const { getStatus, STATUS_CATEGORY } = require('./status');
const { Variance } = require('./rng');

/**
 * Element interaction between an attack and a target.
 *
 *   - weakness      -> full damage and full toughness damage
 *   - resist        -> damage * RESIST_MULT
 *   - immune        -> 0
 *   - absorb        -> negative damage (heals), flagged so the log can say so
 *   - neutral       -> full damage, half toughness damage
 *
 * `resist` values in enemy data are multipliers where lower is tougher, so a
 * value of 0.5 means "takes half". An explicit 0 means immune and a negative
 * value means absorb-heal, matching how the encounter JSON reads.
 */
function elementInteraction(attacker, target, element) {
  const hasWeakness = target.weaknesses.includes(element);
  if (hasWeakness) return { kind: 'weakness', mult: 1, toughnessMult: BALANCE.WEAKNESS_TOUGHNESS_MULT, hasWeakness };

  const resist = target.resist[element];
  if (resist != null) {
    if (resist <= 0) return { kind: resist === 0 ? 'immune' : 'absorb', mult: resist, toughnessMult: 0, hasWeakness };
    return { kind: 'resist', mult: resist, toughnessMult: BALANCE.OFF_ELEMENT_TOUGHNESS_MULT, hasWeakness };
  }
  return { kind: 'neutral', mult: 1, toughnessMult: BALANCE.OFF_ELEMENT_TOUGHNESS_MULT, hasWeakness };
}

/**
 * Level scaling: how far above/below the attacker is relative to the target.
 * Clamped to LEVEL_BAND so a level-1 unit hitting a level-60 boss still deals
 * a visible number (and vice versa) instead of an absurd or zero one.
 */
function levelFactor(attackerLevel, targetLevel) {
  const raw = 1 + (attackerLevel - targetLevel) * BALANCE.LEVEL_STEP;
  const [lo, hi] = BALANCE.LEVEL_BAND;
  return Math.min(hi, Math.max(lo, raw));
}

/** Defence mitigation with the classic `def / (def + K)` curve. */
function defenceFactor(def, attackerLevel) {
  const k = BALANCE.DEF_CONST * (1 + attackerLevel * 0.05);
  return k / (k + Math.max(0, def));
}

/**
 * Compute one hit.
 *
 * @param {object} ctx
 * @param {object} ctx.attacker        Entity
 * @param {object} ctx.target          Entity
 * @param {object} ctx.skill           resolved skill definition
 * @param {number} [ctx.multiplier]    override the skill's multiplier
 * @param {number} [ctx.flatBonus]     flat damage added after multipliers
 * @param {number} [ctx.ratio]         extra scaling factor (blast splash, bounce falloff)
 * @param {object} [ctx.rng]           Rng instance; omit for deterministic (variance = 1)
 * @param {object} [ctx.attackerStats] pre-resolved stats (avoids re-resolving per hit)
 * @param {object} [ctx.targetStats]
 * @param {boolean} [ctx.explain]      include the step breakdown
 * @param {boolean} [ctx.isDot]        DoT ticks bypass defence and level scaling
 * @param {boolean} [ctx.forceCrit]    bosses with guaranteed crits
 * @param {boolean} [ctx.noCrit]       DoT ticks never crit
 * @returns {{amount:number, crit:boolean, element:string, interaction:object, breakdown?:object}}
 */
function resolveDamage(ctx) {
  const {
    attacker, target, skill, rng, explain = false, isDot = false,
    forceCrit = false, noCrit = false, ratio = 1, flatBonus = 0,
  } = ctx;

  const aStats = ctx.attackerStats || attacker.resolveStats();
  const tStats = ctx.targetStats || target.resolveStats();
  const element = ctx.element || skill.element || 'physical';
  const multiplier = ctx.multiplier != null ? ctx.multiplier : (skill.multiplier || 1);

  const breakdown = explain ? {} : null;
  const interaction = elementInteraction(attacker, target, element);
  if (explain) breakdown.interaction = interaction;

  // Absorption / immunity short-circuit: no rounding, no crit roll, no RNG use,
  // so the RNG draw order stays identical whether or not a target resists.
  if (interaction.kind === 'immune') {
    return { amount: 0, crit: false, element, interaction, absorbed: false, breakdown };
  }
  if (interaction.kind === 'absorb') {
    const heal = Math.round(aStats.atk * multiplier * Math.abs(interaction.mult) * ratio);
    return { amount: -heal, crit: false, element, interaction, absorbed: true, breakdown };
  }

  // --- Stage 1: raw attack power ---
  let damage = aStats.atk * multiplier * ratio;
  if (explain) breakdown.raw = round2(damage);

  // --- Stage 2: level scaling (skipped by DoTs, which already snapshot) ---
  if (!isDot) {
    const lf = levelFactor(attacker.level, target.level);
    damage *= lf;
    if (explain) breakdown.levelFactor = round2(lf);
  }

  // --- Stage 3: defence ---
  if (!isDot) {
    const df = defenceFactor(tStats.def, attacker.level);
    damage *= df;
    if (explain) breakdown.defenceFactor = round2(df);
  }

  // --- Stage 4: element ---
  damage *= interaction.mult;
  if (explain) breakdown.elementMult = interaction.mult;

  // --- Stage 5a: attacker side modifiers ---
  const outMult = attacker.outgoingDamageMult(target);
  damage *= outMult;
  if (explain) breakdown.attackerMult = round2(outMult);

  // Weakness-specific nudge for hitting a broken target.
  if (target.broken) {
    damage *= 1 + BALANCE.BROKEN_TAKEN_BONUS;
    if (explain) breakdown.brokenBonus = BALANCE.BROKEN_TAKEN_BONUS;
  }

  // --- Stage 5b: target side modifiers ---
  const inMult = target.incomingDamageMult();
  damage *= inMult;
  if (explain) breakdown.targetMult = round2(inMult);

  // --- Stage 5c: flat bonus (Percent-HP nukes, Atelier item detonations) ---
  if (flatBonus) {
    damage += flatBonus;
    if (explain) breakdown.flatBonus = flatBonus;
  }

  // --- Stage 6: crit, then variance ---
  let crit = false;
  if (!noCrit) {
    crit = forceCrit || (rng ? rng.chance(aStats.critRate) : false);
    if (crit) {
      damage *= aStats.critDmg;
      if (explain) breakdown.critMult = round2(aStats.critDmg);
    }
  }

  const variance = rng ? Variance.roll(rng, BALANCE.DAMAGE_VARIANCE) : 1;
  damage *= variance;
  if (explain) breakdown.variance = round2(variance);

  damage = Math.max(BALANCE.MIN_DAMAGE, Math.round(damage));
  if (explain) breakdown.final = damage;

  return { amount: damage, crit, element, interaction, absorbed: false, breakdown };
}

/**
 * Toughness (weakness-break bar) reduction for one hit.
 *
 * Only enemies carry toughness. The rules:
 *   - weakness-matched hits deal full toughness damage;
 *   - off-element hits deal `OFF_ELEMENT_TOUGHNESS_MULT`;
 *   - the attacker's `break` stat scales it (gear/talents);
 *   - statuses on the target can raise or lower it (`weak_point`, `toughness_up`);
 *   - a broken unit takes none (the bar is already down).
 */
function resolveToughness(ctx) {
  const { attacker, target, skill } = ctx;
  const aStats = ctx.attackerStats || attacker.resolveStats();

  if (target.toughnessMax <= 0) return { amount: 0, interaction: null };
  if (target.broken || target.toughness <= 0) return { amount: 0, interaction: null };

  const element = ctx.element || skill.element || 'physical';
  const interaction = elementInteraction(attacker, target, element);
  if (interaction.toughnessMult <= 0) return { amount: 0, interaction };

  const base = ctx.toughnessBase != null ? ctx.toughnessBase : (skill.toughness || BALANCE.TOUGHNESS_BASIC);
  const raw = base * interaction.toughnessMult * aStats.break * target.toughnessTakenMult();
  return { amount: Math.max(0, Math.round(raw)), interaction };
}

/**
 * Healing pipeline. Separate from damage because it takes no crit, no defence
 * and no element — but it *does* honour the healer's stats, so a healer with
 * more ATK (or a healing-bonus trait) heals more.
 */
function resolveHeal(ctx) {
  const { healer, target, skill, rng } = ctx;
  const hStats = ctx.healerStats || healer.resolveStats();
  const tStats = ctx.targetStats || target.resolveStats();

  const mode = skill.healMode || 'ratio';
  let amount = 0;
  if (mode === 'flat') {
    amount = skill.healFlat || 0;
  } else if (mode === 'maxHp') {
    amount = tStats.maxHp * (skill.healRatio || 0);
  } else {
    amount = hStats.atk * (skill.healRatio != null ? skill.healRatio : 0.4) + (skill.healFlat || 0);
  }
  // A healing received bonus on the target (rare, but Atelier items use it).
  for (const inst of target.statuses) {
    const def = getStatus(inst.id);
    if (def.healReceivedPct) amount *= 1 + def.healReceivedPct;
  }
  if (rng) amount *= Variance.roll(rng, 0.05);
  return { amount: Math.max(0, Math.round(amount)) };
}

/**
 * DoT tick damage for one status instance.
 *
 * DoT is special-cased rather than run through `resolveDamage` for three
 * reasons that each cost me a debugging session:
 *   1. Defence must not apply twice (the DoT already "hit" when it was cast).
 *   2. Level scaling must use the *cast-time* levels, which are snapshotted.
 *   3. The damage belongs to the applier for the result screen, so we must not
 *      let the holder's critical-rate or buffs leak into it.
 */
function resolveDot(ctx) {
  const { holder, inst, rng } = ctx;
  const def = getStatus(inst.id);
  const tStats = holder.resolveStats();
  const snap = inst.snapshot || {};

  let base = 0;
  if (def.dotRatioMaxHp) {
    base = tStats.maxHp * def.dotRatioMaxHp * (inst.stacks || 1);
  } else if (def.dotRatio) {
    base = (snap.atk || 0) * def.dotRatio * (inst.stacks || 1);
  }
  if (base <= 0) return { amount: 0 };

  // Element resistance still applies — a fire-immune boss should not burn.
  let mult = 1;
  const el = def.element;
  if (el) {
    const interaction = elementInteraction({ weaknesses: [], resist: {} }, holder, el);
    mult = interaction.mult;
    if (mult <= 0) return { amount: 0, negated: true };
  }
  // Incoming damage modifiers apply (vulnerability makes burns worse).
  mult *= holder.incomingDamageMult();

  const variance = rng ? Variance.roll(rng, 0.05) : 1;
  return { amount: Math.max(1, Math.round(base * mult * variance)) };
}

/**
 * Break (weakness-break) damage, dealt the instant a toughness bar empties.
 * Scales with the breaker's level and the target's max toughness, so a boss
 * with a huge bar pays out hugely when finally cracked.
 */
function resolveBreakDamage(ctx) {
  const { breaker, target, skill } = ctx;
  const bStats = ctx.breakerStats || breaker.resolveStats();
  const tStats = target.resolveStats();
  const element = ctx.element || skill.element || 'physical';

  const base = bStats.atk * target.breakDamageMult + target.toughnessMax * 0.9;
  const df = defenceFactor(tStats.def, breaker.level);
  let damage = base * df * levelFactor(breaker.level, target.level);
  damage *= breaker.outgoingDamageMult(target);
  damage *= target.incomingDamageMult();
  return { amount: Math.max(1, Math.round(damage)) };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Element metadata for the UI, without importing the whole rules module there. */
function elementInfo(id) {
  return ELEMENTS[id] || ELEMENTS.physical;
}

/**
 * Format a damage number the way the HUD shows it: integers, with a sign for
 * healing/absorption so the floating text has an unambiguous colour.
 */
function formatNumber(amount) {
  if (amount < 0) return `+${Math.abs(amount)}`;
  return String(amount);
}

module.exports = {
  resolveDamage,
  resolveToughness,
  resolveHeal,
  resolveDot,
  resolveBreakDamage,
  elementInteraction,
  levelFactor,
  defenceFactor,
  elementInfo,
  formatNumber,
};
