'use strict';

/**
 * The battle state machine.
 *
 * This is the single most important file in the project. It owns:
 *   - the action gauge (Star Rail's turn order),
 *   - the skill-point economy,
 *   - the ultimate interrupt window,
 *   - toughness / weakness break,
 *   - status ticking,
 *   - win/loss detection.
 *
 * It does NOT own damage maths (`core/damage.js`), effect execution
 * (`battle/resolve.js`) or enemy decisions (`battle/ai.js`). Keeping those out
 * is what makes this file readable: you can trace a whole turn without leaving
 * it, because each step is one call into a specialised module.
 *
 * --- The action gauge, precisely ---
 *
 * Every unit accumulates "action value". A unit acts when its accumulated value
 * reaches `ACTION_VALUE` (10000). Each tick advances every unit by its speed:
 *
 *     unit.actionValue += unit.spd
 *
 * so a unit with speed 200 reaches 10000 in 50 ticks and a unit with speed 100
 * takes 100 ticks. That gives exactly the "faster units act more often"
 * behaviour with none of the rounding problems of a percentage-based bar.
 *
 * After acting, a unit's value resets to 0. `delay` subtracts from the value
 * (pushing it back), `advance` adds to it (pulling it forward). This is why
 * delays compose cleanly: subtracting 2500 from a unit sitting at 9000 costs it
 * 25 ticks regardless of how fast it is.
 *
 * --- The ultimate interrupt ---
 *
 * In Star Rail you can fire an ultimate at any moment, including in the middle
 * of the enemy's turn. That is modelled here with a *pending action* slot: when
 * the player declares an ultimate, `queueUltimate` stores it; the main loop
 * checks for pending ultimates before advancing the gauge and resolves them
 * first. Because resolution is synchronous and re-entrant-safe (it only reads
 * and writes entity state), no coroutine machinery is needed.
 */

const { BALANCE } = require('../core/rules');
const { Log, EVENTS } = require('../core/log');
const { Rng } = require('../core/rng');
const { Entity, resetEntitySerial } = require('../core/entity');
const { getStatus } = require('../core/status');
const { getSkill } = require('../core/skills');
const { getEnemy } = require('../core/enemies');
const { resolveDamage, resolveToughness, resolveHeal, resolveDot, resolveBreakDamage } = require('../core/damage');
const { executeSkill, applyStatus, tickStatuses, resolveSelector, isBeneficialSelector } = require('./resolve');
const { chooseEnemyAction } = require('./ai');
const { PHASE, ACTION, isTerminal } = require('./action-constants');
const scripts = require('./scripts');

// `action-constants.js` exists so that `ai.js` can share this vocabulary without
// a require cycle. Re-exported here because callers reasonably expect
// `require('./battle')` to give them PHASE and ACTION.
exports.PHASE = PHASE;
exports.ACTION = ACTION;

class Battle {
  /**
   * @param {object} config
   * @param {Array} config.allies   member sheets from `progression.buildSheet`
   * @param {Array} config.enemies  enemy specs (id + optional level override)
   * @param {number} [config.seed]
   * @param {string} [config.name]  encounter name for the HUD
   * @param {boolean} [config.isBoss]
   * @param {boolean} [config.canFlee]
   * @param {Log} [config.log]
   * @param {object} [config.bonusStatuses] statuses the party starts with (inn rest)
   */
  constructor(config = {}) {
    this.seed = config.seed != null ? config.seed : (Math.random() * 0xffffffff) >>> 0;
    this.rng = new Rng(this.seed);
    this.log = config.log || new Log();
    this.name = config.name || '遭遇战';
    this.isBoss = !!config.isBoss;
    this.isElite = !!config.isElite;
    this.canFlee = config.canFlee !== false && !this.isBoss;
    this.phase = PHASE.INIT;

    // Entity uids are only meaningful *within* a battle, and resetting the
    // counter here is what makes `snapshot()` comparable across runs — the
    // precondition for seeded replay and for the determinism test.
    resetEntitySerial();

    /** Tick counter; one tick = every living unit gains its speed. */
    this.tick = 0;
    /** "Round" for display purposes: increments each time the gauge wraps. */
    this.round = 1;
    this.skillPoints = BALANCE.START_SKILL_POINTS;
    this.maxSkillPoints = BALANCE.MAX_SKILL_POINTS;

    /** Pending ultimate declarations, resolved before the next gauge step. */
    this.pendingUltimates = [];
    /** Set while an extra turn is being granted; see `grantExtraTurn`. */
    this.extraTurnQueue = [];

    this.allies = [];
    this.enemies = [];
    /** Per-unit AI memory (turn counters, script positions). */
    this.aiMemory = new Map();
    /** Encounter-level script state (phases fired, one-shots consumed). */
    this.flags = new Map();

    /** Accumulated rewards, filled in by `endBattle`. */
    this.rewards = { exp: 0, gold: 0, drops: [] };

    this._buildAllies(config.allies || []);
    this._buildEnemies(config.enemies || []);

    // Enemies act with their definition's skill list; the AI reads `aiPolicy`.
    for (const enemy of this.enemies) {
      enemy.hooks = (enemy.def && enemy.def.hooks) || [];
    }

    // A battle is live from construction: `advanceToNextTurn` is the only entry
    // point a caller needs, and requiring an explicit `start()` before it was a
    // sharp edge that produced a "notActive" refusal on the very first ultimate.
    this.phase = PHASE.ACTIVE;

    if (config.bonusStatuses) {
      for (const unit of this.allies) {
        for (const s of config.bonusStatuses) {
          applyStatus(this, unit, unit, { status: s.id || s, duration: s.duration }, { force: true, silent: true });
        }
      }
    }

    this.log.push(EVENTS.BATTLE_START, {
      name: this.name,
      seed: this.seed,
      isBoss: this.isBoss,
      isElite: this.isElite,
      allies: this.allies.map((a) => this.unitSummary(a)),
      enemies: this.enemies.map((e) => this.unitSummary(e)),
      skillPoints: this.skillPoints,
    });
  }

  // =========================================================================
  // Construction
  // =========================================================================

  _buildAllies(sheets) {
    sheets.forEach((sheet, index) => {
      // `buildSheet` already resolved effective stats into `sheet.stats`, which
      // is *post-growth*. Handing that bundle to `Entity` while also giving the
      // entity the member's real level would apply the growth curve twice, and
      // handing it as `gearStats` as well applied equipment bonuses twice again.
      //
      // So: the entity's `baseStats` IS the resolved sheet, its level is pinned
      // to 1 (making the growth multiplier a no-op), and `gearStats` stays empty.
      // `displayLevel` carries the real number for the HUD and for the damage
      // formula, which reads `attacker.level` — hence the setters below.
      const resolved = sheet.stats || sheet.baseStats;
      const entity = new Entity({
        id: sheet.charId || sheet.id,
        name: sheet.name,
        title: sheet.title,
        side: 'ally',
        level: 1,
        baseStats: resolved,
        gearStats: {},
        skills: this._skillListFor(sheet),
        sprite: sheet.sprite,
        color: sheet.color,
        hp: sheet.hp,
        energy: sheet.energy,
        scale: 1,
      });
      entity.displayLevel = sheet.level || 1;
      entity.level = entity.displayLevel;
      // `resolveStats` would re-apply growth on `baseStats`; pre-dividing the
      // bundle by the growth factor cancels it exactly, so the entity keeps an
      // honest level for damage maths without the stat resolver doubling growth.
      const growth = BALANCE.GROWTH;
      const lv = Math.max(0, entity.level - 1);
      for (const key of Object.keys(growth)) {
        if (resolved[key] == null) continue;
        const factor = 1 + growth[key] * lv;
        if (factor > 0) entity.baseStats[key] = resolved[key] / factor;
      }
      entity.slot = index;
      entity.hooks = sheet.hooks || [];
      entity.memberRef = sheet.member || null;
      this.allies.push(entity);
    });
  }

  /** Collect a sheet's usable skill ids in a fixed order. */
  _skillListFor(sheet) {
    const s = sheet.skills || {};
    return [s.basic, s.skill, s.ultimate, s.talent, s.technique].filter(Boolean);
  }

  _buildEnemies(specs, slotOffset = 0) {
    specs.forEach((spec, index) => {
      if (typeof spec === 'string') spec = { id: spec };
      const def = getEnemy(spec.id);
      const level = spec.level || def.level;
      // Level scaling for enemies uses the *same* curve as the party, so a
      // level-30 rotgrub is a real threat rather than a joke.
      //
      // The same trap as `_buildAllies` applies here and it is worth stating
      // twice because it is invisible: `Entity.resolveStats` multiplies
      // `baseStats` by the growth factor for the entity's level. If we pre-scale
      // `stats` AND hand the entity its real level, growth is applied twice —
      // which gave the boss DEF 562 instead of 244 and ATK 997 instead of 397,
      // and silently turned a 15-round fight into a 76-round one.
      //
      // So: pre-scale into `stats`, then divide by the growth factor before
      // handing it over as `baseStats`. Level stays honest for the damage
      // formula; `resolveStats` reproduces `stats` exactly.
      const stats = {};
      for (const key of Object.keys(def.baseStats)) {
        const base = def.baseStats[key];
        stats[key] = BALANCE.GROWTH[key] ? base * (1 + BALANCE.GROWTH[key] * Math.max(0, level - 1)) : base;
      }
      const entity = new Entity({
        id: spec.key || `${def.id}_${index}`,
        name: spec.name || def.name,
        title: def.title,
        side: 'enemy',
        level,
        baseStats: stats,
        weaknesses: def.weaknesses,
        resist: def.resist,
        toughness: spec.toughness || def.toughness,
        breakDamageMult: def.breakDamageMult,
        skills: def.skills,
        sprite: def.sprite,
        color: def.color,
        scale: def.scale,
        hp: spec.hp,
        summonedBy: spec.summonedBy || null,
      });
      const growth = BALANCE.GROWTH;
      const lv = Math.max(0, entity.level - 1);
      for (const key of Object.keys(growth)) {
        if (stats[key] == null) continue;
        const factor = 1 + growth[key] * lv;
        if (factor > 0) entity.baseStats[key] = stats[key] / factor;
      }
      // The phase-scaling baseline is the *effective* stat bundle, captured here
      // so `bossPhaseChange` never has to reason about growth factors itself.
      entity.phaseBaseline = { ...stats };
      entity.def = def;
      entity.aiPolicy = def.ai;
      entity.slot = slotOffset + index;
      entity.hooks = def.hooks || [];
      entity.rewards = { exp: def.exp || 0, gold: def.gold || 0 };
      this.enemies.push(entity);
      // Do not clobber an existing memory record: a summoner's memory holds its
      // lifetime summon budget, and `summon()` calls `_buildEnemies` to create
      // the adds. Resetting here wiped that budget on every summon, which is
      // exactly how the boss escaped its `summonTotalCap`.
      if (!this.aiMemory.has(entity.uid)) {
        this.aiMemory.set(entity.uid, { turns: 0, scriptIndex: 0, fired: new Set() });
      }
    });
  }

  /** Compact unit description used in events. */
  unitSummary(unit) {
    const s = unit.resolveStats();
    return {
      uid: unit.uid,
      id: unit.id,
      name: unit.name,
      side: unit.side,
      level: unit.level,
      hp: unit.hp,
      maxHp: s.maxHp,
      weaknesses: unit.weaknesses,
      toughness: unit.toughness,
      toughnessMax: unit.toughnessMax,
    };
  }

  // =========================================================================
  // Queries used by the AI, the scripts and the API
  // =========================================================================

  get livingAllies() {
    return this.allies.filter((u) => u.alive);
  }

  get livingEnemies() {
    return this.enemies.filter((u) => u.alive);
  }

  /** All living units, allies first (the order the UI draws them in). */
  get living() {
    return [...this.livingAllies, ...this.livingEnemies];
  }

  findUnit(uid) {
    return this.allies.find((u) => u.uid === uid) || this.enemies.find((u) => u.uid === uid) || null;
  }

  alliesOf(unit) {
    return unit.side === 'ally' ? this.allies : this.enemies;
  }

  opponentsOf(unit) {
    return unit.side === 'ally' ? this.enemies : this.allies;
  }

  /** Units on the given side that are alive and targetable. */
  targetable(side, forUnit) {
    const pool = (side === 'ally' ? this.allies : this.enemies).filter((u) => u.alive);
    // `stealth` hides a unit from enemy single-target selection but not from AoE.
    if (forUnit && forUnit.side === 'enemy') {
      const visible = pool.filter((u) => !u.findStatus('stealth'));
      if (visible.length) return visible;
    }
    return pool;
  }

  // =========================================================================
  // Turn order
  // =========================================================================

  /**
   * Advance the gauge until exactly one unit is ready, then return it.
   *
   * Ties are broken by (a) higher speed, then (b) ally before enemy, then by
   * uid so the order is deterministic — important because the RNG draws inside
   * a turn must line up for replays.
   */
  advanceToNextTurn() {
    this._resolvePendingUltimates();
    if (this.phase !== PHASE.ACTIVE) return null;

    // A unit already at full gauge (from an advance) goes first, no tick needed.
    let ready = this.readyUnits();
    let guard = 0;
    while (ready.length === 0 && guard++ < 100000) {
      this._stepGauge();
      this._resolvePendingUltimates();
      if (this.phase !== PHASE.ACTIVE) return null;
      ready = this.readyUnits();
    }
    if (ready.length === 0) {
      // Should be unreachable: with positive speeds the gauge always fills.
      this.log.push(EVENTS.WARNING, { message: '行动条推进失败：没有任何单位可行动' });
      this.endBattle(PHASE.LOST, 'deadlock');
      return null;
    }
    return ready[0];
  }

  /** Units whose gauge is full, in the correct tie-break order. */
  readyUnits() {
    return this.living
      .filter((u) => u.actionValue >= BALANCE.ACTION_VALUE)
      .sort((a, b) => {
        if (b.actionValue !== a.actionValue) return b.actionValue - a.actionValue;
        const sa = a.resolveStats().spd;
        const sb = b.resolveStats().spd;
        if (sb !== sa) return sb - sa;
        if (a.side !== b.side) return a.side === 'ally' ? -1 : 1;
        return a.uid < b.uid ? -1 : 1;
      });
  }

  /** One gauge step: every living unit gains its speed. */
  _stepGauge() {
    for (const unit of this.living) {
      const spd = unit.resolveStats().spd;
      unit.actionValue += spd;
    }
    this.tick++;
    // A crude but readable "round" counter: roughly when a speed-100 unit would
    // have acted once. Used only for display.
    if (this.tick % 100 === 0) this.round++;
  }

  /**
   * Run one full turn for `unit`.
   *
   * `decide` is a callback the caller supplies for player-controlled units; for
   * enemies the AI decides. Returning `null` from `decide` means "pass".
   */
  takeTurn(unit, decide) {
    if (this.phase !== PHASE.ACTIVE) return null;
    if (!unit.alive) {
      // Died while queued (DoT, counter, ultimate interrupt): consume the turn.
      unit.actionValue = 0;
      return null;
    }

    this.log.push(EVENTS.TURN_START, {
      uid: unit.uid,
      name: unit.name,
      side: unit.side,
      round: this.round,
      tick: this.tick,
      actionValue: unit.actionValue,
      hp: unit.hp,
    });
    unit.stats.turnsTaken++;

    // --- Start-of-turn upkeep ------------------------------------------------
    this._tickDots(unit);
    if (!unit.alive) return this._finishTurn(unit);

    const regenGain = this._tickRegen(unit);
    if (regenGain > 0) {
      this.log.push(EVENTS.HEAL, { targetId: unit.uid, amount: regenGain, sourceId: unit.uid, cause: 'regen' });
    }

    const turnEnergy = this._grantTurnStartEnergy(unit);
    if (turnEnergy > 0) {
      this.log.push(EVENTS.ENERGY_CHANGE, { uid: unit.uid, amount: turnEnergy, cause: 'turnStart', energy: unit.energy });
    }

    // Trap scripts (e.g. the boss's phase check) run before the action.
    scripts.runHooks(this, unit, 'turnStart');

    // --- Control check -------------------------------------------------------
    const control = unit.findStatus('freeze') || unit.findStatus('stun') || unit.findStatus('imprison');
    if (control) {
      const def = getStatus(control.id);
      this.log.push(EVENTS.STATUS_TICK, {
        uid: unit.uid, status: control.id, message: `${unit.name} 因「${def.name}」无法行动`,
      });
      unit.actionValue = 0;
      unit.stats.turnsTaken--;
      // A frozen unit's toughness recovery is the same as any skipped turn.
      return this._finishTurn(unit);
    }

    // AoE control (Imprison) also skips, handled above. Silence blocks skills.
    // --- Decide and execute --------------------------------------------------
    let decision = null;
    try {
      decision = unit.isAlly
        ? (decide ? decide(unit, this) : { type: ACTION.DEFEND })
        : chooseEnemyAction(this, unit);
    } catch (err) {
      this.log.push(EVENTS.WARNING, { message: `决策失败：${err.message}`, uid: unit.uid });
      decision = { type: ACTION.BASIC };
    }

    // Confusion: 50% chance the unit hits itself instead.
    const confused = unit.findStatus('confusion');
    if (confused && this.rng.chance(getStatus('confusion').confuseChance) && decision && decision.type !== ACTION.FLEE) {
      this.log.push(EVENTS.STATUS_TICK, { uid: unit.uid, status: 'confusion', message: `${unit.name} 陷入混乱，攻击了自己` });
      this._resolveSelfHit(unit, decision);
      unit.actionValue = 0;
      return this._finishTurn(unit);
    }

    this.executeDecision(unit, decision);
    // Record the use before any extra actions, so a multi-action turn's second
    // action sees the cooldown state the first one created.
    if (unit.isEnemy) require('./ai').recordSkillUse(this, unit, decision.skill);

    // --- Multi-action turns (bosses) ----------------------------------------
    // A lone boss against a four-character party otherwise acts once per six
    // party actions, which reads as a punching bag rather than a threat. Rather
    // than inflate its speed until the action gauge looks silly, a boss may take
    // several actions in one turn — the classic "the dragon attacks twice"
    // solution. Every action after the first is drawn from the same weighted
    // pool but may not re-use an ultimate, so a three-action turn never means
    // three novas in a row.
    const extraActions = (unit.aiPolicy && unit.aiPolicy.actionsPerTurn ? unit.aiPolicy.actionsPerTurn : 1) - 1;
    for (let i = 0; i < extraActions; i++) {
      if (this.phase !== PHASE.ACTIVE || !unit.alive) break;
      const extra = chooseEnemyAction(this, unit, { noUltimate: true });
      if (!extra) break;
      this.log.push(EVENTS.INFO, {
        message: `${unit.name} 追加行动（${i + 2}/${extraActions + 1}）`,
        uid: unit.uid, kind: 'multiAction',
      });
      this.executeDecision(unit, extra);
      if (unit.isEnemy) require('./ai').recordSkillUse(this, unit, extra.skill);
    }

    if (this.phase !== PHASE.ACTIVE) {
      // Battle ended mid-turn (e.g. the last enemy died to a DoT).
      return null;
    }

    unit.actionValue = 0;
    // Let the AI advance its own turn counter (scripted openings depend on it).
    if (unit.isEnemy) require('./ai').notifyTurnTaken(this, unit);
    return this._finishTurn(unit);
  }

  /** Shared tail of every turn: status durations, break recovery, counters. */
  _finishTurn(unit) {
    if (!unit.alive) {
      unit.hasActedThisTurn = true;
      return this._postTurnChecks();
    }

    // Frozen/stunned units still burn one turn of duration at end of turn.
    for (const inst of [...unit.statuses]) {
      const def = getStatus(inst.id);
      if (def.skipsTurn || def.blocksSkill || def.blocksUltimate || def.confuseChance) {
        this._decrementStatus(unit, inst, { endOfTurn: true });
      }
    }

    // Break recovery: a broken unit that has taken its delayed turn restores
    // toughness and stops being broken.
    if (unit.broken) {
      unit.broken = false;
      unit.toughness = Math.round(unit.toughnessMax * BALANCE.BREAK_RECOVERY_RATIO);
      this.log.push(EVENTS.BREAK_RECOVER, {
        uid: unit.uid, name: unit.name, toughness: unit.toughness, toughnessMax: unit.toughnessMax,
      });
    }

    scripts.runHooks(this, unit, 'turnEnd');
    unit.extraTurns = Math.max(0, unit.extraTurns - 1);
    unit.hasActedThisTurn = true;
    this.log.push(EVENTS.TURN_END, { uid: unit.uid, name: unit.name, hp: unit.hp, energy: unit.energy });

    // Extra turns are granted by talents; they re-fill the gauge immediately.
    if (unit.extraTurns > 0) {
      unit.actionValue = BALANCE.ACTION_VALUE;
      this.log.push(EVENTS.EXTRA_TURN, { uid: unit.uid, name: unit.name, remaining: unit.extraTurns });
    }
    return this._postTurnChecks();
  }

  /** After every turn: did someone win? */
  _postTurnChecks() {
    if (this.phase !== PHASE.ACTIVE) return null;
    if (this.livingEnemies.length === 0) {
      this.endBattle(PHASE.WON, 'allEnemiesDown');
      return null;
    }
    if (this.livingAllies.length === 0) {
      this.endBattle(PHASE.LOST, 'partyWiped');
      return null;
    }
    return true;
  }

  // =========================================================================
  // Action execution
  // =========================================================================

  /**
   * Execute a decision for `unit`.
   *
   * @param {Entity} unit
   * @param {object} decision
   * @param {'basic'|'skill'|'ultimate'|'item'|'defend'|'flee'} decision.type
   * @param {string} [decision.skill]   skill id
   * @param {string} [decision.target]  target uid
   */
  executeDecision(unit, decision) {
    if (!decision) return this._defaultAction(unit);

    let result;
    switch (decision.type) {
      case ACTION.BASIC:
      case ACTION.SKILL:
      case ACTION.ULTIMATE:
        result = this.castSkill(unit, decision.skill || unit.skills[decision.type === ACTION.BASIC ? 0 : 1], decision.target, {
          fromUltimate: decision.type === ACTION.ULTIMATE,
        });
        break;
      case ACTION.DEFEND:
        result = this.defend(unit);
        break;
      case ACTION.FLEE:
        result = this.attemptFlee(unit);
        break;
      case ACTION.ITEM:
        result = this.useItem(unit, decision.item, decision.target);
        break;
      default:
        result = this._defaultAction(unit);
    }

    // A declarative phase transition is a property of the AI descriptor
    // (`ai.phases[].phaseTo`), not of the skill itself, so the decision carries
    // it back and it is applied here — in `executeDecision` rather than in the
    // turn loop, so that every caller (the loop, tests, a future replay tool)
    // gets the transition without having to remember it.
    if (decision.phase && unit.isEnemy && this.phase === PHASE.ACTIVE) {
      scripts.get('bossPhaseChange')({ battle: this, actor: unit, phase: decision.phase });
    }
    return result;
  }

  /** Fallback when a decision is missing or malformed. */
  _defaultAction(unit) {
    const basic = unit.skills.find((id) => getSkill(id).kind === 'basic');
    if (basic) return this.castSkill(unit, basic, this.pickDefaultTarget(unit));
    return this.defend(unit);
  }

  /** Reasonable default target for a unit's basic attack. */
  pickDefaultTarget(unit) {
    const pool = this.targetable(unit.side === 'ally' ? 'enemy' : 'ally', unit);
    if (!pool.length) return null;
    if (unit.side === 'enemy') return chooseEnemyAction(this, unit, { targetOnly: true })?.target || pool[0].uid;
    // Allies prefer the enemy with the most weaknesses they can exploit.
    const own = unit.skills.map((id) => getSkill(id).element);
    const scored = pool.map((t) => ({
      uid: t.uid,
      score: t.weaknesses.filter((w) => own.includes(w)).length * 2 + (t.broken ? 1 : 0) + t.hp / (t.resolveStats().maxHp || 1),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored[0].uid;
  }

  /**
   * The core action: cast a skill.
   *
   * Validation happens here rather than in the API layer so that both the player
   * UI and the AI are held to the same rules — a boss cannot cast an ultimate it
   * has not charged, and neither can the player.
   */
  castSkill(unit, skillId, targetUid, options = {}) {
    const skill = getSkill(skillId);

    // --- Gate: is the battle still running? ----------------------------------
    // Checked first so that every other refusal below is about the *unit*, and
    // so a late command from a dropped connection cannot mutate a finished
    // battle's state or its event log.
    if (isTerminal(this.phase)) {
      this.log.push(EVENTS.SKILL_FAILED, { uid: unit.uid, skill: skillId, reason: 'battleOver' });
      return false;
    }
    if (!unit.alive) {
      this.log.push(EVENTS.SKILL_FAILED, { uid: unit.uid, skill: skillId, reason: 'down' });
      return false;
    }

    // --- Gate: is the unit allowed to do this at all? ------------------------
    const block = unit.isBlocked(skill.kind);
    if (block === 'skip') {
      this.log.push(EVENTS.SKILL_FAILED, { uid: unit.uid, skill: skillId, reason: 'controlled' });
      return false;
    }
    if (block === 'skill' && skill.kind === 'skill') {
      this.log.push(EVENTS.SKILL_FAILED, { uid: unit.uid, skill: skillId, reason: 'silenced' });
      return false;
    }
    if (block === 'ultimate' && skill.kind === 'ultimate') {
      this.log.push(EVENTS.SKILL_FAILED, { uid: unit.uid, skill: skillId, reason: 'silenced' });
      return false;
    }

    if (skill.kind === 'ultimate') {
      // Enemies are not energy-gated: their ultimates are telegraphed through
      // the AI's `ultRequiresStacks` / phase gates instead, which are about the
      // *encounter* rather than a resource bar. A player's ultimate spends the
      // gauge; this asymmetry is deliberate — the player's resource is the
      // pacing knob, and giving enemies the same bar would just make their big
      // hits random.
      if (unit.side === 'ally') {
        if (!unit.ultimateReady) {
          this.log.push(EVENTS.SKILL_FAILED, { uid: unit.uid, skill: skillId, reason: 'notCharged', energy: unit.energy });
          return false;
        }
        // Spending the whole gauge is the rule. The refund happens below, after
        // the action, so an ultimate that grants energy to its caster (Elise's
        // does, for the rest of the party) still works.
        unit.energy = 0;
      }
    }

    if (skill.kind === 'skill' && skill.skillPointCost > 0) {
      if (this.skillPoints < skill.skillPointCost) {
        this.log.push(EVENTS.SKILL_FAILED, { uid: unit.uid, skill: skillId, reason: 'noSkillPoints', skillPoints: this.skillPoints });
        return false;
      }
      this.spendSkillPoints(skill.skillPointCost, unit, skill.id);
    }

    // --- Resolve target ------------------------------------------------------
    const target = targetUid ? this.findUnit(targetUid) : null;
    const validTarget = this._validateTarget(unit, skill, target);

    this.log.push(EVENTS.SKILL_CAST, {
      uid: unit.uid,
      name: unit.name,
      skill: skill.id,
      skillName: skill.name,
      // Named `skillKind`, not `kind`: `kind` on an event is the *event type*, and
      // a payload field of the same name would either be shadowed or (before
      // `Log.push` was fixed) shadow the type itself.
      skillKind: skill.kind,
      element: skill.element,
      icon: skill.icon,
      targetId: validTarget ? validTarget.uid : null,
      targetName: validTarget ? validTarget.name : null,
      fromUltimate: !!options.fromUltimate,
      forFree: !!options.forFree,
    });
    if (skill.kind === 'ultimate') this.log.push(EVENTS.ULTIMATE_CAST, { uid: unit.uid, skill: skill.id, name: skill.name });

    // --- Execute -------------------------------------------------------------
    const ctx = {
      battle: this,
      actor: unit,
      skill,
      primaryTarget: validTarget,
      rng: this.rng,
      options,
    };
    const result = executeSkill(ctx);
    // Deferred hooks registered by scripts (e.g. "if the target broke, push it
    // back") run once every effect has resolved.
    scripts.flushPostDamage(ctx);

    // --- Pay the action's own costs/refunds ---------------------------------
    if (!options.forFree) {
      const gain = skill.energyGain != null ? skill.energyGain : defaultEnergy(skill.kind);
      if (gain > 0) this.gainEnergy(unit, gain, `cast:${skill.id}`);
    }

    // Scripts keyed on the skill (e.g. boss phase transitions).
    scripts.runHooks(this, unit, 'afterSkill', { skill, result });

    return result;
  }

  /**
   * Keep a stale or illegal target from breaking the action.
   *
   * Which side is legal comes from the *skill*, not from a guess: a healing
   * skill's target is an ally, an attack's is an enemy. Getting this wrong is
   * invisible in a log but catastrophic in play — before this was side-aware,
   * 艾莉丝's heal could be pointed at the boss and topped it up for 130,000 HP
   * across a fight.
   */
  _validateTarget(unit, skill, target) {
    const beneficial = isBeneficialSelector(skill);
    const wantsAlly = beneficial;
    const pool = this.targetable(wantsAlly ? unit.side : (unit.side === 'ally' ? 'enemy' : 'ally'), unit);
    if (!pool.length) return null;

    if (!target || !target.alive || !pool.includes(target)) {
      if (wantsAlly && skill.target !== 'allyAll' && skill.target !== 'self') {
        // A beneficial single-target skill with no explicit choice heals the
        // most wounded ally, which is what a player would have picked.
        return pool.slice().sort((a, b) => (a.hp / a.resolveStats().maxHp) - (b.hp / b.resolveStats().maxHp))[0];
      }
      return pool[0];
    }
    if (target.findStatus('stealth') && unit.side === 'enemy' && skill.target === 'single') return pool[0];
    return target;
  }

  /** Basic defensive action: reduces incoming damage by 40% for one turn. */
  defend(unit) {
    this.log.push(EVENTS.SKILL_CAST, {
      uid: unit.uid, name: unit.name, skill: 'defend', skillName: '防御', skillKind: 'defend', icon: '🛡',
    });
    applyStatus(this, unit, unit, { status: 'dmg_reduce', duration: 1 }, { force: true });
    this.gainEnergy(unit, defaultEnergy('defend'), 'defend');
    return true;
  }

  /** Consumable items — thin now, but the hook exists for the Atelier layer. */
  useItem(unit, itemId, targetUid) {
    const { getItem } = require('../core/items');
    const item = getItem(itemId);
    if (!item) return false;
    const target = (targetUid && this.findUnit(targetUid)) || unit;
    this.log.push(EVENTS.SKILL_CAST, {
      uid: unit.uid, name: unit.name, skill: `item:${itemId}`, skillName: item.name, skillKind: 'item', icon: item.icon,
    });
    const ctx = { battle: this, actor: unit, skill: { ...item, element: item.element || 'physical', kind: 'item', target: item.target }, primaryTarget: target, rng: this.rng, options: {} };
    executeSkill(ctx);
    return true;
  }

  /** Flee: succeeds with FLEE_CHANCE, except in boss fights. */
  attemptFlee(unit) {
    if (!this.canFlee) {
      this.log.push(EVENTS.SKILL_FAILED, { uid: unit.uid, skill: 'flee', reason: 'noEscape' });
      return false;
    }
    if (this.rng.chance(BALANCE.FLEE_CHANCE)) {
      this.log.push(EVENTS.UNIT_ESCAPED, { uid: unit.uid, name: unit.name });
      this.endBattle(PHASE.FLED, 'fled');
      return true;
    }
    this.log.push(EVENTS.WARNING, { message: `${unit.name} 没能逃掉！` });
    return false;
  }

  // =========================================================================
  // Ultimate interrupt
  // =========================================================================

  /**
   * Declare an ultimate to fire at the next opportunity, even mid-enemy-turn.
   * Returns false if the request is invalid (no charge, silenced, already queued).
   */
  queueUltimate(unitUid, skillId, targetUid) {
    const unit = this.findUnit(unitUid);
    if (!unit) return { ok: false, reason: 'noSuchUnit' };
    if (!unit.alive) return { ok: false, reason: 'down' };
    if (this.phase !== PHASE.ACTIVE) return { ok: false, reason: 'notActive' };
    if (!unit.ultimateReady) return { ok: false, reason: 'notCharged' };
    if (this.pendingUltimates.some((p) => p.unitUid === unitUid)) return { ok: false, reason: 'alreadyQueued' };
    const block = unit.isBlocked('ultimate');
    if (block) return { ok: false, reason: 'silenced' };

    const skill = skillId ? getSkill(skillId) : getSkill(unit.skills.find((id) => getSkill(id).kind === 'ultimate'));
    if (!skill || skill.kind !== 'ultimate') return { ok: false, reason: 'notAnUltimate' };

    this.pendingUltimates.push({ unitUid, skillId: skill.id, targetUid: targetUid || this.pickDefaultTarget(unit) });
    this.log.push(EVENTS.ACTION_QUEUED, { uid: unitUid, skill: skill.id, kind: 'ultimate' });
    return { ok: true };
  }

  /**
   * Fire every queued ultimate.
   *
   * Called before each gauge step and at the top of `advanceToNextTurn`, which
   * is what makes "ultimate whenever you want" work without threading a
   * coroutine through the turn loop. Ultimates here do not consume the unit's
   * turn and do not reset its action value — that is the Star Rail rule, and it
   * is what makes banking a full gauge across two characters so strong.
   */
  _resolvePendingUltimates() {
    if (!this.pendingUltimates.length) return;
    const queue = this.pendingUltimates;
    this.pendingUltimates = [];
    for (const item of queue) {
      const unit = this.findUnit(item.unitUid);
      if (!unit || !unit.alive || !unit.ultimateReady) continue;
      this.log.push(EVENTS.INFO, { message: `${unit.name} 插入了终结技！`, kind: 'ultimateInterrupt' });
      this.castSkill(unit, item.skillId, item.targetUid);
      if (this.phase !== PHASE.ACTIVE) return;
    }
  }

  /** True if any queued ultimate is still valid — used by the UI to pulse. */
  get hasPendingUltimate() {
    return this.pendingUltimates.length > 0;
  }

  // =========================================================================
  // Resources
  // =========================================================================

  spendSkillPoints(amount, unit, cause) {
    this.skillPoints = Math.max(0, this.skillPoints - amount);
    this.log.push(EVENTS.SP_CHANGE, {
      uid: unit ? unit.uid : null, amount: -amount, total: this.skillPoints, cause: cause || 'spend',
    });
    return this.skillPoints;
  }

  gainSkillPoints(amount, unit, cause) {
    const before = this.skillPoints;
    this.skillPoints = Math.min(this.maxSkillPoints, this.skillPoints + amount);
    const delta = this.skillPoints - before;
    if (delta !== 0) {
      this.log.push(EVENTS.SP_CHANGE, {
        uid: unit ? unit.uid : null, amount: delta, total: this.skillPoints, cause: cause || 'gain',
      });
    }
    return delta;
  }

  gainEnergy(unit, amount, cause) {
    if (!unit.alive || amount === 0) return 0;
    const before = unit.ultimateReady;
    const delta = unit.gainEnergy(amount);
    if (delta !== 0) {
      this.log.push(EVENTS.ENERGY_CHANGE, { uid: unit.uid, amount: delta, energy: unit.energy, cause: cause || 'gain' });
    }
    if (!before && unit.ultimateReady) {
      this.log.push(EVENTS.ULTIMATE_READY, { uid: unit.uid, name: unit.name });
      scripts.runHooks(this, unit, 'ultimateReady');
    }
    return delta;
  }

  /** Energy every living ally gains when any unit is hit. */
  grantHitEnergy(amount, source) {
    for (const ally of this.livingAllies) {
      const gain = amount * (ally === source ? 0.5 : 1);
      this.gainEnergy(ally, gain, 'allyHitTaken');
    }
  }

  // =========================================================================
  // Statuses
  // =========================================================================

  /**
   * Apply a status, honouring effect RES and immunity.
   * Delegates to `resolve.applyStatus` for the actual bookkeeping so that there
   * is exactly one implementation of stacking rules.
   */
  applyStatus(source, target, spec, options = {}) {
    return applyStatus(this, source, target, spec, options);
  }

  /** Called by `resolve.js` at the end of a turn to burn durations. */
  _decrementStatus(unit, inst, ctx = {}) {
    if (inst.remaining === Infinity) return false;
    inst.remaining -= 1;
    if (inst.remaining <= 0) {
      this.removeStatus(unit, inst.id, 'expired');
      return true;
    }
    return false;
  }

  removeStatus(unit, statusId, cause) {
    const ok = unit.removeStatus(statusId);
    if (ok) {
      this.log.push(EVENTS.STATUS_EXPIRED, { uid: unit.uid, status: statusId, cause: cause || 'expired', name: unit.name });
    }
    return ok;
  }

  // =========================================================================
  // DoT / HoT ticking
  // =========================================================================

  /**
   * Tick all DoTs on `unit`. Runs at the start of its turn, so a poison applied
   * on turn 3 first hurts on turn 4 — the conventional JRPG timing.
   */
  _tickDots(unit) {
    const dots = unit.statuses.filter((s) => getStatus(s.id).dotRatio || getStatus(s.id).dotRatioMaxHp);
    for (const inst of dots) {
      if (!unit.alive) break;
      const def = getStatus(inst.id);
      const { amount } = resolveDot({ holder: unit, inst, rng: this.rng });
      if (amount <= 0) continue;

      const source = inst.sourceUid ? this.findUnit(inst.sourceUid) : null;
      const res = this.dealDamage(source, unit, amount, {
        element: def.element, cause: `dot:${def.id}`, isDot: true, silent: true,
      });
      this.log.push(EVENTS.STATUS_TICK, {
        uid: unit.uid, status: def.id, name: def.name, amount: res.applied,
        stacks: inst.stacks || 1, sourceId: source ? source.uid : null,
      });

      if (def.delayOnTick && unit.alive) {
        this.pushActionValue(unit, def.delayOnTick, `dot:${def.id}`);
      }
      // DoT durations burn on the holder's turn, same as other statuses.
      this._decrementStatus(unit, inst, { dotTick: true });
    }
  }

  /** Tick HoTs. Returns total healed. */
  _tickRegen(unit) {
    const hots = unit.statuses.filter((s) => getStatus(s.id).healPct);
    let total = 0;
    for (const inst of hots) {
      const def = getStatus(inst.id);
      const stats = unit.resolveStats();
      const amount = Math.round(stats.maxHp * def.healPct * (inst.stacks || 1));
      const healed = unit.applyHeal(amount, stats);
      unit.stats.healingDone += healed;
      total += healed;
      this._decrementStatus(unit, inst, { hotTick: true });
    }
    return total;
  }

  /** Energy granted at turn start from statuses (brave order, ult_charge). */
  _grantTurnStartEnergy(unit) {
    let total = 0;
    for (const inst of unit.statuses) {
      const def = getStatus(inst.id);
      if (def.energyPerStack) total += def.energyPerStack * (inst.stacks || 1);
      if (def.energyOnTurnStart) total += def.energyOnTurnStart;
    }
    // A small baseline so a stalling player still eventually gets ultimates.
    total += BALANCE.ENERGY_TURN_START * unit.resolveStats().maxEnergy;
    const before = unit.energy;
    unit.gainEnergy(total);
    return unit.energy - before;
  }

  // =========================================================================
  // Damage application
  // =========================================================================

  /**
   * Apply an already-computed damage number.
   *
   * All damage in the game funnels through here so that exactly one place is
   * responsible for: shields, `reflect`, `undying`, `autoRevive`, death events,
   * kill energy, and the counters the result screen shows.
   */
  dealDamage(source, target, amount, options = {}) {
    if (!target.alive && !options.allowDead) return { applied: 0, killed: false };
    const preHp = target.hp;
    const result = target.applyDamage(amount);
    const applied = result.hpLost;

    if (source && applied > 0 && !options.isDot) source.stats.damageDealt += applied;
    target.stats.damageTaken += applied;

    if (result.shieldAbsorbed > 0) {
      this.log.push(EVENTS.DAMAGE, {
        sourceId: source ? source.uid : null,
        targetId: target.uid,
        amount: 0,
        shieldAbsorbed: result.shieldAbsorbed,
        element: options.element || 'physical',
        cause: options.cause || 'attack',
        hpAfter: target.hp,
        hpBefore: preHp,
        shielded: true,
      });
    }

    if (applied > 0 || result.revived) {
      this.log.push(EVENTS.DAMAGE, {
        sourceId: source ? source.uid : null,
        targetId: target.uid,
        amount: applied,
        crit: !!options.crit,
        element: options.element || 'physical',
        cause: options.cause || 'attack',
        hpAfter: target.hp,
        hpBefore: preHp,
        weakness: !!options.weakness,
        isDot: !!options.isDot,
        overkill: Math.max(0, amount - applied - result.shieldAbsorbed),
      });
    }

    if (result.survivedLethal) {
      this.log.push(EVENTS.INFO, { message: `${target.name} 靠「不屈」撑住了！`, uid: target.uid, kind: 'undying' });
    }
    if (result.revived) {
      this.log.push(EVENTS.UNIT_REVIVED, { uid: target.uid, name: target.name, hp: target.hp });
    }
    if (result.lethal) {
      this._onUnitDown(target, source);
    }

    // Reflect: returns a fraction to the attacker. Only on real attacks, never
    // on DoT (otherwise a burn could reflect itself into an infinite loop).
    const reflect = target.findStatus('reflect');
    if (reflect && source && source.alive && applied > 0 && !options.isDot && !options.isReflect) {
      const back = Math.round(applied * getStatus('reflect').reflectRatio);
      this.log.push(EVENTS.STATUS_TICK, { uid: target.uid, status: 'reflect', amount: back, message: `${target.name} 反射了伤害` });
      this.dealDamage(target, source, back, { cause: 'reflect', isReflect: true, silent: true });
    }

    return { applied, killed: result.lethal, survivedLethal: result.survivedLethal };
  }

  _onUnitDown(unit, source) {
    this.log.push(EVENTS.UNIT_DOWN, { uid: unit.uid, name: unit.name, side: unit.side, killerId: source ? source.uid : null });
    if (source) {
      source.stats.kills++;
      if (source.side === 'ally') {
        this.gainEnergy(source, BALANCE.ENERGY_KILL * source.resolveStats().maxEnergy, 'kill');
      }
    }
    // The boss script wants to know.
    scripts.runHooks(this, unit, 'down', { killer: source });
    this._postTurnChecks();
  }

  /** Heal that goes through the event log. */
  applyHealing(source, target, amount, options = {}) {
    if (!target || target.hp <= 0) return 0;
    const stats = target.resolveStats();
    const healed = target.applyHeal(amount, stats);
    if (healed > 0) {
      if (source) source.stats.healingDone += healed;
      this.log.push(EVENTS.HEAL, {
        sourceId: source ? source.uid : null,
        targetId: target.uid,
        amount: healed,
        overheal: Math.max(0, amount - healed),
        cause: options.cause || 'heal',
      });
    }
    return healed;
  }

  // =========================================================================
  // Toughness and weakness break
  // =========================================================================

  /**
   * Reduce toughness and, if the bar empties, trigger a break.
   *
   * Returns { dealt, broke } so the caller can chain (e.g. Ayaha's talent).
   */
  reduceToughness(source, target, amount, options = {}) {
    if (target.toughnessMax <= 0 || amount <= 0) return { dealt: 0, broke: false };
    if (!target.alive || target.broken) return { dealt: 0, broke: false };

    const mult = target.toughnessTakenMult();
    const dealt = Math.min(target.toughness, Math.max(0, Math.round(amount * mult)));
    target.toughness -= dealt;

    this.log.push(EVENTS.TOUGHNESS, {
      sourceId: source ? source.uid : null,
      targetId: target.uid,
      amount: dealt,
      toughness: target.toughness,
      toughnessMax: target.toughnessMax,
      element: options.element || 'physical',
      weakness: !!options.weakness,
    });

    if (target.toughness <= 0) {
      this._triggerBreak(source, target, options);
      return { dealt, broke: true };
    }
    return { dealt, broke: false };
  }

  /** The break itself: damage, delay, and the "broken" window. */
  _triggerBreak(source, target, options = {}) {
    const { amount } = resolveBreakDamage({
      breaker: source || target, target, skill: options.skill || {}, element: options.element,
      breakerStats: source ? source.resolveStats() : undefined,
    });

    target.broken = true;
    target.toughness = 0;
    if (source) source.stats.breaks++;

    this.log.push(EVENTS.BREAK, {
      sourceId: source ? source.uid : null,
      targetId: target.uid,
      name: target.name,
      amount,
      element: options.element || 'physical',
      delay: BALANCE.BREAK_DELAY,
    });

    if (amount > 0) {
      this.dealDamage(source, target, amount, { element: options.element, cause: 'break', silent: true });
    }

    // Breaking pushes the target back on the gauge — the core tempo reward.
    if (target.alive) this.pushActionValue(target, BALANCE.BREAK_DELAY, 'break');

    // A broken unit loses its buffs; this is the "you cracked its shell" moment.
    if (target.alive) {
      target.removeStatus('toughness_up');
      target.removeStatus('dmg_reduce');
    }

    scripts.runHooks(this, source || target, 'break', { target, element: options.element });
    // The target's own scripts may want to react (phase transitions on break).
    if (target.def) scripts.runHooks(this, target, 'broken', { breaker: source });
  }

  /**
   * Push a unit back on the gauge. `amount` is absolute action-value points.
   * `delay` effects convert their ratio into points before calling this.
   */
  pushActionValue(unit, amount, cause) {
    if (!unit.alive) return 0;
    const before = unit.actionValue;
    unit.actionValue = Math.max(0, unit.actionValue - amount);
    const delta = unit.actionValue - before;
    if (delta !== 0) {
      this.log.push(EVENTS.DELAY, { uid: unit.uid, name: unit.name, amount: -delta, cause: cause || 'delay', actionValue: unit.actionValue });
      scripts.runHooks(this, unit, 'delayed', { amount: -delta, cause });
    }
    return -delta;
  }

  /** Pull a unit forward on the gauge. */
  advanceActionValue(unit, amount, cause) {
    if (!unit.alive) return 0;
    const before = unit.actionValue;
    unit.actionValue = Math.min(BALANCE.MAX_ACTION_VALUE, unit.actionValue + amount);
    const delta = unit.actionValue - before;
    if (delta !== 0) {
      this.log.push(EVENTS.ADVANCE, { uid: unit.uid, name: unit.name, amount: delta, cause: cause || 'advance', actionValue: unit.actionValue });
    }
    return delta;
  }

  /** Push back every living unit on one side. */
  delaySide(side, amount, cause) {
    for (const unit of (side === 'enemy' ? this.livingEnemies : this.livingAllies)) {
      this.pushActionValue(unit, amount, cause);
    }
  }

  /**
   * Grant an extra turn: the unit's gauge is refilled so it acts again after the
   * current turn finishes.
   */
  grantExtraTurn(unit, count = 1) {
    unit.extraTurns += count;
    return unit.extraTurns;
  }

  // =========================================================================
  // Summoning
  // =========================================================================

  /**
   * Add an enemy mid-battle.
   *
   * The summoner's `summonCap` limits how many living adds it may maintain, so a
   * boss cannot flood the field and stall the fight forever.
   *
   * Two separate budgets are enforced, and both are necessary:
   *   - a *concurrent* cap (`summonCap`) on living adds, so the player is never
   *     outnumbered beyond what the UI can show;
   *   - a *lifetime* cap (`summonTotalCap`) on adds ever created, because the
   *     concurrent cap alone lets a boss that out-heals incoming damage re-summon
   *     forever. Without it the demo's boss created 24 husks in one fight and the
   *     player's damage went into trash instead of the boss.
   */
  summon(summoner, enemyId, count = 1) {
    const policy = summoner.aiPolicy || {};
    const cap = policy.summonCap || 3;
    const totalCap = policy.summonTotalCap || cap * 3;

    // `aiMemory` is the only place a summoner's lifetime budget can live: the
    // entity itself is recreated for each battle, while the memory record is
    // keyed by uid and persists for the battle's duration.
    const memory = this.aiMemory.get(summoner.uid) || { turns: 0, scriptIndex: 0, fired: new Set() };
    memory.summonedTotal = memory.summonedTotal || 0;
    this.aiMemory.set(summoner.uid, memory);

    // Count *living* adds of this type. Previously this compared `e.id` against
    // an id built with `_buildEnemies`, but `_buildEnemies` names entities
    // `${def.id}_${index}` while `def.id` is the plain id — so the equality test
    // never matched and the concurrent cap silently never fired.
    const livingAdds = this.enemies.filter((e) => e.summonedBy === summoner.uid && e.alive);
    const roomConcurrent = Math.max(0, cap - livingAdds.length);
    const roomLifetime = Math.max(0, totalCap - memory.summonedTotal);
    const toSpawn = Math.min(count, roomConcurrent, roomLifetime);

    if (toSpawn === 0) {
      this.log.push(EVENTS.WARNING, {
        message: `${summoner.name} 无法再召唤更多单位了（场上 ${livingAdds.length}/${cap}，累计 ${memory.summonedTotal}/${totalCap}）`,
        uid: summoner.uid,
      });
      return [];
    }

    const spawned = [];
    const baseCount = this.enemies.length;
    // Build all adds in one pass so their `slot` indices stay contiguous.
    const specs = [];
    for (let i = 0; i < toSpawn; i++) specs.push({ id: enemyId, summonedBy: summoner.uid });
    this._buildEnemies(specs, baseCount);

    for (let i = 0; i < toSpawn; i++) {
      const unit = this.enemies[baseCount + i];
      // New adds start part-way up the gauge so they don't act instantly.
      unit.actionValue = Math.round(BALANCE.ACTION_VALUE * 0.4);
      // Weaknesses follow the summoner's *current* phase so the player can
      // still break the adds with the same party they brought.
      if (summoner.def && summoner.def.phases) {
        const phase = summoner.def.phases.find((p) => p.phase === summoner.phase);
        if (phase && phase.weaknesses) unit.weaknesses = phase.weaknesses.slice();
      }
      spawned.push(unit);
      this.log.push(EVENTS.UNIT_SUMMONED, {
        uid: unit.uid, name: unit.name, byId: summoner.uid, hp: unit.hp,
        weaknesses: unit.weaknesses, total: memory.summonedTotal + i + 1, totalCap,
      });
    }
    memory.summonedTotal += toSpawn;
    return spawned;
  }

  /** Remove every add a summoner created (called on phase change). */
  clearSummons(summonerUid) {
    const removed = [];
    for (const enemy of this.enemies) {
      if (enemy.summonedBy === summonerUid && enemy.alive) {
        enemy.hp = 0;
        enemy.down = true;
        enemy.statuses = [];
        removed.push(enemy.uid);
        this.log.push(EVENTS.UNIT_DOWN, { uid: enemy.uid, name: enemy.name, side: 'enemy', killerId: summonerUid, cause: 'cleared' });
      }
    }
    return removed;
  }

  // =========================================================================
  // Order preview — what the HUD's timeline shows
  // =========================================================================

  /**
   * Project the next `count` turns without mutating anything.
   *
   * This runs a *copy* of the gauge forward. It deliberately ignores skills,
   * deaths and delays (those depend on future decisions) — the timeline is a
   * "if nobody interferes" forecast, which is exactly what the player needs to
   * plan a break. The HUD marks the forecast as approximate for this reason.
   */
  previewOrder(count = BALANCE.TIMELINE_PREVIEW) {
    const snapshot = this.living.map((u) => ({ uid: u.uid, value: u.actionValue, spd: u.resolveStats().spd, side: u.side, name: u.name, id: u.id, broken: u.broken }));
    const order = [];
    let ticks = 0;
    while (order.length < count && ticks < 200000) {
      // Find the unit(s) reaching the threshold first.
      let earliest = Infinity;
      for (const s of snapshot) {
        const need = Math.max(0, BALANCE.ACTION_VALUE - s.value);
        const steps = s.spd > 0 ? Math.ceil(need / s.spd) : Infinity;
        if (steps < earliest) earliest = steps;
      }
      if (!isFinite(earliest)) break;
      ticks += earliest;
      for (const s of snapshot) s.value += s.spd * earliest;

      const ready = snapshot
        .filter((s) => s.value >= BALANCE.ACTION_VALUE)
        .sort((a, b) => (b.value - a.value) || (b.spd - a.spd) || (a.side === 'ally' ? -1 : 1));
      for (const s of ready) {
        order.push({ uid: s.uid, name: s.name, side: s.side, id: s.id, tick: ticks, broken: s.broken });
        s.value = 0;
        if (order.length >= count) break;
      }
    }
    return order;
  }

  // =========================================================================
  // Ending
  // =========================================================================

  /**
   * Close the battle. Computes rewards, restores a little HP, and marks the
   * phase so the API stops accepting commands.
   */
  endBattle(phase, reason) {
    if (this.phase === PHASE.WON || this.phase === PHASE.LOST || this.phase === PHASE.FLED) return;
    this.phase = phase;

    let exp = 0;
    let gold = 0;
    if (phase === PHASE.WON) {
      for (const enemy of this.enemies) {
        exp += (enemy.rewards && enemy.rewards.exp) || 0;
        gold += (enemy.rewards && enemy.rewards.gold) || 0;
      }
      // Survivors get a small top-up so a won fight is not a Pyrrhic one.
      for (const ally of this.livingAllies) {
        const stats = ally.resolveStats();
        ally.applyHeal(Math.round(stats.maxHp * BALANCE.POST_BATTLE_HEAL_RATIO), stats);
      }
    }
    this.rewards = { exp, gold, drops: [] };

    const result = {
      phase,
      reason: reason || null,
      rounds: this.round,
      ticks: this.tick,
      seed: this.seed,
      exp,
      gold,
      skillPoints: this.skillPoints,
      allies: this.allies.map((a) => ({
        uid: a.uid, id: a.id, name: a.name, alive: a.alive, hp: a.hp,
        maxHp: a.resolveStats().maxHp, energy: a.energy, level: a.level,
        stats: { ...a.stats },
        mvp: false,
      })),
      enemies: this.enemies.map((e) => ({
        uid: e.uid, id: e.id, name: e.name, alive: e.alive, hp: e.hp, hpRatio: e.hp / (e.resolveStats().maxHp || 1),
        stats: { ...e.stats },
      })),
    };

    // MVP: most damage dealt, ties broken by breaks.
    if (result.allies.length) {
      const best = result.allies.slice().sort((a, b) =>
        (b.stats.damageDealt - a.stats.damageDealt) || (b.stats.breaks - a.stats.breaks))[0];
      best.mvp = true;
    }

    this.log.push(EVENTS.BATTLE_END, result);
    this.result = result;
    return result;
  }

  // =========================================================================
  // Views
  // =========================================================================

  /**
   * The complete client-facing state. The UI is a pure function of this object
   * plus the event stream, which is what keeps the browser layer dumb.
   */
  toView() {
    return {
      name: this.name,
      phase: this.phase,
      round: this.round,
      tick: this.tick,
      seed: this.seed,
      isBoss: this.isBoss,
      isElite: this.isElite,
      canFlee: this.canFlee,
      skillPoints: this.skillPoints,
      maxSkillPoints: this.maxSkillPoints,
      allies: this.allies.map((a) => this.unitView(a, true)),
      enemies: this.enemies.map((e) => this.unitView(e, false)),
      order: this.previewOrder(),
      pendingUltimates: this.pendingUltimates.map((p) => p.unitUid),
      rewards: this.rewards,
      result: this.result || null,
    };
  }

  /** Per-unit view. Allies get skill and equipment info; enemies are opaque. */
  unitView(unit, isAlly) {
    const view = unit.toView();
    if (isAlly) {
      view.skills = unit.skills.map((id) => {
        const s = getSkill(id);
        return {
          id: s.id, name: s.name, icon: s.icon, kind: s.kind, element: s.element,
          desc: s.desc, cost: s.skillPointCost, target: s.target,
          usable: this.phase === PHASE.ACTIVE && unit.alive && !unit.isBlocked(s.kind),
          affordable: s.kind !== 'skill' || this.skillPoints >= s.skillPointCost,
          charged: s.kind !== 'ultimate' || unit.ultimateReady,
        };
      });
      view.canAct = this.phase === PHASE.ACTIVE && unit.alive;
    }
    return view;
  }

  /** Flat snapshot for save files and the self-test. */
  snapshot() {
    return {
      seed: this.seed,
      phase: this.phase,
      round: this.round,
      tick: this.tick,
      skillPoints: this.skillPoints,
      allies: this.allies.map((a) => ({ uid: a.uid, id: a.id, hp: a.hp, energy: a.energy, actionValue: a.actionValue, down: a.down, broken: a.broken, statuses: a.statuses.map((s) => ({ ...s })) })),
      enemies: this.enemies.map((e) => ({ uid: e.uid, id: e.id, hp: e.hp, actionValue: e.actionValue, down: e.down, broken: e.broken, toughness: e.toughness, phase: e.phase, statuses: e.statuses.map((s) => ({ ...s })) })),
      rngDraws: this.rng.draws,
      events: this.log.entries.length,
    };
  }
}

/** Default energy gains per action kind, used when a skill does not override. */
function defaultEnergy(kind) {
  switch (kind) {
    case 'basic': return BALANCE.ENERGY_BASIC * 100;
    case 'skill': return BALANCE.ENERGY_SKILL * 100;
    case 'defend': return 10;
    case 'ultimate': return 0;
    default: return 0;
  }
}

module.exports = { Battle, PHASE, ACTION, defaultEnergy, isTerminal };
