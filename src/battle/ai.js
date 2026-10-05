'use strict';

/**
 * Enemy AI.
 *
 * The AI is declarative: an enemy's `ai` descriptor in `core/enemies.js` decides
 * everything, and this file only interprets. That means a new enemy never needs
 * new code, and the self-test can regenerate every encounter's behaviour curve
 * without a browser.
 *
 * Descriptor fields:
 *   policy            named personality: aggressive | tactical | summoner |
 *                     boss | support | suicide
 *   script            hard-coded opening turns: [{ turn, skill }]
 *   scriptLength      how many turns the script covers before free choice
 *   skillPreference   { skillId: weight } for weighted random selection
 *   phases            [{ atHpRatio, skill, once, phaseFrom, phaseTo }]
 *   finishers         [{ atHpRatio, skill, once }]
 *   summonCap         maximum simultaneous adds
 *   ultRequiresStacks { status, min } — gate an ultimate behind a mechanic
 *   aggressiveBelowHpRatio  below this HP, prefer damage over utility
 *   fortifyBelowHpRatio     above this HP, prefer defensive skills
 *   targeting         highestAtk | lowestHp | random | mostDebuffs | lowestDef
 *   selfDestructAfterTurns  adds that blow themselves up
 *
 * Decision order each turn:
 *   1. finisher (last-word) if the HP threshold is crossed,
 *   2. phase change if the HP threshold is crossed,
 *   3. hard-scripted turn,
 *   4. self-destruct timer,
 *   5. gated ultimate,
 *   6. weighted random among affordable skills.
 *
 * Steps 1–2 fire exactly once, tracked in `battle.flags`, so a boss cannot
 * re-trigger its phase change on every subsequent turn.
 */

const { EVENTS } = require('../core/log');
const { getSkill } = require('../core/skills');
const { getStatus, STATUS_CATEGORY } = require('../core/status');
const { ACTION } = require('./action-constants');

/**
 * Choose an action for `unit`.
 *
 * @param {object} battle
 * @param {object} unit
 * @param {object} [opts]  { targetOnly: true } returns only a target decision
 * @returns {object} { type, skill, target, reason }
 */
function chooseEnemyAction(battle, unit, opts = {}) {
  const ai = unit.aiPolicy || { policy: 'aggressive' };
  const memory = battle.aiMemory.get(unit.uid) || { turns: 0, scriptIndex: 0, fired: new Set() };
  battle.aiMemory.set(unit.uid, memory);

  const stats = unit.resolveStats();
  const hpRatio = stats.maxHp > 0 ? unit.hp / stats.maxHp : 1;

  // A follow-up action inside a multi-action turn skips the scripted openings
  // and phase transitions (those already had their moment) and may not repeat an
  // ultimate — `opts.noUltimate` is how the battle loop enforces that.
  if (opts.noUltimate) {
    return weightedAction(battle, unit, ai, { noUltimate: true, hpRatio });
  }

  // --- 1. Finishers (last word) -------------------------------------------
  for (const fin of ai.finishers || []) {
    const key = `finisher:${fin.skill}`;
    if (memory.fired.has(key)) continue;
    if (hpRatio <= fin.atHpRatio) {
      memory.fired.add(key);
      battle.log.push(EVENTS.INFO, { message: `${unit.name} 准备释放最后的招式！`, uid: unit.uid, kind: 'telegraph' });
      return { type: ACTION.SKILL, skill: fin.skill, target: pickTarget(battle, unit, fin.skill, ai), reason: 'finisher' };
    }
  }

  // --- 2. Phase changes ---------------------------------------------------
  for (const phase of ai.phases || []) {
    const key = `phase:${phase.skill}`;
    if (phase.once && memory.fired.has(key)) continue;
    if (hpRatio <= phase.atHpRatio) {
      memory.fired.add(key);
      return { type: ACTION.SKILL, skill: phase.skill, target: unit.uid, reason: 'phaseChange', phase: phase.phaseTo };
    }
  }

  // --- 3. Hard script ----------------------------------------------------
  if (ai.script && ai.script.length) {
    const entry = ai.script.find((s) => s.turn === memory.turns + 1);
    if (entry) {
      const target = entry.target === 'self' ? unit.uid : pickTarget(battle, unit, entry.skill, ai);
      return { type: ACTION.SKILL, skill: entry.skill, target, reason: 'script' };
    }
  }

  // --- 4. Self-destruct timer (the ash husks) ----------------------------
  if (ai.selfDestructAfterTurns && memory.turns + 1 >= ai.selfDestructAfterTurns) {
    const boom = unit.skills.find((id) => getSkill(id).name === '自爆');
    if (boom) {
      return { type: ACTION.SKILL, skill: boom, target: pickTarget(battle, unit, boom, ai), reason: 'selfDestruct' };
    }
  }

  // --- 5. Gated ultimate -------------------------------------------------
  const ultimates = unit.skills.filter((id) => getSkill(id).kind === 'ultimate');
  for (const ultId of ultimates) {
    if (!isSkillUsable(battle, unit, ultId, ai)) continue;
    if (ai.ultRequiresStacks) {
      const inst = unit.findStatus(ai.ultRequiresStacks.status);
      const have = inst ? (inst.stacks || 0) : 0;
      if (have < ai.ultRequiresStacks.min) {
        battle.log.push(EVENTS.INFO, {
          message: `${unit.name} 正在积蓄力量（${have}/${ai.ultRequiresStacks.min}）`,
          uid: unit.uid, kind: 'telegraph',
        });
        // Fall through to a non-ultimate action instead of passing.
        break;
      }
    }
    return { type: ACTION.SKILL, skill: ultId, target: pickTarget(battle, unit, ultId, ai), reason: 'ultimate' };
  }

  // --- 6. Weighted choice -------------------------------------------------
  return weightedAction(battle, unit, ai, { hpRatio });
}

/**
 * The weighted-random skill picker, shared by a unit's first action of the turn
 * and by every extra action a multi-action boss takes.
 *
 * @param {object} opts
 * @param {number} opts.hpRatio    pre-computed HP ratio
 * @param {boolean} [opts.noUltimate]  exclude ultimates (extra actions)
 */
function weightedAction(battle, unit, ai, opts = {}) {
  const hpRatio = opts.hpRatio != null ? opts.hpRatio : unit.hp / Math.max(1, unit.resolveStats().maxHp);

  const candidates = unit.skills.filter((id) => {
    const skill = getSkill(id);
    // Ultimates are handled by the caller (gated on stacks, phase, or a
    // once-per-turn rule); extra actions may never use one.
    if (skill.kind === 'ultimate') return false;
    if (!isSkillUsable(battle, unit, id, ai)) return false;
    return true;
  });

  if (!candidates.length) {
    // Nothing usable: enemies always have a basic attack, but be defensive.
    const fallback = unit.skills[0];
    return { type: ACTION.BASIC, skill: fallback, target: pickTarget(battle, unit, fallback, ai), reason: 'fallback' };
  }

  const weighted = candidates.map((id) => {
    let weight = (ai.skillPreference && ai.skillPreference[id]) || 0.2;
    const skill = getSkill(id);

    // Policy nudges.
    if (ai.policy === 'aggressive' && isDamageSkill(skill)) weight *= 1.5;
    if (ai.policy === 'summoner' && skill.effects.some((e) => e.type === 'summon')) {
      const adds = battle.livingEnemies.filter((e) => e.summonedBy === unit.uid).length;
      weight *= adds >= (ai.summonCap || 3) ? 0 : 3;
    }
    if (ai.policy === 'support' && skill.effects.some((e) => e.type === 'shield' || e.type === 'heal')) weight *= 2.5;
    if (ai.policy === 'tactical' && skill.effects.some((e) => e.type === 'shield' || e.type === 'status')) {
      // Fortify only when it has actually been hurt.
      if (ai.fortifyBelowHpRatio && hpRatio > ai.fortifyBelowHpRatio) weight *= 0.1;
    }
    // Below the aggressive threshold, drop utility skills entirely.
    if (ai.aggressiveBelowHpRatio && hpRatio < ai.aggressiveBelowHpRatio) {
      if (!isDamageSkill(skill)) weight *= 0.15;
      else weight *= 1.4;
    }
    return [id, weight];
  }).filter(([, w]) => w > 0);

  const skillId = weighted.length
    ? battle.rng.weighted(weighted)
    : battle.rng.pick(candidates);

  return {
    type: getSkill(skillId).kind === 'basic' ? ACTION.BASIC : ACTION.SKILL,
    skill: skillId,
    target: pickTarget(battle, unit, skillId, ai),
    reason: opts.noUltimate ? 'extraAction' : 'weighted',
  };
}

/** Register that a turn has passed (called by the battle loop). */
function notifyTurnTaken(battle, unit) {
  const memory = battle.aiMemory.get(unit.uid);
  if (memory) memory.turns++;
}

/**
 * Can this skill be used right now? (SP is irrelevant for enemies.)
 *
 * Also enforces per-skill cooldowns, which are the mechanism that keeps an
 * enemy from spamming one action forever. `ai.skillCooldowns` maps a skill id to
 * the number of the enemy's own turns that must pass between uses.
 */
function isSkillUsable(battle, unit, skillId, ai) {
  const skill = getSkill(skillId);
  const memory = battle.aiMemory.get(unit.uid);

  // Cooldown gate. Checked first because it is the cheapest test and the one
  // most likely to reject.
  if (ai.skillCooldowns && ai.skillCooldowns[skillId] && memory) {
    const lastUsed = (memory.lastUsed && memory.lastUsed[skillId]) || -Infinity;
    const gap = memory.turns - lastUsed;
    if (gap < ai.skillCooldowns[skillId]) return false;
  }
  // Some skills are once-per-battle regardless of cooldown.
  if (ai.oneShotSkills && ai.oneShotSkills.includes(skillId) && memory) {
    if (memory.usedOnce && memory.usedOnce.has(skillId)) return false;
  }

  if (skill.kind === 'ultimate') return true; // enemies are not energy-gated
  if (skill.kind === 'talent') return false;
  const block = unit.isBlocked(skill.kind);
  if (block) return false;
  // A summon skill with no room left is not usable.
  if (skill.effects.some((e) => e.type === 'summon')) {
    const adds = battle.livingEnemies.filter((e) => e.summonedBy === unit.uid).length;
    if (adds >= (ai.summonCap || 3)) return false;
    // Respect the lifetime budget too, or the weighted picker keeps choosing a
    // skill that `summon()` will refuse.
    const total = (battle.aiMemory.get(unit.uid) || {}).summonedTotal || 0;
    if (total >= (ai.summonTotalCap || (ai.summonCap || 3) * 3)) return false;
  }
  return true;
}

/**
 * Record that a skill was used, for cooldown bookkeeping.
 * Called by `notifyTurnTaken` and by the multi-action path.
 */
function recordSkillUse(battle, unit, skillId) {
  const memory = battle.aiMemory.get(unit.uid);
  if (!memory) return;
  memory.lastUsed = memory.lastUsed || {};
  memory.lastUsed[skillId] = memory.turns;
  if (!memory.usedOnce) memory.usedOnce = new Set();
  memory.usedOnce.add(skillId);
}

function isDamageSkill(skill) {
  return (skill.effects || []).some((e) => e.type === 'damage' || e.type === 'detonate');
}

/**
 * Choose a target for a skill.
 *
 * Targeting is where an encounter's *feel* lives. `highestAtk` makes a boss
 * threaten the player's damage dealer, which forces defensive play;
 * `lowestHp` on trash makes them finish off wounded party members, which
 * punishes sloppy healing. Both are data, so an encounter designer can dial
 * difficulty without touching this file.
 */
function pickTarget(battle, unit, skillId, ai) {
  const skill = getSkill(skillId);
  const side = unit.side === 'ally' ? 'enemy' : 'ally';

  // Support skills aimed at the enemy's own side.
  if (skill.target === 'self') return unit.uid;
  if (skill.target === 'allyAll' || skill.target === 'ally') {
    const own = side === 'enemy' ? battle.livingEnemies : battle.livingAllies;
    if (skill.target === 'allyAll') return own[0] ? own[0].uid : null;
    const wounded = own.slice().sort((a, b) => (a.hp / a.resolveStats().maxHp) - (b.hp / b.resolveStats().maxHp))[0];
    return wounded ? wounded.uid : null;
  }

  const pool = battle.targetable(side, unit);
  if (!pool.length) return null;

  // Taunt overrides everything for single-target skills.
  const taunter = pool.find((u) => u.findStatus('taunt'));
  if (taunter && skill.target === 'single') return taunter.uid;

  const mode = ai.targeting || 'random';
  switch (mode) {
    case 'highestAtk':
      return pool.slice().sort((a, b) => b.resolveStats().atk - a.resolveStats().atk)[0].uid;
    case 'lowestHp':
      return pool.slice().sort((a, b) => (a.hp / a.resolveStats().maxHp) - (b.hp / b.resolveStats().maxHp))[0].uid;
    case 'lowestDef':
      return pool.slice().sort((a, b) => a.resolveStats().def - b.resolveStats().def)[0].uid;
    case 'mostDebuffs':
      return pool.slice().sort((a, b) => countDebuffs(b) - countDebuffs(a))[0].uid;
    case 'weakestToElement': {
      const el = skill.element;
      const scored = pool.map((u) => ({ u, s: u.weaknesses.includes(el) ? 1 : 0 }));
      scored.sort((a, b) => b.s - a.s);
      return scored[0].u.uid;
    }
    default:
      return battle.rng.pick(pool).uid;
  }
}

function countDebuffs(unit) {
  return unit.statuses.filter((s) => {
    const k = getStatus(s.id).kind;
    return k === STATUS_CATEGORY.DEBUFF || k === STATUS_CATEGORY.DOT || k === STATUS_CATEGORY.CONTROL;
  }).length;
}

/**
 * Run an enemy's whole turn.
 * Returns the number of turns it consumed (0 if it died mid-action).
 */
function runEnemyTurn(battle, unit) {
  const decision = chooseEnemyAction(battle, unit);
  battle.log.push(EVENTS.INFO, {
    message: `${unit.name} 使用了「${getSkill(decision.skill).name}」`,
    uid: unit.uid, kind: 'ai', reason: decision.reason,
  });
  battle.executeDecision(unit, decision);
  recordSkillUse(battle, unit, decision.skill);
  notifyTurnTaken(battle, unit);
  return 1;
}

module.exports = { chooseEnemyAction, pickTarget, runEnemyTurn, notifyTurnTaken, isDamageSkill, recordSkillUse, weightedAction };
