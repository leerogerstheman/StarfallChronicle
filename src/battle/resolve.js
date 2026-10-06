'use strict';

/**
 * Skill effect execution and status application.
 *
 * `executeSkill` is the interpreter for the effect list declared in
 * `core/skills.js`. It walks the list in order, resolving each effect's target
 * selector against the skill's chosen primary target.
 *
 * Two rules make this file's behaviour predictable:
 *
 *   1. **Targets are resolved once per effect, not once per skill.** A skill that
 *      hits all enemies then buffs all allies resolves two separate target sets.
 *      This matters for `bounce`, where the target changes between hits.
 *   2. **Damage is applied hit-by-hit, but only *logged* as one skill cast.** The
 *      HUD groups the resulting damage events under the cast event that preceded
 *      them, which is how a 3-hit skill shows three numbers without three
 *      confusing log lines.
 *
 * The status bookkeeping lives here too (`applyStatus`) because statuses are the
 * one thing every effect type can produce, and having one implementation of
 * "refresh vs stack vs resist" removes a whole class of bugs.
 */

const { BALANCE, ELEMENTS } = require('../core/rules');
const { EVENTS } = require('../core/log');
const { PHASE, isTerminal } = require('./action-constants');
const { getStatus, STATUS_CATEGORY, STACK_MODE } = require('../core/status');
const { getSkill } = require('../core/skills');
const {
  resolveDamage, resolveToughness, resolveHeal, elementInteraction,
} = require('../core/damage');
const scripts = require('./scripts');
const { flushPostDamage } = scripts;

/**
 * Resolve a target selector to a concrete list of living entities.
 *
 * **Side safety.** Every branch below filters by the actor's own side, because a
 * selector like `allAllies` means "allies *of the actor*", not "the ally list".
 * The `primary` case is the one that needs care: the UI can send any uid, and an
 * earlier version returned it unchecked. That let 艾莉丝's healing skill — whose
 * effects default to `primary` — heal the *boss* for 130,773 HP over one fight,
 * which read as "the boss is unkillable" rather than "targeting is broken".
 *
 * The rule enforced here is simple: a beneficial selector resolves to the
 * actor's own side; a hostile selector resolves to the opposing side; and if the
 * requested primary target is on the wrong side, the selector falls back to the
 * first legal unit rather than silently doing something surprising.
 *
 * @param {object} ctx        { battle, actor, primaryTarget, skill }
 * @param {string} selector
 * @returns {Array} entities (possibly empty)
 */
function resolveSelector(ctx, selector) {
  const { battle, actor, primaryTarget } = ctx;
  const isAllyActor = actor.side === 'ally';
  const mySide = isAllyActor ? battle.livingAllies : battle.livingEnemies;
  const foeSide = isAllyActor ? battle.livingEnemies : battle.livingAllies;

  /** The requested target, but only if it is alive, present and on `pool`. */
  const primaryIn = (pool) => {
    if (primaryTarget && primaryTarget.alive && pool.includes(primaryTarget)) return primaryTarget;
    return pool[0] || null;
  };

  switch (selector) {
    case 'self':
      return actor.alive ? [actor] : [];

    case 'primary': {
      // Which side `primary` means is decided by the skill, not by the caller.
      const beneficial = isBeneficialSelector(ctx.skill);
      const target = primaryIn(beneficial ? mySide : foeSide);
      return target ? [target] : [];
    }

    case 'allEnemies':
      return foeSide;

    case 'allAllies':
      return mySide;

    case 'allAlliesExceptSelf':
      return mySide.filter((u) => u !== actor);

    case 'allEnemiesExceptPrimary': {
      const all = foeSide;
      // "Blast" secondary targets: the primary's immediate neighbours. Enemies
      // are ordered by slot, so neighbours are index ± 1 — the HSR convention
      // where a blast hits the target and the two beside it.
      const legal = primaryIn(all);
      if (!legal) return all;
      const pool = all.filter((u) => u !== legal);
      if (pool.length <= 2) return pool;
      const sorted = all.slice().sort((a, b) => (a.slot || 0) - (b.slot || 0));
      const idx = sorted.indexOf(legal);
      if (idx < 0) return pool.slice(0, 2);
      const picks = [];
      if (sorted[idx - 1] && sorted[idx - 1].alive) picks.push(sorted[idx - 1]);
      if (sorted[idx + 1] && sorted[idx + 1].alive) picks.push(sorted[idx + 1]);
      // With only one neighbour alive, add the next closest so blast keeps its
      // advertised 3-target shape.
      if (picks.length < 2) {
        for (const u of sorted) {
          if (picks.length >= 2) break;
          if (u === legal || picks.includes(u) || !u.alive) continue;
          picks.push(u);
        }
      }
      return picks;
    }

    case 'randomEnemy': {
      if (!foeSide.length) return [];
      return [battle.rng.pick(foeSide)];
    }

    case 'lowestHpAlly': {
      if (!mySide.length) return [];
      return [mySide.slice().sort((a, b) => (a.hp / a.resolveStats().maxHp) - (b.hp / b.resolveStats().maxHp))[0]];
    }

    case 'marked': {
      const statusId = ctx.skill && ctx.skill.markStatus;
      if (!statusId) return foeSide;
      const marked = foeSide.filter((u) => u.findStatus(statusId));
      return marked.length ? marked : foeSide;
    }

    case 'downed': {
      const pool = isAllyActor ? battle.allies : battle.enemies;
      return pool.filter((u) => !u.alive);
    }

    default:
      // An unknown selector is a data bug; fall back to the primary target on
      // its correct side so the skill still does something rather than no-oping.
      return resolveSelector(ctx, 'primary');
  }
}

/**
 * Does this skill's `primary` target mean an ally of the caster or an enemy?
 *
 * Inferred from the skill's declared shape and its effects, in that order of
 * precedence, because a skill's *intent* should win over an accident of how its
 * first effect was written:
 *   1. `skill.target` — an explicit ally-side shape ('ally', 'allyAll', 'self')
 *      is final;
 *   2. else the effects decide, with damage beating benefit when both appear;
 *   3. otherwise hostile.
 *
 * Step 2 is the fix, and it has bitten twice. The shapes 'single', 'aoe',
 * 'blast' and 'bounce' describe *how many* targets, never *which side*, so
 * treating them as hostile short-circuits and ignores the effects entirely —
 * which once aimed a heal at a boss, and now aimed a follow-up **shield** at a
 * rotten grub. The default for "still ambiguous" is hostile, because healing
 * an enemy is worse than missing a heal.
 */
function isBeneficialSelector(skill) {
  if (!skill) return false;
  switch (skill.target) {
    case 'ally':
    case 'allyAll':
    case 'self':
      return true;
    default:
      break;
  }

  const effects = skill.effects || [];
  const hasHostile = effects.some((e) =>
    e.type === 'damage' || e.type === 'detonate' || e.type === 'summon' ||
    e.type === 'delay' || e.type === 'toughness' || e.type === 'breakInstantly');
  if (hasHostile) return false;

  return effects.some((e) =>
    e.type === 'heal' || e.type === 'shield' || e.type === 'cleanse' ||
    e.type === 'revive' || e.type === 'energy' || e.type === 'advance' ||
    e.type === 'extraTurn' || e.type === 'skillPoint');
}

/**
 * Run a skill's whole effect list.
 * @returns {object} a summary the caller can log or assert on
 */
function executeSkill(ctx) {
  const { battle, actor, skill } = ctx;
  const summary = { skill: skill.id, hits: 0, damage: 0, healed: 0, broke: 0, statuses: [], targets: [] };

  for (const effect of skill.effects || []) {
    // A skill can be cut short if the actor dies mid-cast (counter-attack).
    if (!actor.alive && effect.target !== 'downed') continue;
    applyEffect(ctx, effect, summary);
    // Once the battle is decided there is nothing left to resolve. Without this
    // an AoE that kills the last enemy would keep rolling crits on a corpse and
    // burn RNG draws the replay would not reproduce.
    if (isTerminal(battle.phase)) break;
  }
  // Any script registered a deferred follow-up (see `scripts.flushPostDamage`).
  flushPostDamage(ctx);
  return summary;
}

/** Dispatch a single effect. */
function applyEffect(ctx, effect, summary) {
  const { battle, actor, skill } = ctx;

  switch (effect.type) {
    case 'damage': {
      const targetSelector = effect.target || defaultSelectorFor(skill);
      let targets = resolveSelector(ctx, targetSelector);
      // Multi-bounce skills re-roll their target per hit.
      if (effect.target === 'randomEnemy' && effect.hits > 1) {
        resolveMultiHitRandom(ctx, effect, summary);
        return;
      }
      targets = targets.filter((t) => t && t.alive);
      if (!targets.length) return;
      const hits = effect.hits || 1;
      for (let h = 0; h < hits; h++) {
        for (const target of targets) {
          if (!target.alive) continue;
          resolveOneHit(ctx, effect, target, h, summary);
        }
      }
      return;
    }

    case 'heal': {
      const targets = resolveSelector(ctx, effect.target || 'primary');
      for (const target of targets) {
        if (!target.alive) continue;
        const { amount } = resolveHeal({ healer: actor, target, skill: { ...skill, ...effect, kind: 'heal' }, rng: battle.rng });
        const healed = battle.applyHealing(actor, target, amount, { cause: `skill:${skill.id}` });
        summary.healed += healed;
      }
      return;
    }

    case 'shield': {
      const targets = resolveSelector(ctx, effect.target || 'primary');
      const stats = actor.resolveStats();
      const value = Math.round(stats.atk * (effect.ratio || 1) + (effect.flat || 0));
      for (const target of targets) {
        if (!target.alive) continue;
        applyStatus(battle, actor, target, {
          status: 'shield',
          value,
          duration: effect.duration != null ? effect.duration : BALANCE.DEFAULT_DURATION,
        }, { force: true });
        summary.statuses.push({ target: target.uid, status: 'shield', value });
      }
      return;
    }

    case 'status': {
      const targets = resolveSelector(ctx, effect.target || 'primary');
      for (const target of targets) {
        if (!target.alive && effect.status !== 'doom') continue;
        applyStatus(battle, actor, target, {
          status: effect.status,
          duration: effect.duration,
          stacks: effect.stacks,
          chance: effect.chance,
          aura: effect.aura,
        });
        summary.statuses.push({ target: target.uid, status: effect.status });
      }
      return;
    }

    case 'cleanse': {
      const targets = resolveSelector(ctx, effect.target || 'self');
      for (const target of targets) {
        const removed = target.cleanse();
        if (removed.length) {
          battle.log.push(EVENTS.STATUS_CLEANSED, { uid: target.uid, name: target.name, removed, byId: actor.uid });
        }
      }
      return;
    }

    case 'dispel': {
      const targets = resolveSelector(ctx, effect.target || 'primary');
      for (const target of targets) {
        const removed = target.dispel();
        if (removed.length) {
          battle.log.push(EVENTS.STATUS_REMOVED, { uid: target.uid, name: target.name, removed, byId: actor.uid, cause: 'dispel' });
        }
      }
      return;
    }

    case 'energy': {
      const targets = resolveSelector(ctx, effect.target || 'self');
      for (const target of targets) {
        if (!target.alive) continue;
        battle.gainEnergy(target, effect.amount || 0, `skill:${skill.id}`);
      }
      return;
    }

    case 'skillPoint': {
      // Negative amounts spend (used by "spend SP for extra power" designs).
      if (effect.amount >= 0) battle.gainSkillPoints(effect.amount, actor, `skill:${skill.id}`);
      else battle.spendSkillPoints(-effect.amount, actor, `skill:${skill.id}`);
      return;
    }

    case 'delay': {
      const targets = resolveSelector(ctx, effect.target || 'primary');
      // `amount` may be a ratio (0.25 = 25% of the gauge) or an absolute value.
      for (const target of targets) {
        if (!target.alive) continue;
        const points = effect.amount <= 1
          ? Math.round(BALANCE.ACTION_VALUE * effect.amount)
          : Math.round(effect.amount);
        battle.pushActionValue(target, points, `skill:${skill.id}`);
      }
      return;
    }

    case 'advance': {
      const targets = resolveSelector(ctx, effect.target || 'self');
      for (const target of targets) {
        if (!target.alive) continue;
        const points = effect.amount <= 1
          ? Math.round(BALANCE.ACTION_VALUE * effect.amount)
          : Math.round(effect.amount);
        battle.advanceActionValue(target, points, `skill:${skill.id}`);
      }
      return;
    }

    case 'extraTurn': {
      const targets = resolveSelector(ctx, effect.target || 'self');
      for (const target of targets) {
        if (!target.alive) continue;
        battle.grantExtraTurn(target, effect.count || 1);
      }
      return;
    }

    case 'revive': {
      const targets = resolveSelector(ctx, effect.target || 'primary');
      // A 'downed' shape answers with every fallen ally; when the caster picked
      // one of them (via a uid in the command), the *chosen* one wins so a
      // single-use item stays single-target. No pick — or one outside the
      // pool — falls back to the whole pool, which is the graceful reading of
      // "revive someone".
      const picked = targets.length > 1 && ctx.primaryTarget && targets.includes(ctx.primaryTarget)
        ? [ctx.primaryTarget]
        : targets;
      for (const target of picked) {
        if (target.alive) continue;
        const stats = target.resolveStats();
        target.down = false;
        target.hp = Math.max(1, Math.round(stats.maxHp * (effect.hpRatio || 0.5)));
        battle.log.push(EVENTS.UNIT_REVIVED, { uid: target.uid, name: target.name, hp: target.hp, byId: actor.uid });
      }
      return;
    }

    case 'summon': {
      battle.summon(actor, effect.enemy, effect.count || 1);
      return;
    }

    case 'toughness': {
      const targets = resolveSelector(ctx, effect.target || 'primary');
      for (const target of targets) {
        if (!target.alive) continue;
        battle.reduceToughness(actor, target, effect.amount || 0, { element: effect.element || skill.element });
      }
      return;
    }

    case 'breakInstantly': {
      const targets = resolveSelector(ctx, effect.target || 'primary');
      for (const target of targets) {
        if (!target.alive || target.toughnessMax <= 0 || target.broken) continue;
        battle.reduceToughness(actor, target, target.toughness, { element: effect.element || skill.element });
      }
      return;
    }

    case 'detonate': {
      // Atelier-flavoured: consume stacks of a status for burst damage.
      const targets = resolveSelector(ctx, effect.target || 'primary');
      const def = getStatus(effect.status);
      for (const target of targets) {
        if (!target.alive) continue;
        const inst = target.findStatus(effect.status);
        if (!inst) continue;
        const stacks = inst.stacks || 1;
        const stats = actor.resolveStats();
        const damage = Math.round(stats.atk * (effect.ratio || def.detonateRatio || 0.4) * stacks);
        battle.dealDamage(actor, target, damage, { element: def.element || 'fire', cause: `detonate:${def.id}` });
        battle.log.push(EVENTS.STATUS_TICK, {
          uid: target.uid, status: def.id, amount: damage, stacks, message: `${def.name} 被引爆`,
        });
        target.removeStatus(effect.status);
      }
      return;
    }

    case 'consumeStatus': {
      // Spend a resource (doom stacks, focus) to raise this skill's own power.
      const inst = actor.findStatus(effect.status);
      if (inst) {
        const stacks = Math.min(inst.stacks || 1, effect.maxStacks || 99);
        ctx.consumed = { status: effect.status, stacks };
        actor.statuses = actor.statuses.filter((s) => s !== inst);
        battle.log.push(EVENTS.STATUS_REMOVED, {
          uid: actor.uid, removed: [effect.status], cause: 'consumed', stacks,
        });
      }
      return;
    }

    case 'script': {
      const handler = scripts.get(effect.handler);
      if (!handler) {
        battle.log.push(EVENTS.WARNING, { message: `未知的技能脚本：${effect.handler}` });
        return;
      }
      handler({ battle, actor, skill, effect, summary, ctx, ...ctx });
      return;
    }

    default:
      battle.log.push(EVENTS.WARNING, { message: `未实现的效果类型：${effect.type}` });
  }
}

/** Default selector implied by the skill's own `target` field. */
function defaultSelectorFor(skill) {
  switch (skill.target) {
    case 'aoe': return 'allEnemies';
    case 'ally': return 'primary';
    case 'allyAll': return 'allAllies';
    case 'self': return 'self';
    case 'none': return 'self';
    default: return 'primary';
  }
}

/**
 * One damage instance: compute, apply, then resolve toughness.
 *
 * Order matters and is deliberate:
 *   1. damage first, so a killing blow is attributed before the break,
 *   2. then toughness, so a break that kills still logs,
 *   3. then the on-hit status, but only if the target survived — a dead enemy
 *      does not need a burn on it.
 */
function resolveOneHit(ctx, effect, target, hitIndex, summary) {
  const { battle, actor, skill } = ctx;
  const aStats = actor.resolveStats();
  const tStats = target.resolveStats();

  // "Bonus against a target carrying status X" (Rin's ultimate vs frozen).
  let multiplier = effect.multiplier;
  if (effect.bonusVsStatus && target.findStatus(effect.bonusVsStatus.status)) {
    multiplier *= effect.bonusVsStatus.mult || 1;
  }
  // Consumed-resource scaling (Byakuya's ultimate, the boss's nova). Scripts
  // stash their computed bonus on the shared ctx; applying it here means the
  // scaling lands on every damage effect of the skill, not just the first.
  if (ctx.consumed && ctx.consumed.stacks) {
    multiplier *= 1 + (effect.perConsumedStack || 0) * ctx.consumed.stacks;
  }
  // Per-debuff scaling (Byakuya: +12% per debuff, capped).
  if (skill.scalingPerDebuff) {
    const debuffs = target.statuses.filter((s) => {
      const k = getStatus(s.id).kind;
      return k === STATUS_CATEGORY.DEBUFF || k === STATUS_CATEGORY.DOT || k === STATUS_CATEGORY.CONTROL;
    }).length;
    const bonus = Math.min(skill.scalingPerDebuff.cap || 0.6, debuffs * skill.scalingPerDebuff.per);
    multiplier *= 1 + bonus;
    ctx.lastDebuffBonus = bonus;
  }

  const ratio = effect.ratio != null ? effect.ratio : 1;
  const dmg = resolveDamage({
    attacker: actor, target, skill, multiplier, ratio,
    element: effect.element || skill.element,
    rng: battle.rng,
    attackerStats: aStats, targetStats: tStats,
    flatBonus: (effect.flatBonus || 0) + (ctx.pendingFlatBonus || 0),
  });

  // Absorption heals the target instead — handled before anything else.
  if (dmg.absorbed) {
    battle.applyHealing(actor, target, Math.abs(dmg.amount), { cause: 'absorb' });
    battle.log.push(EVENTS.INFO, { message: `${target.name} 吸收了 ${skill.name}`, uid: target.uid, kind: 'absorb' });
    return;
  }

  const res = battle.dealDamage(actor, target, dmg.amount, {
    element: dmg.element, crit: dmg.crit, cause: `skill:${skill.id}`,
    weakness: dmg.interaction.kind === 'weakness',
  });
  summary.hits++;
  summary.damage += res.applied;
  if (!summary.targets.includes(target.uid)) summary.targets.push(target.uid);

  if (dmg.crit) {
    actor.stats.crits++;
    battle.log.push(EVENTS.CRIT, { sourceId: actor.uid, targetId: target.uid, amount: res.applied });
  }
  if (dmg.interaction.kind === 'weakness') {
    battle.log.push(EVENTS.WEAKNESS_HIT, { sourceId: actor.uid, targetId: target.uid, element: dmg.element });
  }

  // Toughness — the break mechanic. Skipped for zero-toughness skills.
  const toughBase = effect.toughness != null ? effect.toughness : (hitIndex === 0 ? skill.toughness : 0);
  if (toughBase > 0 && target.alive && target.toughnessMax > 0) {
    const tough = resolveToughness({
      attacker: actor, target, skill, element: effect.element || skill.element,
      attackerStats: aStats, toughnessBase: toughBase,
    });
    if (tough.amount > 0) {
      const r = battle.reduceToughness(actor, target, tough.amount, {
        element: dmg.element, weakness: tough.interaction && tough.interaction.kind === 'weakness', skill,
      });
      if (r.broke) summary.broke++;
    }
  }

  // Statuses attached to the damage effect.
  if (target.alive) {
    if (effect.status) {
      applyStatus(battle, actor, target, {
        status: effect.status, duration: effect.duration, chance: effect.chance, stacks: effect.stacks,
      });
    }
    for (const st of effect.statuses || []) {
      applyStatus(battle, actor, target, st);
    }
  }

  // Allies gain energy when they take a hit.
  if (target.side === 'ally' && res.applied > 0) {
    battle.gainEnergy(target, BALANCE.ENERGY_HIT_TAKEN * target.resolveStats().maxEnergy, 'hitTaken');
  }

  scripts.runHooks(battle, actor, 'damageDealt', { target, amount: res.applied, skill, effect });
}

/** A bounce skill: each hit picks a fresh random target. */
function resolveMultiHitRandom(ctx, effect, summary) {
  const { battle, actor, skill } = ctx;
  const hits = effect.hits || 1;
  for (let i = 0; i < hits; i++) {
    const pool = actor.side === 'ally' ? battle.livingEnemies : battle.livingAllies;
    // Prefer a target that is not at full HP so bounce damage spreads sensibly.
    const notFull = pool.filter((u) => u.hp < u.resolveStats().maxHp);
    const target = battle.rng.pick(notFull.length ? notFull : pool);
    if (!target) break;
    resolveOneHit(ctx, effect, target, i, summary);
  }
}

// ===========================================================================
// Status application
// ===========================================================================

/**
 * Apply a status to a target, honouring:
 *   - effect RES (a percentage chance to shrug it off, applied per application),
 *   - the applier's effect HIT (raises the landing chance of debuffs),
 *   - stack mode (refresh / stack / strongest / instance),
 *   - control immunity (bosses carry `effectRes` but some are outright immune
 *     to control via the `controlImmune` flag on their definition).
 *
 * The chance formula is `base + effectHit - effectRes`, clamped to [0.05, 1].
 * Buffs are never resisted (chance forced to 1) because a resisted self-buff is
 * the kind of invisible frustration nobody debugs.
 */
function applyStatus(battle, source, target, spec, options = {}) {
  const def = getStatus(spec.status);
  if (!target) return null;
  // A dead unit keeps nothing except the boss's doom marker (used by scripts
  // that fire on death, e.g. an add detonating).
  if (!target.alive && !options.allowDead) return null;

  const duration = spec.duration != null ? spec.duration : (def.defaultDuration || BALANCE.DEFAULT_DURATION);
  const stacksRequested = spec.stacks != null ? spec.stacks : 1;
  const isBuff = def.kind === STATUS_CATEGORY.BUFF || def.kind === STATUS_CATEGORY.HOT || def.kind === STATUS_CATEGORY.SPECIAL;

  // --- Landing check -------------------------------------------------------
  if (!options.force && !isBuff) {
    const stats = source ? source.resolveStats() : { effectHit: 0 };
    const tStats = target.resolveStats();
    let chance = (spec.chance != null ? spec.chance : 1) + stats.effectHit - tStats.effectRes;
    // Control effects get an extra penalty against high-RES targets, which is
    // what makes "freeze lock the boss" a burst plan rather than a strategy.
    if (def.kind === STATUS_CATEGORY.CONTROL) chance -= tStats.effectRes * 0.5;
    chance = Math.max(0.05, Math.min(1, chance));
    if (!battle.rng.chance(chance)) {
      battle.log.push(EVENTS.STATUS_RESISTED, {
        uid: target.uid, status: def.id, name: def.name, chance: round2(chance), sourceId: source ? source.uid : null,
      });
      return null;
    }
  }

  // --- Merge with an existing instance -------------------------------------
  const existing = target.findStatus(def.id);

  if (existing) {
    switch (def.stackMode) {
      case STACK_MODE.STACK: {
        const before = existing.stacks || 1;
        existing.stacks = Math.min(def.maxStacks || BALANCE.MAX_STACKS, before + stacksRequested);
        existing.remaining = Math.max(existing.remaining, duration);
        // Re-snapshot ATK when stacks grow so DoT growth is honest.
        if (def.dotRatio && source) existing.snapshot = { atk: source.resolveStats().atk, level: source.level };
        battle.log.push(EVENTS.STATUS_APPLIED, {
          uid: target.uid, status: def.id, name: def.name, stacks: existing.stacks,
          added: existing.stacks - before, duration: existing.remaining, refreshed: true,
          sourceId: source ? source.uid : null, icon: def.icon, kind: def.kind,
        });
        return existing;
      }
      case STACK_MODE.STRONGEST: {
        if ((spec.value || 0) <= (existing.value || 0)) return existing;
        existing.value = spec.value;
        existing.remaining = duration;
        return existing;
      }
      case STACK_MODE.INSTANCE: {
        // Shields coexist: push a second instance rather than merging.
        const inst = makeInstance(def, source, duration, stacksRequested, spec);
        target.statuses.push(inst);
        battle.log.push(EVENTS.STATUS_APPLIED, {
          uid: target.uid, status: def.id, name: def.name, stacks: 1, duration,
          sourceId: source ? source.uid : null, icon: def.icon, kind: def.kind, value: inst.value,
        });
        return inst;
      }
      case STACK_MODE.REFRESH:
      default: {
        existing.remaining = Math.max(existing.remaining, duration);
        if (spec.value != null) existing.value = Math.max(existing.value || 0, spec.value);
        battle.log.push(EVENTS.STATUS_APPLIED, {
          uid: target.uid, status: def.id, name: def.name, stacks: existing.stacks || 1,
          duration: existing.remaining, refreshed: true, sourceId: source ? source.uid : null,
          icon: def.icon, kind: def.kind,
        });
        return existing;
      }
    }
  }

  // --- Fresh application ---------------------------------------------------
  const inst = makeInstance(def, source, duration, stacksRequested, spec);
  target.statuses.push(inst);

  battle.log.push(EVENTS.STATUS_APPLIED, {
    uid: target.uid, status: def.id, name: def.name, stacks: inst.stacks,
    duration: inst.remaining, sourceId: source ? source.uid : null,
    icon: def.icon, kind: def.kind, desc: def.desc, value: inst.value,
  });

  // Immediate on-apply effects (action delay, for instance).
  if (def.delayOnApply) {
    battle.pushActionValue(target, def.delayOnApply, `status:${def.id}`);
  }

  scripts.runHooks(battle, source || target, 'statusApplied', { target, status: def, instance: inst });
  if (target.def) scripts.runHooks(battle, target, 'statusReceived', { source, status: def, instance: inst });

  return inst;
}

/** Build a status instance object. */
function makeInstance(def, source, duration, stacks, spec) {
  const inst = {
    id: def.id,
    remaining: duration === Infinity ? Infinity : duration,
    stacks: def.stackMode === STACK_MODE.STACK ? Math.min(def.maxStacks || BALANCE.MAX_STACKS, Math.max(1, stacks)) : 1,
    sourceUid: source ? source.uid : null,
  };
  if (spec.value != null) inst.value = spec.value;
  if (def.shield && inst.value == null) inst.value = 0;
  // DoT snapshots the applier's ATK at cast time so later buffs don't leak in.
  if (def.dotRatio && source) {
    inst.snapshot = { atk: source.resolveStats().atk, level: source.level };
  }
  return inst;
}

/**
 * End-of-turn status bookkeeping helper used by the battle loop.
 * Kept here next to `applyStatus` so the two stay in sync.
 */
function tickStatuses(battle, unit) {
  const expired = [];
  for (const inst of [...unit.statuses]) {
    if (inst.remaining === Infinity) continue;
    inst.remaining -= 1;
    if (inst.remaining <= 0) {
      unit.statuses = unit.statuses.filter((s) => s !== inst);
      expired.push(inst.id);
      battle.log.push(EVENTS.STATUS_EXPIRED, { uid: unit.uid, status: inst.id, name: unit.name });
    }
  }
  return expired;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = {
  executeSkill,
  applyEffect,
  applyStatus,
  resolveSelector,
  isBeneficialSelector,
  tickStatuses,
  resolveOneHit,
};
