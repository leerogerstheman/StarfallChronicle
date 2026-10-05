'use strict';

/**
 * Named script handlers: the escape hatch for behaviour that genuinely needs
 * code. Everything a *designer* would want is expressible in the skill/status
 * data; these handlers exist for the small set of things that are not, and they
 * are all listed in one place so the surface stays auditable.
 *
 * Convention: a handler receives `{ battle, actor, skill, effect, summary, ...}`
 * and mutates battle state only through `Battle`'s public methods, so all of its
 * effects still appear in the event log.
 */

const { BALANCE } = require('../core/rules');
const { EVENTS } = require('../core/log');
const { getStatus } = require('../core/status');
const { getSkill } = require('../core/skills');

const HANDLERS = {};

function define(name, fn) {
  if (HANDLERS[name]) throw new Error(`Duplicate script handler: ${name}`);
  HANDLERS[name] = fn;
}

function get(name) {
  return HANDLERS[name];
}

/** Run every hook a unit declares for `event`. */
function runHooks(battle, unit, event, payload = {}) {
  if (!unit) return;
  const hooks = unit.hooks || [];
  for (const hook of hooks) {
    if (hook.on !== event) continue;
    const fn = HANDLERS[hook.handler];
    if (!fn) {
      battle.log.push(EVENTS.WARNING, { message: `未知的钩子脚本：${hook.handler}` });
      continue;
    }
    try {
      fn({ battle, actor: unit, hook, event, ...payload });
    } catch (err) {
      battle.log.push(EVENTS.WARNING, { message: `钩子 ${hook.handler} 执行失败：${err.message}` });
    }
  }
  // Enemy definitions carry AI-side hooks too (phase transitions, death rattles).
  if (unit.def && unit.def.hooks) {
    for (const hook of unit.def.hooks) {
      if (hook.on !== event) continue;
      const fn = HANDLERS[hook.handler];
      if (!fn) continue;
      try {
        fn({ battle, actor: unit, hook, event, ...payload });
      } catch (err) {
        battle.log.push(EVENTS.WARNING, { message: `敌方钩子 ${hook.handler} 失败：${err.message}` });
      }
    }
  }
}

// ===========================================================================
// 角色天赋
// ===========================================================================

/**
 * 苍叶 · 天赋「追风」
 * Breaking an enemy advances Ayaha by 20% and gives her a stack of 战意高昂.
 * The point is a feedback loop: break → act sooner → break again.
 */
define('ayahaTalentBreak', ({ battle, actor, target }) => {
  if (!actor || actor.side !== 'ally') return;
  if (!target || target.side !== 'enemy') return;
  battle.advanceActionValue(actor, Math.round(BALANCE.ACTION_VALUE * 0.20), 'talent:ayaha');
  battle.applyStatus(actor, actor, { status: 'atk_up_self', stacks: 1, duration: 2 }, { force: true });
  battle.log.push(EVENTS.INFO, {
    message: `${actor.name} 的「追风」发动：行动提前 20%`,
    uid: actor.uid, kind: 'talent',
  });
});

/**
 * 御巫铃 · 天赋「调合」
 * Each damaging hit detonates one stack of 炼金印记 on the target.
 * Deliberately per-hit rather than per-skill so multi-hit skills are strong.
 */
define('rinneTalentDetonate', ({ battle, actor, target, amount, skill }) => {
  if (!actor || actor.side !== 'ally') return;
  if (!target || !target.alive || !amount) return;
  // Ultimate already applies brand; don't detonate the brand it just placed.
  if (skill && skill.id === 'rinne_ult') return;
  const inst = target.findStatus('brand');
  if (!inst) return;

  const def = getStatus('brand');
  const stats = actor.resolveStats();
  const damage = Math.round(stats.atk * def.detonateRatio);
  battle.dealDamage(actor, target, damage, { element: def.element, cause: 'talent:rinne' });
  if (target.alive && target.toughnessMax > 0 && !target.broken) {
    battle.reduceToughness(actor, target, 20, { element: def.element });
  }
  // Consume one stack.
  inst.stacks = (inst.stacks || 1) - 1;
  if (inst.stacks <= 0) target.removeStatus('brand');
  battle.log.push(EVENTS.STATUS_TICK, {
    uid: target.uid, status: 'brand', amount: damage, message: `「${def.name}」被引爆`,
  });
});

/**
 * 神代凛 · 天赋「霜华」
 * Freezing an enemy refunds 15 energy to Rin. This is what lets her chain
 * ultimates in a long fight without a dedicated battery.
 */
define('rinTalentFreeze', ({ battle, actor, target, status }) => {
  if (!actor || actor.side !== 'ally') return;
  if (status.id !== 'freeze') return;
  battle.gainEnergy(actor, 15, 'talent:rin');
  battle.applyStatus(actor, actor, { status: 'crit_up', duration: 2 }, { force: true, silent: true });
});

/**
 * 白鸦 · 天赋「疾影」
 * Delaying an enemy grants Byakuya a stacking speed buff.
 */
define('byakuyaTalentHaste', ({ battle, actor, amount }) => {
  if (!actor || actor.side !== 'ally') return;
  if (!amount || amount <= 0) return;
  battle.applyStatus(actor, actor, { status: 'atk_up_self', stacks: 1, duration: 3 }, { force: true, silent: true });
});

/**
 * 白鸦 · 终结技伤害缩放
 * Reads the target's debuff count and exposes it as consumed-stack scaling.
 */
define('byakuyaUltScaling', ({ battle, actor, ctx }) => {
  const target = ctx.primaryTarget;
  if (!target) return;
  const debuffs = target.statuses.filter((s) => {
    const k = getStatus(s.id).kind;
    return k === 'debuff' || k === 'dot' || k === 'control';
  }).length;
  const bonus = Math.min(0.6, debuffs * 0.12);
  ctx.byakuyaBonus = bonus;
  const stats = actor.resolveStats();
  // Applied as a flat bonus so it stacks with the multiplier cleanly.
  ctx.pendingFlatBonus = Math.round(stats.atk * 4.20 * bonus);
  battle.log.push(EVENTS.INFO, {
    message: `「千雷·贯日」根据 ${debuffs} 层减益提升 ${Math.round(bonus * 100)}% 伤害`,
    uid: actor.uid, kind: 'talent',
  });
});

/**
 * 艾莉丝 · 天赋「生命线」
 * At the start of her turn: grant 不屈 to any ally under 30% HP, and top up her
 * own energy. Ticking on her turn (rather than on damage) keeps the number of
 * hook invocations bounded, which matters on a long boss fight.
 */
define('eliseTalentSustain', ({ battle, actor }) => {
  if (!actor || actor.side !== 'ally' || !actor.alive) return;
  battle.gainEnergy(actor, 10, 'talent:elise');
  for (const ally of battle.livingAllies) {
    const stats = ally.resolveStats();
    if (stats.maxHp <= 0) continue;
    if (ally.hp / stats.maxHp < 0.30 && !ally.findStatus('undying')) {
      battle.applyStatus(actor, ally, { status: 'undying', duration: 2 }, { force: true });
      battle.applyStatus(actor, ally, { status: 'dmg_reduce', duration: 2 }, { force: true });
      battle.log.push(EVENTS.INFO, {
        message: `${actor.name} 的「生命线」守护了 ${ally.name}`,
        uid: ally.uid, kind: 'talent',
      });
    }
  }
});

/**
 * 艾莉丝 · 终结技附加：为全队补足能量节奏。
 * The ultimate already heals and shields; this adds the "party-wide tempo"
 * piece that makes it feel like a support ultimate rather than a big heal.
 */
define('eliseUltEnergy', ({ battle, actor }) => {
  for (const ally of battle.livingAllies) {
    if (ally === actor) continue;
    battle.gainEnergy(ally, 12, 'skill:elise_ult');
  }
});

// ===========================================================================
// 角色 / 敌方通用
// ===========================================================================

/**
 * 苍叶终结技：击破后追加推条。
 * The script runs before the damage effect in the effect list, so it registers
 * a one-shot post-damage callback instead of acting immediately.
 */
define('ultBreakDelay', ({ battle, actor, ctx }) => {
  ctx.postDamage = ctx.postDamage || [];
  ctx.postDamage.push(() => {
    const target = ctx.primaryTarget;
    if (!target || !target.alive || !target.broken) return;
    battle.pushActionValue(target, Math.round(BALANCE.ACTION_VALUE * 0.30), 'skill:ayaha_ult');
    battle.log.push(EVENTS.INFO, { message: '苍岚的余波将目标击退', uid: target.uid, kind: 'ultimate' });
  });
});

/** 灰烬残骸自爆：造成伤害后自身倒下。 */
define('selfDestruct', ({ battle, actor }) => {
  battle.log.push(EVENTS.INFO, { message: `${actor.name} 自爆了！`, uid: actor.uid, kind: 'selfDestruct' });
  actor.hp = 0;
  actor.down = true;
  actor.statuses = [];
  battle.log.push(EVENTS.UNIT_DOWN, { uid: actor.uid, name: actor.name, side: actor.side, cause: 'selfDestruct' });
});

/**
 * Boss 终结技缩放：每层「劫火印记」+15%。
 * Also consumes the stacks, so the player is rewarded for *surviving* the nova
 * rather than for tanking it repeatedly.
 */
define('bossNovaScaling', ({ battle, actor, ctx }) => {
  const inst = actor.findStatus('doom');
  const stacks = inst ? (inst.stacks || 0) : 0;
  const bonus = Math.min(0.75, stacks * 0.15);
  ctx.pendingFlatBonus = Math.round(actor.resolveStats().atk * 2.60 * bonus);
  battle.log.push(EVENTS.INFO, {
    message: `烬灭新星吞噬了 ${stacks} 层劫火印记（+${Math.round(bonus * 100)}% 伤害）`,
    uid: actor.uid, kind: 'boss',
  });
  // Drained by the nova, whether or not the player survived it.
  actor.removeStatus('doom');
  // Warn the party: this is a telegraph the UI can flash.
  battle.log.push(EVENTS.WARNING, { message: '灰烬之王释放了终结技：烬灭新星！', uid: actor.uid, kind: 'telegraph' });
});

/**
 * Boss 阶段转换：换弱点、清小怪、播台词。
 *
 * Phase stat scaling is applied *once* by recording the pre-scale values on the
 * entity the first time a phase fires, then always scaling from that baseline.
 * The obvious implementation — `baseStats[k] *= scale[k]` — is a trap: the AI's
 * phase trigger and this handler both run around the same turn, and any second
 * invocation (a reload, a retried handler, a future "phase 3") multiplies the
 * boss's DEF again. That bug took the boss from DEF 244 to 562 and dropped party
 * damage to 322 per turn, turning a 15-round fight into a 76-round slog.
 */
define('bossPhaseChange', ({ battle, actor, phase }) => {
  const def = actor.def;
  if (!def || !def.phases) return;
  const spec = def.phases.find((p) => p.phase === phase);
  if (!spec) return;

  actor.phase = phase;
  if (spec.weaknesses) actor.weaknesses = spec.weaknesses.slice();
  if (spec.resist) actor.resist = { ...spec.resist };

  if (spec.statScale) {
    // Scale factors are cumulative across phases (a later phase sees the product
    // of every scale up to it), but always applied to the pristine baseline.
    //
    // The baseline must be the entity's *effective* stats at its real level, not
    // `baseStats` — `baseStats` has the growth curve divided out of it, so
    // scaling from it and letting `resolveStats` re-apply growth would give the
    // right answer for the wrong reason and break the moment growth changes.
    if (!actor.phaseBaseline) {
      actor.phaseBaseline = { ...actor.resolveStats() };
    }
    // Idempotency guard: a given phase may only ever apply its scale once. The
    // AI's phase trigger and this handler both run around the same turn, and a
    // retried or re-entered handler used to multiply the boss's ATK again
    // (397 -> 456 -> 525 -> ...). Tracking the *applied phase* rather than a
    // product of factors is what makes the bug impossible instead of unlikely.
    actor.scaledPhases = actor.scaledPhases || new Set();
    if (!actor.scaledPhases.has(phase)) {
      actor.scaledPhases.add(phase);
      for (const key of Object.keys(spec.statScale)) {
        // Recompute the cumulative product from the phases actually applied, so
        // phase 3 does not need to know phase 2 ran.
        actor.appliedStatScale = actor.appliedStatScale || {};
        actor.appliedStatScale[key] = (actor.appliedStatScale[key] || 1) * spec.statScale[key];
        const target = actor.phaseBaseline[key] * actor.appliedStatScale[key];
        // Write back through the inverse growth factor so `resolveStats` lands
        // exactly on `target` — same trick `_buildEnemies` uses.
        const factor = 1 + BALANCE.GROWTH[key] * Math.max(0, actor.level - 1);
        actor.baseStats[key] = factor > 0 ? target / factor : target;
      }
    }
  }

  // A fresh toughness bar so phase 2 gets its own break window. Guarded by the
  // same once-only logic via `phase`, which the AI already tracks.
  if (!actor.toughnessRegrownFor || actor.toughnessRegrownFor < phase) {
    actor.toughnessMax = Math.round(actor.toughnessMax * 1.1);
    actor.toughness = actor.toughnessMax;
    actor.broken = false;
    actor.toughnessRegrownFor = phase;
  }

  battle.log.push(EVENTS.PHASE_CHANGE, {
    uid: actor.uid, name: actor.name, phase, phaseName: spec.name,
    weaknesses: actor.weaknesses, dialogue: spec.dialogue,
    stats: {
      maxHp: Math.round(actor.resolveStats().maxHp),
      atk: Math.round(actor.resolveStats().atk),
      def: Math.round(actor.resolveStats().def),
    },
  });
  if (spec.dialogue) {
    battle.log.push(EVENTS.DIALOGUE, { speaker: actor.name, text: spec.dialogue, uid: actor.uid });
  }
  // Phase changes are a clean slate: adds are cleared so the fight refocuses.
  battle.clearSummons(actor.uid);
});

/** Boss 残血「遗言」：一发全屏重击。 */
define('bossLastWord', ({ battle, actor }) => {
  battle.log.push(EVENTS.WARNING, { message: '灰烬之王的气息变了——它准备结束这一切。', uid: actor.uid, kind: 'telegraph' });
  battle.applyStatus(actor, actor, { status: 'atk_up', duration: 3 }, { force: true });
});

// ===========================================================================
// 通用钩子（供数据文件复用）
// ===========================================================================

/** Enemy: on death, give the killer a small energy refund. */
define('enemyDeathRefund', ({ battle, actor, killer }) => {
  if (!killer || killer.side !== 'ally') return;
  battle.gainEnergy(killer, 10, 'deathRefund');
});

/** Generic "on break, take extra damage next turn" marker. */
define('onBrokenMark', ({ battle, actor, breaker }) => {
  if (!actor || actor.side !== 'enemy') return;
  battle.applyStatus(breaker || actor, actor, { status: 'weak_point', duration: 2 }, { force: true });
});

// ===========================================================================
// 运行 ctx.postDamage 队列
// ===========================================================================

/**
 * Called by `executeSkill` after all effects have run.
 * Kept here so skill data can defer work without importing battle internals.
 */
function flushPostDamage(ctx) {
  if (!ctx.postDamage || !ctx.postDamage.length) return;
  const queue = ctx.postDamage;
  ctx.postDamage = [];
  for (const fn of queue) {
    try {
      fn();
    } catch {
      /* a deferred script must never break the turn */
    }
  }
}

/** Count of registered handlers, asserted by the self-test. */
function count() {
  return Object.keys(HANDLERS).length;
}

module.exports = { define, get, runHooks, flushPostDamage, count, HANDLERS };
