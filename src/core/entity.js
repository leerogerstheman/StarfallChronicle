'use strict';

/**
 * Entities: everything that can stand on the battlefield.
 *
 * One class serves allies and enemies. The differences that matter are:
 *   - `side` ('ally' | 'enemy') decides targeting legality;
 *   - allies have `skills` chosen by a player while enemies have `ai`;
 *   - enemies have `toughness` (the weakness-break bar) and `weaknesses`.
 *
 * Design decision worth recording: stats are stored as *components*
 * (`baseStats` from the character sheet, `levelStats` from growth, `gearStats`
 * from equipment) and only ever combined through `resolveStats()`. Statuses can
 * then modify the result without ever writing back into the components. The
 * alternative — mutating `atk` directly when a buff lands — is the classic
 * source of "buff expired but the number stayed" bugs, and it makes saves
 * impossible to trust.
 */

const { BALANCE, DERIVED_STATS } = require('./rules');
const { getStatus, STATUS_CATEGORY } = require('./status');

/** Every stat has a neutral default so a sparse character sheet still works. */
const STAT_DEFAULTS = {
  maxHp: 1,
  atk: 1,
  def: 0,
  spd: 100,
  break: 1,
  critRate: 0.05,
  critDmg: 1.5,
  effectHit: 0,
  effectRes: 0,
  maxEnergy: 100,
};

let nextEntitySerial = 1;

/**
 * Reset the id counter.
 *
 * Exposed because a module-level counter makes `uid` values depend on how many
 * entities *any* previous battle created, which breaks two things that matter:
 * seeded replay comparison (two identical battles produced different uids), and
 * any future server that runs several battles in one process and wants stable
 * ids. `Battle` therefore resets this at construction — uids are only ever
 * unique *within* a battle, which is the only scope anything reads them in.
 */
function resetEntitySerial() {
  nextEntitySerial = 1;
}

class Entity {
  /**
   * @param {object} spec
   * @param {string} spec.id          stable id, unique within a battle
   * @param {string} spec.name
   * @param {'ally'|'enemy'} spec.side
   * @param {object} spec.baseStats   level-1-ish base values
   * @param {number} [spec.level]
   * @param {string[]} [spec.weaknesses] element ids the enemy is weak to
   * @param {number} [spec.toughness] max toughness bar (enemies only)
   * @param {object} [spec.resist]    { fire: 0.5, ice: 0 } multipliers
   * @param {object} [spec.ai]        AI descriptor (enemies only)
   * @param {string[]} [spec.skills]  skill ids
   * @param {string} [spec.sprite]
   * @param {string} [spec.title]
   */
  constructor(spec) {
    this.uid = `${spec.id}#${nextEntitySerial++}`;
    this.id = spec.id;
    this.name = spec.name;
    this.title = spec.title || '';
    this.side = spec.side;
    this.level = spec.level || 1;

    this.baseStats = { ...STAT_DEFAULTS, ...(spec.baseStats || {}) };
    this.gearStats = spec.gearStats ? { ...spec.gearStats } : {};
    /** Flat/percent additions granted by talents or boss phases. */
    this.traitStats = spec.traitStats ? { ...spec.traitStats } : {};

    this.weaknesses = spec.weaknesses ? spec.weaknesses.slice() : [];
    this.resist = spec.resist ? { ...spec.resist } : {};
    this.toughnessMax = spec.toughness || 0;
    this.breakDamageMult = spec.breakDamageMult || BALANCE.BREAK_DAMAGE_MULT;

    this.skills = spec.skills ? spec.skills.slice() : [];
    this.ai = spec.ai || null;
    this.sprite = spec.sprite || '';
    this.color = spec.color || null;
    this.scale = spec.scale || 1;

    /** Status instances. Never touched directly outside `applyStatus`. */
    this.statuses = [];
    /** Action gauge position; 0..ACTION_VALUE, acts at ACTION_VALUE. */
    this.actionValue = 0;
    /** True once the unit has been defeated; bodies stay until battle end. */
    this.down = false;
    /** Set while a break's stun-window is active. */
    this.broken = false;
    /** Boss phases, scripted encounters. */
    this.phase = 1;
    /** Set by `summon` so a boss can clean up adds. */
    this.summonedBy = spec.summonedBy || null;
    /** Extra turns queued by talents (e.g. Seele-style resets). */
    this.extraTurns = 0;
    /** Whether this unit has acted since its last `TURN_START`. */
    this.hasActedThisTurn = false;

    // --- Resources ---
    const maxEnergy = this.baseStats.maxEnergy;
    this.energy = Math.min(spec.energy != null ? spec.energy : 0, maxEnergy);
    this.maxHp = this.baseStats.maxHp;
    this.hp = spec.hp != null ? spec.hp : this.maxHp;
    this.toughness = this.toughnessMax;

    /** Per-battle counters surfaced in the result screen. */
    this.stats = {
      damageDealt: 0,
      damageTaken: 0,
      healingDone: 0,
      breaks: 0,
      kills: 0,
      turnsTaken: 0,
      crits: 0,
    };
  }

  get alive() {
    return !this.down && this.hp > 0;
  }

  get isEnemy() {
    return this.side === 'enemy';
  }

  get isAlly() {
    return this.side === 'ally';
  }

  /**
   * Resolve the effective stats for this moment.
   *
   * Order of operations, which matters and is therefore documented:
   *   1. base + level growth + gear (all flat additions)
   *   2. + trait flat additions
   *   3. + status flat additions
   *   4. * (1 + sum of percent modifiers), where percents are *summed* then
   *      applied once. Summing rather than compounding means two +25% ATK
   *      buffs give +50%, not +56.25% — predictable, and it keeps stacking
   *      from running away in a long boss fight.
   *   5. clamp to sane ranges
   *
   * Cached per (statusCount, level, gearVersion) is deliberately *not* done:
   * battles are small (max ~12 units) and a stale cache here would be a
   * correctness bug that only shows up under load.
   */
  resolveStats() {
    const out = {};
    const flat = {};
    const pct = {};

    // 1. base with level growth
    const growth = BALANCE.GROWTH;
    const lv = Math.max(0, this.level - 1);
    for (const key of DERIVED_STATS) {
      const base = this.baseStats[key] != null ? this.baseStats[key] : STAT_DEFAULTS[key] || 0;
      let value = base;
      if (growth[key] && key !== 'maxEnergy') {
        value = base * (1 + growth[key] * lv);
      }
      out[key] = value;
    }

    // 2. gear + traits
    for (const source of [this.gearStats, this.traitStats]) {
      for (const key of Object.keys(source)) {
        if (key.endsWith('Pct')) {
          const stat = key.slice(0, -3);
          pct[stat] = (pct[stat] || 0) + source[key];
        } else {
          flat[key] = (flat[key] || 0) + source[key];
        }
      }
    }

    // 3. statuses
    for (const inst of this.statuses) {
      const def = getStatus(inst.id);
      if (!def.statMods) continue;
      const magnitude = this.statusMagnitude(def, inst);
      for (const key of Object.keys(def.statMods)) {
        const raw = def.statMods[key] * magnitude;
        if (key.endsWith('Pct')) {
          const stat = key.slice(0, -3);
          pct[stat] = (pct[stat] || 0) + raw;
        } else {
          flat[key] = (flat[key] || 0) + raw;
        }
      }
    }

    // 4. apply flat then percent
    for (const key of Object.keys(flat)) {
      if (out[key] == null) out[key] = 0;
      out[key] += flat[key];
    }
    for (const key of Object.keys(pct)) {
      if (out[key] == null) out[key] = 0;
      out[key] *= 1 + pct[key];
    }

    // 5. clamps
    out.maxHp = Math.max(1, Math.round(out.maxHp));
    out.atk = Math.max(0, out.atk);
    out.def = Math.max(0, out.def);
    out.spd = Math.max(1, out.spd);
    out.critRate = clamp(out.critRate, 0, 1);
    out.critDmg = Math.max(1, out.critDmg);
    out.effectHit = clamp(out.effectHit, 0, 1.5);
    out.effectRes = clamp(out.effectRes, 0, 0.9);
    out.break = Math.max(0.1, out.break);
    out.maxEnergy = Math.max(1, out.maxEnergy);
    return out;
  }

  /**
   * How strongly a status instance applies, given its stacks.
   * `refresh` and `strongest` modes always use magnitude 1.
   */
  statusMagnitude(def, inst) {
    if (def.stackMode === 'stack') return Math.max(1, inst.stacks || 1);
    return 1;
  }

  /** Find a live status instance by id. */
  findStatus(id) {
    return this.statuses.find((s) => s.id === id);
  }

  /** All status definitions currently on this unit. */
  statusDefs() {
    return this.statuses.map((s) => ({ def: getStatus(s.id), inst: s }));
  }

  /** Total shield HP across all shield instances. */
  shieldPool() {
    return this.statuses
      .filter((s) => getStatus(s.id).shield)
      .reduce((sum, s) => sum + (s.value || 0), 0);
  }

  /** Consume shield HP, removing depleted instances. Returns amount absorbed. */
  absorbWithShield(amount) {
    let remaining = amount;
    for (const inst of this.statuses) {
      if (remaining <= 0) break;
      const def = getStatus(inst.id);
      if (!def.shield) continue;
      const absorbed = Math.min(inst.value || 0, remaining);
      inst.value -= absorbed;
      remaining -= absorbed;
    }
    this.statuses = this.statuses.filter((s) => !getStatus(s.id).shield || (s.value || 0) > 0);
    return amount - remaining;
  }

  /** True if any status blocks the given action kind. */
  isBlocked(kind) {
    for (const inst of this.statuses) {
      const def = getStatus(inst.id);
      if (def.skipsTurn) return 'skip';
      if (kind === 'skill' && def.blocksSkill) return 'skill';
      if (kind === 'ultimate' && def.blocksUltimate) return 'ultimate';
    }
    return null;
  }

  /** Aggregated outgoing-damage modifier from statuses. */
  outgoingDamageMult(target) {
    let mult = 1;
    for (const inst of this.statuses) {
      const def = getStatus(inst.id);
      if (def.damageDealtPct) mult += def.damageDealtPct * this.statusMagnitude(def, inst);
      if (def.vsBrokenDamagePct && target && target.broken) {
        mult += def.vsBrokenDamagePct * this.statusMagnitude(def, inst);
      }
    }
    return mult;
  }

  /** Aggregated incoming-damage modifier from statuses. */
  incomingDamageMult() {
    let mult = 1;
    for (const inst of this.statuses) {
      const def = getStatus(inst.id);
      if (def.damageTakenPct) mult += def.damageTakenPct * this.statusMagnitude(def, inst);
    }
    return mult;
  }

  /** Multiplier applied to toughness damage this unit receives. */
  toughnessTakenMult() {
    let mult = 1;
    for (const inst of this.statuses) {
      const def = getStatus(inst.id);
      if (def.toughnessTakenMult) mult *= def.toughnessTakenMult;
    }
    return mult;
  }

  /** Energy, clamped to the resolved maximum. */
  gainEnergy(amount, stats) {
    const max = (stats && stats.maxEnergy) || this.resolveStats().maxEnergy;
    const before = this.energy;
    this.energy = clamp(this.energy + amount, 0, max);
    return this.energy - before;
  }

  get ultimateReady() {
    return this.energy >= this.resolveStats().maxEnergy;
  }

  /**
   * Apply raw damage to HP, honouring shields, `surviveLethal`, `reflect` and
   * `autoRevive`. Returns a structured result the caller turns into events —
   * this method itself stays silent so the damage pipeline can log once, in
   * order, from a single place.
   */
  applyDamage(amount) {
    const result = { hpLost: 0, shieldAbsorbed: 0, lethal: false, survivedLethal: false, revived: false };

    let incoming = Math.max(0, Math.round(amount));
    if (incoming <= 0) return result;

    const absorbed = this.absorbWithShield(incoming);
    result.shieldAbsorbed = absorbed;
    incoming -= absorbed;
    if (incoming <= 0) return result;

    if (this.hp - incoming <= 0) {
      const undying = this.findStatus('undying');
      if (undying) {
        result.survivedLethal = true;
        incoming = this.hp - 1;
      } else {
        const revive = this.findStatus('revive_ready');
        if (revive) {
          result.revived = true;
          const stats = this.resolveStats();
          const pct = getStatus('revive_ready').autoRevivePct;
          this.removeStatus('revive_ready');
          this.hp = Math.max(1, Math.round(stats.maxHp * pct));
          this.down = false;
          result.hpLost += Math.max(0, incoming);
          return result;
        }
        result.lethal = true;
        incoming = this.hp;
      }
    }

    this.hp = Math.max(0, this.hp - incoming);
    result.hpLost += incoming;
    if (this.hp <= 0) {
      this.down = true;
      this.broken = false;
      this.statuses = [];
    }
    return result;
  }

  /** Heal, clamped at max HP. Returns HP actually restored. */
  applyHeal(amount, stats) {
    const max = (stats && stats.maxHp) || this.resolveStats().maxHp;
    const before = this.hp;
    this.hp = clamp(this.hp + Math.round(amount), 0, max);
    return this.hp - before;
  }

  removeStatus(id) {
    const before = this.statuses.length;
    this.statuses = this.statuses.filter((s) => s.id !== id);
    return this.statuses.length !== before;
  }

  /** Remove every status matching a predicate; returns the removed ids. */
  removeStatusesWhere(predicate) {
    const removed = [];
    this.statuses = this.statuses.filter((inst) => {
      const def = getStatus(inst.id);
      if (predicate(def, inst)) {
        removed.push(inst.id);
        return false;
      }
      return true;
    });
    return removed;
  }

  /** Remove all debuffs and DoTs (the classic "cleanse"). */
  cleanse() {
    return this.removeStatusesWhere((def) =>
      def.kind === STATUS_CATEGORY.DEBUFF || def.kind === STATUS_CATEGORY.DOT || def.kind === STATUS_CATEGORY.CONTROL);
  }

  /** Remove all buffs (used by "dispel" enemy skills). */
  dispel() {
    return this.removeStatusesWhere((def) => def.kind === STATUS_CATEGORY.BUFF || def.kind === STATUS_CATEGORY.SPECIAL);
  }

  /** Snapshot for the client; never exposes internal class identity. */
  toView(includeHidden = false) {
    const stats = this.resolveStats();
    return {
      uid: this.uid,
      id: this.id,
      name: this.name,
      title: this.title,
      side: this.side,
      level: this.level,
      hp: this.hp,
      maxHp: stats.maxHp,
      hpRatio: stats.maxHp > 0 ? this.hp / stats.maxHp : 0,
      shield: this.shieldPool(),
      energy: this.energy,
      maxEnergy: stats.maxEnergy,
      ultimateReady: this.ultimateReady,
      alive: this.alive,
      down: this.down,
      broken: this.broken,
      toughness: this.toughness,
      toughnessMax: this.toughnessMax,
      toughnessRatio: this.toughnessMax > 0 ? this.toughness / this.toughnessMax : 1,
      weaknesses: this.weaknesses,
      statuses: this.statuses.map((inst) => {
        const def = getStatus(inst.id);
        return {
          id: inst.id,
          name: def.name,
          icon: def.icon,
          kind: def.kind,
          stacks: inst.stacks || 1,
          remaining: inst.remaining,
          desc: def.desc,
          element: def.element || null,
          // Buffs and debuffs are shown to everyone; a couple of boss-specific
          // markers stay hidden so the player has to infer them.
          hidden: includeHidden ? false : !!def.hiddenFromPlayer,
        };
      }),
      sprite: this.sprite,
      color: this.color,
      scale: this.scale,
      phase: this.phase,
      skillPoints: undefined,
    };
  }
}

/** Copy a status onto an entity without running hooks (used by phase changes). */
function cloneStatusInstance(inst) {
  return { ...inst };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

module.exports = { Entity, STAT_DEFAULTS, resetEntitySerial, clamp, cloneStatusInstance };
