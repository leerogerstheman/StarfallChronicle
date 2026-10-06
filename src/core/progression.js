'use strict';

/**
 * Progression: levels, EXP, gear, and the save-file shape.
 *
 * Design rule that shapes everything here: a character's *durable* state is a
 * tiny record (level, exp, equipped item ids, unlocked talents). Every stat is
 * recomputed from the character definition on load. That means rebalancing a
 * character in `characters.js` retroactively fixes every existing save, which is
 * exactly the behaviour you want during development and is why there are no
 * stat snapshots in the save file.
 */

const { BALANCE } = require('./rules');
const { getCharacter, getEquipment, DEFAULT_LOADOUT } = require('./characters');

/**
 * EXP required to go from `level` to `level + 1`.
 * Superlinear (power 1.55) so later levels feel earned but never grindy.
 */
function expToNext(level) {
  if (level >= BALANCE.MAX_LEVEL) return Infinity;
  return Math.round(BALANCE.EXP_CURVE_BASE * Math.pow(level, BALANCE.EXP_CURVE_POW));
}

/** Cumulative EXP needed to reach a level from level 1. */
function totalExpFor(level) {
  let sum = 0;
  for (let l = 1; l < level; l++) sum += expToNext(l);
  return sum;
}

/**
 * A party member's durable state.
 *
 * Kept as a plain object (not a class) so it round-trips through JSON with no
 * custom serialiser. `toJSON`/`fromJSON` are trivial by construction.
 */
function createMember(charId, options = {}) {
  const def = getCharacter(charId);
  const loadout = DEFAULT_LOADOUT[charId] || {};
  return {
    charId,
    level: options.level || 1,
    exp: options.exp || 0,
    equipment: {
      weapon: options.equipment?.weapon ?? loadout.weapon ?? null,
      boots: options.equipment?.boots ?? loadout.boots ?? null,
      accessory: options.equipment?.accessory ?? loadout.accessory ?? null,
    },
    /** Talent ids the player has unlocked; the base talent is granted at 1. */
    unlocked: options.unlocked ? options.unlocked.slice() : ['talent'],
    /** Max HP carried between battles, so healing matters. */
    hp: options.hp != null ? options.hp : null,
    /** Energy carried between battles, capped by CARRYOVER_ENERGY_RATIO. */
    energy: options.energy != null ? options.energy : 0,
    /** Cosmetic: which element the player last used, for the codex. */
    seen: !!options.seen,
    name: def.name,
  };
}

/**
 * Fold a character definition plus member state into a flat "sheet".
 * This is the single source of truth for stats; both the battle builder and the
 * menu screens read it, so the menu can never disagree with the fight.
 */
function buildSheet(member) {
  const def = getCharacter(member.charId);
  const gearStats = {};
  for (const slot of ['weapon', 'boots', 'accessory']) {
    const id = member.equipment[slot];
    if (!id) continue;
    const item = getEquipment(id);
    if (!item) continue;
    for (const key of Object.keys(item)) {
      if (['id', 'name', 'slot', 'rarity', 'desc'].includes(key)) continue;
      gearStats[key] = (gearStats[key] || 0) + item[key];
    }
  }
  return {
    charId: member.charId,
    name: def.name,
    en: def.en,
    title: def.title,
    element: def.element,
    role: def.role,
    rarity: def.rarity,
    color: def.color,
    sprite: def.sprite,
    lore: def.lore,
    level: member.level,
    exp: member.exp,
    expToNext: expToNext(member.level),
    expProgress: progress(member),
    baseStats: def.baseStats,
    gearStats,
    skills: def.skills,
    hooks: def.hooks || [],
    /** Declarative follow-up attacks, read by `Battle._triggerFollowups`. */
    followups: def.followups || [],
    equipment: { ...member.equipment },
    unlocked: member.unlocked.slice(),
    hp: member.hp,
    energy: member.energy,
    /** Populated by `previewStats`; the caller usually wants it. */
    stats: previewStats(member),
  };
}

/** Fraction of the way to the next level, for the EXP bar. */
function progress(member) {
  const need = expToNext(member.level);
  if (!isFinite(need)) return 1;
  return Math.max(0, Math.min(1, member.exp / need));
}

/**
 * Compute resolved stats without instantiating an Entity.
 *
 * This duplicates a little logic from `Entity.resolveStats` on purpose: the menu
 * must be able to show stats for a character who is not in a battle, and
 * creating an Entity just to read a number caused a class of "which entity is
 * this" bugs in an earlier version. The two implementations share the same
 * formula and `test/run-all.js` asserts they agree.
 */
function previewStats(member) {
  const def = getCharacter(member.charId);
  const lv = Math.max(0, member.level - 1);
  const growth = BALANCE.GROWTH;
  const out = {};
  const flat = {};
  const pct = {};

  for (const key of Object.keys(def.baseStats)) {
    const base = def.baseStats[key];
    out[key] = growth[key] ? base * (1 + growth[key] * lv) : base;
  }

  for (const slot of ['weapon', 'boots', 'accessory']) {
    const id = member.equipment[slot];
    if (!id) continue;
    const item = getEquipment(id);
    if (!item) continue;
    for (const key of Object.keys(item)) {
      if (['id', 'name', 'slot', 'rarity', 'desc'].includes(key)) continue;
      if (key.endsWith('Pct')) {
        const stat = key.slice(0, -3);
        pct[stat] = (pct[stat] || 0) + item[key];
      } else {
        flat[key] = (flat[key] || 0) + item[key];
      }
    }
  }

  for (const key of Object.keys(flat)) {
    out[key] = (out[key] || 0) + flat[key];
  }
  for (const key of Object.keys(pct)) {
    out[key] = (out[key] || 0) * (1 + pct[key]);
  }

  out.maxHp = Math.round(Math.max(1, out.maxHp || 0));
  out.atk = Math.max(0, out.atk || 0);
  out.def = Math.max(0, out.def || 0);
  out.spd = Math.max(1, out.spd || 0);
  out.critRate = Math.min(1, Math.max(0, out.critRate || 0));
  out.critDmg = Math.max(1, out.critDmg || 1.5);
  out.effectHit = Math.min(1.5, Math.max(0, out.effectHit || 0));
  out.effectRes = Math.min(0.9, Math.max(0, out.effectRes || 0));
  out.break = Math.max(0.1, out.break != null ? out.break : 1);
  out.maxEnergy = Math.max(1, out.maxEnergy || 100);
  return out;
}

/**
 * Grant EXP and apply every level-up that results.
 * Returns the level-up records so the UI can show the classic stat-gain card.
 */
function grantExp(member, amount) {
  const levels = [];
  if (member.level >= BALANCE.MAX_LEVEL) {
    return { member, levels, expGained: 0 };
  }
  member.exp += amount;
  let guard = 0;
  while (member.level < BALANCE.MAX_LEVEL && member.exp >= expToNext(member.level) && guard++ < 200) {
    const before = previewStats(member);
    member.exp -= expToNext(member.level);
    member.level += 1;
    const after = previewStats(member);
    levels.push({
      level: member.level,
      deltas: {
        maxHp: after.maxHp - before.maxHp,
        atk: Math.round((after.atk - before.atk) * 10) / 10,
        def: Math.round((after.def - before.def) * 10) / 10,
        spd: Math.round((after.spd - before.spd) * 10) / 10,
      },
      /** Newly available skills, if the character's unlock table has an entry. */
      unlocked: unlockAt(member, member.level),
    });
  }
  if (member.level >= BALANCE.MAX_LEVEL) member.exp = 0;
  return { member, levels, expGained: amount };
}

/** Skill ids unlocked exactly at `level` for this member's character. */
function unlockAt(member, level) {
  const def = getCharacter(member.charId);
  const list = (def.unlock && def.unlock[level]) || [];
  const fresh = [];
  for (const skillId of list) {
    if (!member.unlocked.includes(skillId)) {
      member.unlocked.push(skillId);
      fresh.push(skillId);
    }
  }
  return fresh;
}

/** Whether a member may use a skill id (talents gated by unlock table). */
function canUseSkill(member, skillId, skillDef) {
  if (!skillDef) return false;
  if (skillDef.kind === 'talent') {
    const def = getCharacter(member.charId);
    const granted = Object.values(def.skills).includes(skillId);
    if (!granted) return false;
    return member.unlocked.includes('talent');
  }
  return true;
}

/** Swap gear, returning the previously equipped item id so a shop can refund. */
function equip(member, itemId) {
  const item = getEquipment(itemId);
  if (!item) throw new Error(`Unknown equipment id: ${itemId}`);
  const slot = item.slot || 'accessory';
  const previous = member.equipment[slot] || null;
  member.equipment[slot] = itemId;
  return previous;
}

/** Aggregate a party's total power, used only for the "recommended level" hint. */
function partyPower(members) {
  let power = 0;
  for (const m of members) {
    const s = previewStats(m);
    power += s.atk * 1.0 + s.maxHp * 0.12 + s.def * 0.6 + s.spd * 2.5;
  }
  return Math.round(power);
}

/** The level the party "effectively" is, for gate checks and recommendations. */
function averageLevel(members) {
  if (!members.length) return 1;
  return Math.round(members.reduce((s, m) => s + m.level, 0) / members.length);
}

module.exports = {
  expToNext,
  totalExpFor,
  createMember,
  buildSheet,
  previewStats,
  grantExp,
  unlockAt,
  canUseSkill,
  equip,
  partyPower,
  averageLevel,
  progress,
};
